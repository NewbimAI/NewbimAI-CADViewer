/**
 * 图纸比对面板（右侧信息面板的第四个 tab）。
 *
 * 交互骨架：
 *   1. 选基准图 / 对比图（打开的 tab、最近打开、或现挑一个文件 → POST /api/open）；
 *   2. 设容差与参与比对的属性 → POST /api/compare；
 *   3. 看统计 + 警告 + 分组变更列表；点行高亮、点定位把视图框到该变更。
 *
 * 状态都在 App（和 sessions 放一起）：换 tab 不丢结果，关掉任一张被比对的图纸才清空。
 * 这里只负责呈现与输入。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import {
  ArrowUpDown,
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Columns2,
  FileDown,
  FilterX,
  FolderOpen,
  Loader2,
  LocateFixed,
  PanelRightClose,
  Play,
  TriangleAlert,
  X,
} from "lucide-react";

import CompareSelect from "@/components/CompareSelect";
import DockTooltip from "@/components/DockTooltip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { CHANGE_COLORS, MAX_OVERLAY_CHANGES } from "@/components/ChangeOverlay";
import { fetchRecent } from "@/api";
import type { CompareReportProgress } from "@/lib/compareReport";
import { cn, formatNumber } from "@/lib/utils";
import type {
  CompareBBox,
  CompareChange,
  CompareChangeSet,
  CompareKind,
  ComparePropKey,
  CompareResult,
  CompareWarning,
  OpenResult,
  RecentFile,
} from "@/types";

/* ------------------------------------------------------------------ */
/* ---- App 共享的 UI 状态 --------------------------------------------- */
/* ------------------------------------------------------------------ */

export interface CompareOptionsUi {
  /** 图纸单位。小于它的端点距离视为同一位置（契约 §3 tolerance）。 */
  tolerance: number;
  compareProps: ComparePropKey[];
  includeHatch: boolean;
}

export interface CompareUiState {
  baseId: string | null;
  targetId: string | null;
  result: CompareResult | null;
  running: boolean;
  error: string | null;
  /** 上一次成功比对的耗时（ms，服务端 summary.elapsedMs 是纯引擎时间）。 */
  elapsedMs: number;
  /** 本轮开始的 Date.now()；running 时有值，用来显示"已等了几秒"。 */
  startedAt: number | null;
  options: CompareOptionsUi;
}

export type CompareKindFilter = CompareKind | "all";

export interface CompareFilter {
  kind: CompareKindFilter;
  /** DXF 类型（LINE/ARC/…）；null = 全部 */
  type: string | null;
}

export interface CompareTabItem {
  id: string;
  name: string;
  format: string;
}

export const EMPTY_COMPARE: CompareUiState = {
  baseId: null,
  targetId: null,
  result: null,
  running: false,
  error: null,
  elapsedMs: 0,
  startedAt: null,
  options: {
    tolerance: 0.001,
    compareProps: ["color", "linetype"],
    includeHatch: false,
  },
};

export const EMPTY_COMPARE_FILTER: CompareFilter = { kind: "all", type: null };

/* ------------------------------------------------------------------ */

const PROP_OPTIONS: { key: ComparePropKey; label: string; title: string }[] = [
  { key: "color", label: "颜色", title: "AUTO / BYLAYER 按落色后的实际颜色比较" },
  { key: "layer", label: "图层", title: "同几何但换了图层 → 记为修改" },
  { key: "linetype", label: "线型", title: "实线 / 虚线 / 点划线等" },
  { key: "lineweight", label: "线宽", title: "实体线宽（不是显示宽度）" },
];

/** 折叠状态下用一句话交代当前选项 */
const PROP_LABELS: Record<ComparePropKey, string> = {
  color: "颜色",
  layer: "图层",
  linetype: "线型",
  lineweight: "线宽",
};

const KIND_META: {
  key: CompareKind;
  label: string;
  dot: string;
}[] = [
  { key: "added", label: "新增", dot: CHANGE_COLORS.added },
  { key: "removed", label: "删除", dot: CHANGE_COLORS.removed },
  { key: "modified", label: "修改", dot: CHANGE_COLORS.modified },
];

/** 每屏最多渲染多少行；超出的靠"显示更多"续（几千行一次性挂 DOM 会卡顿）。 */
const ROWS_PER_PAGE = 80;
const ROWS_PER_MORE = 200;

type Props = {
  state: CompareUiState;
  /** 已按 filter 过滤后的变更（与叠加层是同一份） */
  changes: CompareChange[];
  tabs: CompareTabItem[];
  /** 面板当前是否可见：可见时刷新"最近打开"（面板是 keepMounted 的，只能靠这个信号） */
  active?: boolean;
  filter: CompareFilter;
  selectedId: number | null;
  activeSetId: number | null;
  onBaseChange: (id: string | null) => void;
  onTargetChange: (id: string | null) => void;
  onOptionsChange: (patch: Partial<CompareOptionsUi>) => void;
  onRun: () => void;
  onClear: () => void;
  onDismissError: () => void;
  onOpenFile: (file: File) => Promise<OpenResult | null>;
  onFilterChange: (f: CompareFilter) => void;
  onSelect: (id: number | null) => void;
  onLocateChange: (change: CompareChange) => void;
  onLocateSet: (setId: number) => void;
  onActivateSet: (setId: number | null) => void;
  /** 当前是否处于并排对比（两张画布左右各一）。 */
  compareView: boolean;
  /** 进入 / 退出并排对比。 */
  onToggleCompareView: () => void;
  /** 生成 Word 报告（App 负责必要时进入并排视图并拿到两侧 DxfApi）。 */
  onExportReport: (onProgress: CompareReportProgress) => Promise<void>;
  /** 当前选择与比对结果一致时才允许导出（否则截图与结果对不上）。 */
  reportAvailable: boolean;
};

export default function ComparePanel({
  state,
  changes,
  tabs,
  active = true,
  filter,
  selectedId,
  activeSetId,
  onBaseChange,
  onTargetChange,
  onOptionsChange,
  onRun,
  onClear,
  onDismissError,
  onOpenFile,
  onFilterChange,
  onSelect,
  onLocateChange,
  onLocateSet,
  onActivateSet,
  compareView,
  onToggleCompareView,
  onExportReport,
  reportAvailable,
}: Props) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [recent, setRecent] = useState<RecentFile[]>([]);
  const [, forceTick] = useState(0);
  /** 容差输入框的原始文本：输入中途（"0." / 空）不能立刻写回数字状态，否则点会消失 */
  const [tolText, setTolText] = useState(() =>
    tolTextOf(state.options.tolerance)
  );
  /** 有结果后把 容差 / 属性 折起来，把版面留给统计与变更列表 */
  const [optsOpen, setOptsOpen] = useState(false);
  /** 有结果后把「基准图 ↔ 对比图」也收成一行摘要；只有展开时才露出改选入口 */
  const [pairOpen, setPairOpen] = useState(false);
  /** Word 报告导出进度（null 表示还没开始） */
  const [reportBusy, setReportBusy] = useState(false);
  const [reportDone, setReportDone] = useState(0);
  const [reportTotal, setReportTotal] = useState(0);
  const [reportError, setReportError] = useState<string | null>(null);
  const reportTickRef = useRef(0);

  const { baseId, targetId, result, running, error, startedAt } = state;
  const sameDrawing = !!baseId && baseId === targetId;

  /** 图纸名：已打开的 tab → 最近打开 → 结果里带回的名字 */
  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of recent) m.set(r.id, r.name);
    for (const t of tabs) m.set(t.id, t.name);
    return m;
  }, [recent, tabs]);

  /**
   * 结果是否还对应现在选中的两张（与 App 的 compareMatched 同一判定）。
   * 只有它成立时才能把图纸对收起来 —— 改选后必须露出选择区。
   */
  const selectionMatched =
    !!result &&
    result.base.id === baseId &&
    result.target.id === targetId;

  /** 有结果 + 选择未变 + 不在跑 → 才允许把图纸对折成摘要 */
  const pairCollapsible = selectionMatched && !running;
  /** 是否已收起：可折 + 用户没手动展开 */
  const pairFolded = pairCollapsible && !pairOpen;

  const pairBaseName =
    (baseId ? nameById.get(baseId) : undefined) ??
    (result?.base.id === baseId ? result?.base.name : undefined) ??
    baseId ??
    "未选择";
  const pairTargetName =
    (targetId ? nameById.get(targetId) : undefined) ??
    (result?.target.id === targetId ? result?.target.name : undefined) ??
    targetId ??
    "未选择";

  // 结果换了一份（重新对比 / 清空）就回到折叠摘要：手动展开只对当前这份结果有效。
  useEffect(() => {
    setPairOpen(false);
  }, [result]);

  // 最近打开：面板可见时刷新（keepMounted 下没有"挂载"这个时机可用）。
  useEffect(() => {
    if (!active) return;
    let alive = true;
    fetchRecent()
      .then((list) => {
        if (alive) setRecent(list);
      })
      .catch(() => {
        /* 最近列表只是便利，读不到就不显示。 */
      });
    return () => {
      alive = false;
    };
  }, [active, tabs.length]);

  // 比对中每 100ms 刷一次"已等 X.Xs"（结果一出来就停）。
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => forceTick((n) => n + 1), 100);
    return () => window.clearInterval(id);
  }, [running]);

  // 外部（重新对比 / 切换图纸）改了容差时同步输入框。
  useEffect(() => {
    setTolText(tolTextOf(state.options.tolerance));
  }, [state.options.tolerance]);

  const elapsedSec =
    running && startedAt
      ? Math.max(0, (Date.now() - startedAt) / 1000)
      : Math.max(0, state.elapsedMs / 1000);

  const tabIds = useMemo(() => new Set(tabs.map((t) => t.id)), [tabs]);
  const recentOnly = useMemo(
    () => recent.filter((r) => !tabIds.has(r.id)).slice(0, 12),
    [recent, tabIds]
  );
  /** 交换只在"两张都是已打开的图纸"时可用：最近打开的文件不在基准图候选里，换过去会显示不出来 */
  const canSwap =
    !!baseId && !!targetId && tabIds.has(baseId) && tabIds.has(targetId);

  const pickFile = () => fileRef.current?.click();

  const handlePicked = async (file: File | null | undefined) => {
    if (!file) return;
    const opened = await onOpenFile(file);
    if (!opened) return;
    // 新开的图直接当对比图；基准图保持原样（新的绘制会激活那个 tab）。
    if (opened.id === baseId) onBaseChange(null);
    onTargetChange(opened.id);
  };

  /** 导出 Word 报告：真正干活的是 App（它持有两块画布、DxfApi）。 */
  const handleExportReport = async () => {
    if (!result || reportBusy || !reportAvailable || !result.changes.length) return;
    setReportBusy(true);
    setReportDone(0);
    setReportTotal(result.changes.length);
    setReportError(null);
    reportTickRef.current = 0;
    try {
      await onExportReport((done, total) => {
        // 每条都 setState 会让整个面板跟着重渲染（几千行列表时很吃亏）。
        // 250ms 一次足够让进度条动起来，最后一帧强制刷新。
        const now = performance.now();
        if (done !== total && now - reportTickRef.current < 250) return;
        reportTickRef.current = now;
        setReportDone(done);
        setReportTotal(total);
      });
    } catch (e) {
      setReportError(e instanceof Error ? e.message : String(e));
    } finally {
      setReportBusy(false);
    }
  };

  /* ---- 不足两张图：只留一句引导 + 打开按钮（整体落在上部约 1/4 处） ---- */
  if (tabs.length < 2) {
    return (
      <div className="flex h-full flex-col items-center px-6 text-center">
        {/* 顶部留白：24% 高度。百分比 flex-basis 相对面板自身高度，窗口变矮也不会挤到底部 */}
        <div aria-hidden className="w-full flex-none basis-[24%]" />
        <div className="space-y-1.5">
          <div className="text-sm font-medium">还需要再打开一张图纸</div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            比对需要两张图：一张作为基准，再打开一张即可对比。
            {tabs.length === 1
              ? `当前只有「${tabs[0].name}」。`
              : "当前还没有打开图纸。"
            }
          </p>
        </div>
        <Button className="mt-4 gap-1.5" onClick={pickFile}>
          <FolderOpen />
          打开图纸
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".dwg,.dxf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            void handlePicked(f);
            e.target.value = "";
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ---------- 选择区 / 结果摘要（可滚动，避免挤掉下面的列表）---------- */}
      <div
        className={cn(
          "min-h-0 overflow-y-auto",
          result ? "max-h-[72%] shrink-0" : "flex flex-1 flex-col"
        )}
      >
        {/* 选择区：顶部对齐（不垂直居中，避免上半屏一大片空白） */}
        <section className="px-5 pb-2.5 pt-4">
          {/* 图纸对：出结果后收成一行摘要，点开才能改选。
              正在比对 / 还没结果 / 改选了别的一张时一律展开（别把改选入口藏起来）。 */}
          {pairCollapsible && (
            <DockTooltip
              content={pairOpen ? "收起图纸选择" : "展开可改选基准图与对比图"}
              wrapperClassName="block w-full"
            >
              <button
                type="button"
                onClick={() => setPairOpen((v) => !v)}
                aria-expanded={pairOpen}
                aria-label={`${pairOpen ? "收起" : "展开"}图纸选择：基准 ${pairBaseName}，对比 ${pairTargetName}`}
                className="flex w-full items-center gap-1.5 rounded-full px-2 py-1 text-left text-[11px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
              >
                <ChevronRight
                  className={cn(
                    "size-3.5 shrink-0 transition-transform duration-150",
                    pairOpen && "rotate-90"
                  )}
                />
                <span className="min-w-0 flex-1 truncate">
                  基准：
                  <span className="font-medium text-foreground/75">
                    {pairBaseName}
                  </span>
                  <span aria-hidden className="mx-1.5 text-muted-foreground/60">
                    ↔
                  </span>
                  对比：
                  <span className="font-medium text-foreground/75">
                    {pairTargetName}
                  </span>
                </span>
              </button>
            </DockTooltip>
          )}

          {!pairFolded && (
          /* 图纸对：基准图 ↔ 对比图。上下两行 + 中间一枚交换按钮，读成一「对」 */
          <div className={selectionMatched ? "mt-2" : undefined}>
            <FieldLabel>基准图</FieldLabel>
            <CompareSelect
              value={baseId}
              placeholder="选择基准图"
              ariaLabel="基准图"
              onChange={(v) => onBaseChange(v || null)}
              groups={[
                {
                  options: tabs.map((t) => ({ value: t.id, label: t.name })),
                },
              ]}
            />

            {/* 两行之间：两侧短线夹一个小圆按钮，点它把上下两张图对调。
                上边距 12px：上面是输入框、下面是「对比图」label + 6px，加这段。
                图标正好落在两行之间的视觉中线上（之前贴在上面一行，显得偏上）。 */}
            <div className="mt-3 flex h-6 items-center justify-center gap-2">
              <span aria-hidden className="h-px w-5 bg-border/70" />
              <DockTooltip
                content={
                  canSwap ? "交换基准图与对比图" : "两张图都选好后可以交换"
                }
                wrapperClassName="shrink-0"
              >
                <button
                  type="button"
                  aria-label="交换基准图与对比图"
                  disabled={!canSwap}
                  onClick={() => {
                    onBaseChange(targetId);
                    onTargetChange(baseId);
                  }}
                  className="inline-flex size-6 items-center justify-center rounded-full bg-muted/60 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:bg-transparent disabled:opacity-35"
                >
                  <ArrowUpDown className="size-3.5" />
                </button>
              </DockTooltip>
              <span aria-hidden className="h-px w-5 bg-border/70" />
            </div>

            <FieldLabel>对比图</FieldLabel>
            <div className="flex items-center gap-1.5">
              <CompareSelect
                className="min-w-0 flex-1"
                value={targetId}
                placeholder="选择对比图"
                ariaLabel="对比图"
                onChange={(v) => onTargetChange(v || null)}
                groups={[
                  {
                    label: "已打开的图纸",
                    options: tabs.map((t) => ({ value: t.id, label: t.name })),
                  },
                  ...(recentOnly.length > 0
                    ? [
                        {
                          label: "最近打开",
                          options: recentOnly.map((r) => ({
                            value: r.id,
                            label: r.name,
                          })),
                        },
                      ]
                    : []),
                ]}
              />
              <DockTooltip
                content="选择本地文件作为对比图"
                wrapperClassName="shrink-0"
              >
                <Button
                  size="icon"
                  variant="secondary"
                  className="size-9 shrink-0 rounded-full"
                  aria-label="选择对比图文件"
                  onClick={pickFile}
                >
                  <FolderOpen />
                </Button>
              </DockTooltip>
              <input
                ref={fileRef}
                type="file"
                accept=".dwg,.dxf"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  void handlePicked(f);
                  e.target.value = "";
                }}
              />
            </div>
            {sameDrawing && (
              <p className="mt-1 text-[11px] text-destructive">
                基准图与对比图不能是同一张。
              </p>
            )}
          </div>
          )}

          {/* 有结果后选项折起来：统计与列表才是这时候要看的东西 */}
          {result && (
            <button
              type="button"
              onClick={() => setOptsOpen((v) => !v)}
              aria-expanded={optsOpen}
              className="mt-3 flex w-full items-center gap-1.5 rounded-full px-2 py-1 text-left text-[11px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            >
              <ChevronRight
                className={cn(
                  "size-3.5 shrink-0 transition-transform duration-150",
                  optsOpen && "rotate-90"
                )}
              />
              <span className="shrink-0 font-medium text-foreground/75">
                比对选项
              </span>
              <span className="min-w-0 flex-1 truncate text-right tabular-nums">
                {state.options.tolerance} ·{" "}
                {state.options.compareProps
                  .map((k) => PROP_LABELS[k])
                  .join("/") || "仅几何"}`
                {state.options.includeHatch ? " · 含填充" : ""}
              </span>
            </button>
          )}

          {(optsOpen || !result) && (
            <div className="mt-4 space-y-3">
              {/* 容差：行内 label + 窄输入框；右侧「包含填充」是胶囊开关，整行 h-9 */}
              <div className="flex h-9 items-center gap-2.5">
                <span className="shrink-0 text-[11px] font-medium text-muted-foreground">
                  容差
                </span>
                <Input
                  type="number"
                  min={0}
                  step={0.001}
                  value={tolText}
                  aria-label="容差"
                  className="h-9 w-24 shrink-0 rounded-xl border-0 bg-muted/55 px-3 text-[12.5px] tabular-nums shadow-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  onChange={(e) => {
                    const text = e.target.value;
                    setTolText(text);
                    const v = Number(text);
                    if (text.trim() !== "" && Number.isFinite(v) && v >= 0) {
                      onOptionsChange({ tolerance: v });
                    }
                  }}
                  onBlur={() => {
                    // 失焦时把非法值（空 / 负数 / 非数字）还原成当前生效值。
                    const v = Number(tolText);
                    if (
                      tolText.trim() === "" ||
                      !Number.isFinite(v) ||
                      v < 0
                    ) {
                      setTolText(tolTextOf(state.options.tolerance));
                    }
                  }}
                />
                <DockTooltip
                  content="填充、图案也参与比对（更慢）"
                  wrapperClassName="ml-auto shrink-0"
                >
                  <button
                    type="button"
                    aria-pressed={state.options.includeHatch}
                    onClick={() =>
                      onOptionsChange({
                        includeHatch: !state.options.includeHatch,
                      })
                    }
                    className={cn(
                      "inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[11px] transition-colors",
                      state.options.includeHatch
                        ? "bg-secondary font-medium text-secondary-foreground"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                    )}
                  >
                    {/* 固定 12px 的指示位：开 = ✓，关 = 空方框。宽度不变，切换时不会跳 */}
                    <span className="grid size-3 shrink-0 place-items-center">
                      {state.options.includeHatch ? (
                        <Check className="size-3" />
                      ) : (
                        <span className="size-3 rounded-[3px] border border-muted-foreground/45" />
                      )}
                    </span>
                    包含填充
                  </button>
                </DockTooltip>
              </div>

              {/* 比对属性：4 个可切换 chip（原来的 checkbox 换掉了） */}
              <div>
                <FieldLabel>比对属性</FieldLabel>
                <div className="flex flex-wrap gap-1.5">
                  {PROP_OPTIONS.map((p) => {
                    const on = state.options.compareProps.includes(p.key);
                    return (
                      <DockTooltip
                        key={p.key}
                        content={p.title}
                        wrapperClassName="shrink-0"
                      >
                        <button
                          type="button"
                          aria-pressed={on}
                          onClick={() => {
                            const next = on
                              ? state.options.compareProps.filter(
                                  (k) => k !== p.key
                                )
                              : [...state.options.compareProps, p.key];
                            onOptionsChange({ compareProps: next });
                          }}
                          className={cn(
                            "inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[11px] transition-colors",
                            on
                              ? "bg-secondary font-medium text-secondary-foreground"
                              : "text-muted-foreground hover:bg-muted hover:text-foreground"
                          )}
                        >
                          {/* 复选框指示：开 = ✓，关 = 空方框（宽度固定，切换不跳） */}
                          <span className="grid size-3 shrink-0 place-items-center">
                            {on ? (
                              <Check className="size-3" />
                            ) : (
                              <span className="size-3 rounded-[3px] border border-muted-foreground/45" />
                            )}
                          </span>
                          {p.label}
                        </button>
                      </DockTooltip>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* 主按钮 / 次按钮同一行，宽度均分（各占一半） */}
          <div className="mt-5 flex items-center gap-2">
            <DockTooltip
              content={
                !baseId || !targetId
                  ? "先选好基准图与对比图"
                  : sameDrawing
                    ? "基准图与对比图不能是同一张"
                    : "提交比对（大图可能要几秒）"
              }
              wrapperClassName="min-w-0 flex-1"
            >
              <Button
                className="h-9 w-full min-w-0 gap-1.5 rounded-full px-4"
                disabled={!baseId || !targetId || sameDrawing || running}
                onClick={onRun}
              >
                {running ? <Loader2 className="animate-spin" /> : <Play />}
                <span className="truncate">
                  {running
                    ? `比对中 ${elapsedSec.toFixed(1)}s`
                    : result
                      ? "重新对比"
                      : "开始对比"}
                </span>
              </Button>
            </DockTooltip>
            <DockTooltip
              content={
                !baseId || !targetId
                  ? "先选好基准图与对比图"
                  : sameDrawing
                    ? "基准图与对比图不能是同一张"
                    : compareView
                      ? "退出并排对比，回到单图"
                      : "左右并排显示两张图"
              }
              wrapperClassName="min-w-0 flex-1"
            >
              <Button
                variant="ghost"
                className={cn(
                  "h-9 w-full min-w-0 gap-1.5 rounded-full border border-border/70 px-3 text-muted-foreground",
                  compareView && "border-transparent bg-secondary text-secondary-foreground"
                )}
                disabled={!baseId || !targetId || sameDrawing}
                aria-pressed={compareView}
                onClick={onToggleCompareView}
              >
                {compareView ? <PanelRightClose /> : <Columns2 />}
                <span className="truncate">
                  {compareView ? "退出并排" : "并排对比"}
                </span>
              </Button>
            </DockTooltip>

            {/* 导出 Word 报告：只在有结果时出现，和两个主按钮同一行、贴右端。
                不再单独占一整行（用户要求） */}
            {result && (
              <Button
                variant="ghost"
                className={cn(
                  "h-9 shrink-0 gap-1.5 rounded-full border border-border/70 px-3 text-muted-foreground",
                  reportBusy && "text-foreground"
                )}
                disabled={
                  reportBusy || !reportAvailable || result.changes.length === 0
                }
                aria-busy={reportBusy}
                aria-label="导出 Word 对比报告"
                onClick={() => void handleExportReport()}
              >
                {reportBusy ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <FileDown />
                )}
                <span className="truncate">
                  {reportBusy
                    ? `${formatNumber(reportDone)}/${formatNumber(reportTotal)}`
                    : "导出报告"}
                </span>
              </Button>
            )}
          </div>

          {/* 报告生成进度 / 错误：只在这两种状态下占一行 */}
          {result && reportBusy && (
            <div
              className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-label="报告生成进度"
              aria-valuemin={0}
              aria-valuemax={reportTotal}
              aria-valuenow={reportDone}
            >
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-150"
                style={{
                  width: `${
                    reportTotal
                      ? Math.round((reportDone / reportTotal) * 100)
                      : 0
                  }%`,
                }}
              />
            </div>
          )}

          {result && reportError && (
            <p className="mt-1.5 break-words text-[11px] leading-relaxed text-destructive">
              {reportError}
            </p>
          )}

          {error && (
            <div
              role="alert"
              className="mt-3 flex items-start gap-2 rounded-xl bg-destructive/[0.07] px-3 py-2 text-[11px] leading-relaxed text-destructive"
            >
              <TriangleAlert className="mt-px size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 break-words">{error}</span>
              <DockTooltip content="关闭错误提示" wrapperClassName="shrink-0">
                <button
                  type="button"
                  className="rounded-full p-0.5 transition-colors hover:bg-destructive/10"
                  aria-label="关闭错误提示"
                  onClick={onDismissError}
                >
                  <X className="size-3.5" />
                </button>
              </DockTooltip>
            </div>
          )}
        </section>
      </div>

      {/* 筛选 + 变更集列表 */}
      {result && (
        <>
          <div className="mx-5 h-px bg-border/50" />
          <ChangeList
            result={result}
            changes={changes}
            filter={filter}
            selectedId={selectedId}
            activeSetId={activeSetId}
            onFilterChange={onFilterChange}
            onSelect={onSelect}
            onLocateChange={onLocateChange}
            onLocateSet={onLocateSet}
            onActivateSet={onActivateSet}
            onClear={onClear}
          />
        </>
      )}
    </div>
  );
}

/* 结果摘要行已移除：统计数字并入下方筛选胶囊（全部/新增/删除/修改），
 * 清除入口移到筛选行右侧。 */

/* 警告块也已移除（用户要求删掉那两个灰条）。truncated / warnings 信息仍在
 * `result.summary` 里，需要时可从这里恢复。 */

/* ------------------------------------------------------------------ */
/* 筛选 / 变更列表                                                     */
/* ------------------------------------------------------------------ */

/** 滑动指示器分段控件：沿用标签栏信息面板那套（白色胶囊 thumb 滑动）。 */
function SlidingSegments<T extends string>({
  value,
  items,
  onChange,
  ariaLabel,
}: {
  value: T;
  items: { key: T; label: string }[];
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const btnRefs = useRef(new Map<T, HTMLButtonElement>());
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);

  const measure = useCallback(() => {
    const wrap = wrapRef.current;
    const btn = btnRefs.current.get(value);
    if (!wrap || !btn) {
      setThumb(null);
      return;
    }
    setThumb({ x: btn.offsetLeft, w: btn.offsetWidth });
  }, [value]);

  useLayoutEffect(() => {
    measure();
  }, [measure, items.length]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [measure]);

  return (
    <div
      ref={wrapRef}
      role="tablist"
      aria-label={ariaLabel}
      className="relative flex h-7 w-full items-center rounded-full bg-muted/60 p-0.5"
    >
      {thumb && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0.5 left-0 rounded-full bg-card shadow-sm"
          style={{
            width: thumb.w,
            transform: `translateX(${thumb.x}px)`,
            transition:
              "transform 240ms cubic-bezier(.32,.72,0,1), width 240ms cubic-bezier(.32,.72,0,1)",
          }}
        />
      )}
      {items.map((item) => {
        const active = value === item.key;
        return (
          <button
            key={item.key}
            ref={(el) => {
              if (el) btnRefs.current.set(item.key, el);
              else btnRefs.current.delete(item.key);
            }}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(item.key)}
            className={cn(
              "relative z-10 flex h-6 flex-1 items-center justify-center rounded-full px-2 text-[11px] transition-colors",
              active
                ? "font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

function ChangeList({
  result,
  changes,
  filter,
  selectedId,
  activeSetId,
  onFilterChange,
  onSelect,
  onLocateChange,
  onLocateSet,
  onActivateSet,
  onClear,
}: {
  result: CompareResult;
  changes: CompareChange[];
  filter: CompareFilter;
  selectedId: number | null;
  activeSetId: number | null;
  onFilterChange: (f: CompareFilter) => void;
  onSelect: (id: number | null) => void;
  onLocateChange: (c: CompareChange) => void;
  onLocateSet: (setId: number) => void;
  onActivateSet: (setId: number | null) => void;
  onClear: () => void;
}) {
  const [mode, setMode] = useState<"sets" | "flat">("sets");
  const [openOverride, setOpenOverride] = useState<Record<number, boolean>>({});
  const [moreBySet, setMoreBySet] = useState<Record<number, number>>({});
  const [flatLimit, setFlatLimit] = useState(ROWS_PER_PAGE);
  const listRef = useRef<HTMLDivElement | null>(null);

  /** 类型筛选的候选（按出现次数降序） */
  const types = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of result.changes) m.set(c.type, (m.get(c.type) ?? 0) + 1);
    return [...m.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
    );
  }, [result]);

  const setMeta = useMemo(() => {
    const m = new Map<number, CompareChangeSet>();
    for (const s of result.changeSets) m.set(s.id, s);
    return m;
  }, [result]);

  /** 分组：按变更数降序（契约保证 setId 已按大到小；这里再兜一次） */
  const groups = useMemo(() => {
    const bySet = new Map<number, CompareChange[]>();
    for (const c of changes) {
      const arr = bySet.get(c.setId);
      if (arr) arr.push(c);
      else bySet.set(c.setId, [c]);
    }
    return [...bySet.entries()]
      .map(([setId, list]) => ({
        setId,
        list,
        meta: setMeta.get(setId) ?? null,
      }))
      .sort((a, b) => b.list.length - a.list.length || a.setId - b.setId);
  }, [changes, setMeta]);

  // 由顶部"上一处 / 下一处"点选的变更集：自动展开并滚到可见。
  useEffect(() => {
    if (activeSetId == null || mode !== "sets") return;
    const el = listRef.current?.querySelector(
      `[data-setsection="${activeSetId}"]`
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [activeSetId, mode, changes]);

  const isOpen = (setId: number, index: number) =>
    openOverride[setId] ?? (index === 0 || setId === activeSetId);

  const capped = changes.length > MAX_OVERLAY_CHANGES;

  const kindItems: { key: CompareKindFilter; label: string }[] = [
    {
      key: "all",
      label: `全部 ${formatNumber(
        result.summary.added + result.summary.removed + result.summary.modified
      )}`,
    },
    { key: "added", label: `新增 ${formatNumber(result.summary.added)}` },
    { key: "removed", label: `删除 ${formatNumber(result.summary.removed)}` },
    { key: "modified", label: `修改 ${formatNumber(result.summary.modified)}` },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 筛选：分段控件 + 两个无边框胶囊下拉 */}
      <div className="shrink-0 space-y-2 px-5 pb-2 pt-2.5">
        <SlidingSegments
          value={filter.kind}
          items={kindItems}
          onChange={(kind) => onFilterChange({ ...filter, kind })}
          ariaLabel="按变更种类筛选"
        />

        <div className="flex items-center gap-1.5">
          <div className="relative min-w-0 flex-1">
            <DockTooltip
              content="按实体类型筛选"
              wrapperClassName="block w-full"
            >
              <select
                value={filter.type ?? ""}
                onChange={(e) =>
                  onFilterChange({ ...filter, type: e.target.value || null })
                }
                aria-label="按实体类型筛选"
                className="h-7 w-full appearance-none rounded-full bg-muted/55 pl-3 pr-7 text-[12px] outline-none transition-colors hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <option value="">全部类型</option>
                {types.map(([type, n]) => (
                  <option key={type} value={type}>
                    {type}（{n}）
                  </option>
                ))}
              </select>
            </DockTooltip>
            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
          </div>
          <div className="relative shrink-0">
            <DockTooltip content="分组方式" wrapperClassName="block">
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as "sets" | "flat")}
                aria-label="分组方式"
                className="h-7 appearance-none rounded-full bg-muted/55 pl-3 pr-7 text-[12px] outline-none transition-colors hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <option value="sets">变更集</option>
                <option value="flat">平铺</option>
              </select>
            </DockTooltip>
            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
          </div>
          <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground">
            {formatNumber(changes.length)} 条
          </span>
          <DockTooltip content="清除比对结果" wrapperClassName="shrink-0">
            <button
              type="button"
              className="rounded-full p-0.5 text-muted-foreground/60 transition-colors hover:bg-foreground/10 hover:text-foreground"
              aria-label="清除比对结果"
              onClick={onClear}
            >
              <X className="size-3.5" />
            </button>
          </DockTooltip>
        </div>

        {capped && (
          <p className="text-[10px] leading-relaxed text-warning/90">
            叠加层只绘制前 {formatNumber(MAX_OVERLAY_CHANGES)}{" "}
            条（已简化显示），列表仍然完整。
          </p>
        )}
      </div>

      <div className="mx-5 h-px bg-border/50" />

      <div ref={listRef} className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          {changes.length === 0 ? (
            <EmptyList
              icon={
                result.changes.length === 0 ? (
                  <CircleCheck className="size-4" />
                ) : (
                  <FilterX className="size-4" />
                )
              }
              title={
                result.changes.length === 0
                  ? "两张图纸没有差异"
                  : "没有符合筛选的差异"
              }
              hint={
                result.changes.length === 0
                  ? "所有实体都在当前容差与属性范围内一致。"
                  : "试试放宽种类筛选，或换一个实体类型。"
              }
              action={
                result.changes.length === 0
                  ? undefined
                  : {
                      label: "清除筛选",
                      onClick: () => onFilterChange(EMPTY_COMPARE_FILTER),
                    }
              }
            />
          ) : mode === "flat" ? (
            <div>
              {changes.slice(0, flatLimit).map((c) => (
                <ChangeRow
                  key={c.id}
                  change={c}
                  selected={selectedId === c.id}
                  onSelect={onSelect}
                  onLocate={onLocateChange}
                />
              ))}
              {changes.length > flatLimit && (
                <button
                  type="button"
                  className="w-full px-5 py-2.5 text-center text-[11px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                  onClick={() => setFlatLimit((n) => n + ROWS_PER_MORE)}
                >
                  显示更多（还有 {formatNumber(changes.length - flatLimit)} 条）
                </button>
              )}
            </div>
          ) : (
            groups.map((g, gi) => {
              const open = isOpen(g.setId, gi);
              const limit = moreBySet[g.setId] ?? ROWS_PER_PAGE;
              const shown = g.list.slice(0, limit);
              const isActive = g.setId === activeSetId;
              const counts = KIND_META.map((k) => ({
                ...k,
                n: g.list.filter((c) => c.kind === k.key).length,
              }));
              const countsText =
                counts
                  .filter((c) => c.n > 0)
                  .map((c) => `${c.label} ${c.n}`)
                  .join("、") || "无变更";
              return (
                <div key={g.setId} data-setsection={g.setId}>
                  <div
                    className={cn(
                      "group/row sticky top-0 z-10 flex h-8 items-center backdrop-blur-sm transition-colors hover:bg-muted/50",
                      isActive ? "bg-muted/60" : "bg-card/95"
                    )}
                  >
                    <button
                      type="button"
                      className="flex h-full min-w-0 flex-1 items-center gap-2 pl-5 pr-1 text-left"
                      aria-expanded={open}
                      aria-label={`变更集 ${gi + 1}：${countsText}，共 ${g.list.length} 条`}
                      onClick={() => {
                        setOpenOverride((o) => ({
                          ...o,
                          [g.setId]: !open,
                        }));
                        onActivateSet(isActive ? null : g.setId);
                      }}
                    >
                      <ChevronRight
                        className={cn(
                          "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150",
                          open && "rotate-90"
                        )}
                      />
                      <span className="shrink-0 text-[12px] font-semibold text-foreground">
                        变更集 {gi + 1}
                      </span>
                      {/* 组名 | 计数：一道细竖线把名字和数字分开 */}
                      <span aria-hidden className="h-3 w-px shrink-0 bg-border" />
                      <span
                        aria-hidden
                        className="flex min-w-0 items-center gap-2 overflow-hidden"
                      >
                        {counts.map((k) => {
                          if (!k.n) return null;
                          return (
                            <span
                              key={k.key}
                              className="flex shrink-0 items-center gap-1 text-[10px] tabular-nums text-muted-foreground"
                            >
                              <span
                                className="size-1.5 shrink-0 rounded-full"
                                style={{ backgroundColor: k.dot }}
                              />
                              {k.n}
                            </span>
                          );
                        })}
                      </span>
                      <DockTooltip
                        content={`变更集 ${gi + 1}${
                          g.meta ? ` · 范围 ${fmtExtent(g.meta.bbox)}` : ""
                        }`}
                        wrapperClassName="ml-auto shrink-0"
                      >
                        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
                          {g.list.length}
                        </span>
                      </DockTooltip>
                    </button>
                    <DockTooltip
                      content="定位到这个变更集"
                      wrapperClassName="shrink-0 pr-4"
                    >
                      <button
                        type="button"
                        className="rounded-full p-1 text-muted-foreground/60 transition-colors hover:bg-foreground/10 hover:text-foreground"
                        aria-label="定位到这个变更集"
                        onClick={() => onLocateSet(g.setId)}
                      >
                        <LocateFixed className="size-3.5" />
                      </button>
                    </DockTooltip>
                  </div>

                  {open && (
                    <div>
                      {shown.map((c) => (
                        <ChangeRow
                          key={c.id}
                          change={c}
                          selected={selectedId === c.id}
                          onSelect={onSelect}
                          onLocate={onLocateChange}
                        />
                      ))}
                      {g.list.length > limit && (
                        <button
                          type="button"
                          className="w-full px-5 py-2.5 text-center text-[11px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                          onClick={() =>
                            setMoreBySet((m) => ({
                              ...m,
                              [g.setId]: limit + ROWS_PER_MORE,
                            }))
                          }
                        >
                          显示更多（还有 {formatNumber(g.list.length - limit)} 条）
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </ScrollArea>
      </div>
    </div>
  );
}

function ChangeRow({
  change,
  selected,
  onSelect,
  onLocate,
}: {
  change: CompareChange;
  selected: boolean;
  onSelect: (id: number | null) => void;
  onLocate: (c: CompareChange) => void;
}) {
  const handle = change.handleTarget ?? change.handleBase;
  const color = CHANGE_COLORS[change.kind];
  return (
    <div
      className={cn(
        "group relative flex h-8 items-stretch transition-colors",
        selected ? "bg-muted/60" : "hover:bg-muted/50"
      )}
    >
      {/* 选中标记：左侧一道细竖条（绝对定位，不挤动行内文字） */}
      {selected && (
        <span
          aria-hidden
          className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-foreground/35"
        />
      )}
      <button
        type="button"
        className="flex h-full min-w-0 flex-1 items-center gap-2 pl-5 pr-1 text-left"
        onClick={() => onSelect(selected ? null : change.id)}
        aria-pressed={selected}
        aria-label={`${change.kind === "added" ? "新增" : change.kind === "removed" ? "删除" : "修改"} · ${change.type} · 图层 ${change.layer || "—"}${
          handle ? ` · 句柄 #${handle}` : ""
        }`}
      >
        <span
          className="size-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: color }}
        />
        <span className="w-[4.5rem] shrink-0 truncate font-mono text-[12px] tracking-tight">
          {change.type}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[12px]",
            selected ? "text-foreground" : "text-muted-foreground"
          )}
        >
          {change.layer || "—"}
        </span>
        <span className="shrink-0 font-mono text-[12px] tabular-nums text-muted-foreground/80">
          {handle ? `#${handle}` : "—"}
        </span>
      </button>
      <DockTooltip
        content="把视图框到这条变更"
        wrapperClassName="shrink-0 pr-4"
      >
        <button
          type="button"
          className="rounded-full p-1 text-muted-foreground/55 opacity-50 transition-all hover:bg-foreground/10 hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
          aria-label="定位到这条变更"
          onClick={() => onLocate(change)}
        >
          <LocateFixed className="size-3.5" />
        </button>
      </DockTooltip>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 小零件                                                             */
/* ------------------------------------------------------------------ */

function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">
      {children}
    </div>
  );
}

/** 列表空态：图标 + 一句主文案 + 一句说明（可选一个轻量动作） */
function EmptyList({
  icon,
  title,
  hint,
  action,
}: {
  icon: ReactNode;
  title: string;
  hint?: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex h-full min-h-[220px] flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <div className="grid size-9 place-items-center rounded-full bg-muted/60 text-muted-foreground">
        {icon}
      </div>
      <div className="text-xs font-medium">{title}</div>
      {hint && (
        <p className="max-w-[248px] text-[11px] leading-relaxed text-muted-foreground">
          {hint}
        </p>
      )}
      {action && (
        <button
          type="button"
          className="mt-1 h-7 rounded-full bg-muted/60 px-3 text-[11px] font-medium text-foreground/80 transition-colors hover:bg-muted hover:text-foreground"
          onClick={action.onClick}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

/** 容差输入框的显示值：不写死小数位，0.001 就显示 0.001 */
function tolTextOf(v: number): string {
  return Number.isFinite(v) ? String(v) : "0.001";
}

/** 包围盒 → 一句话：宽 × 高，给变更集的 title 用。 */
function fmtExtent(bbox: CompareBBox): string {
  if (!bbox || bbox.length < 4) return "—";
  const w = bbox[2] - bbox[0];
  const h = bbox[3] - bbox[1];
  const fmt = (v: number) =>
    Math.abs(v) >= 1000 ? Math.round(v).toLocaleString("zh-CN") : v.toFixed(2);
  return `${fmt(w)} × ${fmt(h)}`;
}
