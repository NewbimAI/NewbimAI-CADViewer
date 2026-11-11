import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowUpFromLine,
  Boxes,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  FileCode,
  FileDigit,
  FileJson,
  FileText,
  Focus,
  FolderOpen,
  GitCompareArrows,
  Image,
  Layers,
  Loader2,
  PanelRightClose,
  ShieldCheck,
  TriangleAlert,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { compareDrawings, openByPath, openByUpload, requestCompareReport } from "@/api";
import {
  downloadJson,
  downloadPdf,
  downloadPng,
  downloadRawDxf,
} from "@/lib/export";
import {
  buildCompareReportPayload,
  downloadReportBlob,
  pickReportSaveTarget,
  reportDownloadName,
  supportsReportSavePicker,
  writeReportToTarget,
  type CompareReportProgress,
} from "@/lib/compareReport";
import type {
  CompareChange,
  CompareKind,
  DrawingSpace,
  DxfFocus,
  OpenResult,
} from "@/types";
import DxfCanvas, {
  type DxfApi,
  type DxfLayer,
  type DxfStatus,
} from "@/components/DxfCanvas";
import { CHANGE_COLORS } from "@/components/ChangeOverlay";
import MeasureToolbar, {
  type MeasureTool,
} from "@/components/MeasureToolbar";
import MeasureOverlay, { type Measurement } from "@/components/MeasureOverlay";
import ComparePanel, {
  EMPTY_COMPARE,
  EMPTY_COMPARE_FILTER,
  type CompareFilter,
  type CompareOptionsUi,
  type CompareUiState,
} from "@/components/ComparePanel";
import CompareView, {
  type ComparePaneFile,
  type CompareSide,
} from "@/components/CompareView";
import DockTooltip from "@/components/DockTooltip";
import { Logo } from "@/components/Logo";
import SettingsMenu from "@/components/SettingsMenu";
import DrawingTabs, {
  type PanelSegment,
} from "@/components/DrawingTabs";
import SpaceTabs from "@/components/SpaceTabs";
import ViewToolbar from "@/components/ViewToolbar";
import OverviewTab from "@/components/tabs/OverviewTab";
import LayersTab from "@/components/tabs/LayersTab";
import BlocksTab from "@/components/tabs/BlocksTab";
import { createMeasureEngine, type MeasureEngine } from "@/lib/measure";

/**
 * 加载阶段的中文措辞。阶段名（font/fetch/parse/prepare）只在代码里流转，
 * 是 dxf-viewer 的实现细节，不直接展示给用户。
 */
const DX_PHASE_LABEL: Record<string, string> = {
  font: "字体",
  fetch: "获取",
  parse: "解析",
  prepare: "准备",
};

/** 单张图纸的完整会话状态（tab 切换互不干扰） */
interface Session {
  file: OpenResult;
  visibleMap: Record<string, boolean>;
  /** 是否处于"全图视图"：连图框、幕墙延伸等主体范围外的内容一起框进画面 */
  fullView: boolean;
  /** 当前亮显的图层/图块；null = 无聚焦（服务端按 `focus=` 重新着色） */
  focus: DxfFocus | null;
  /** 当前空间：`model` 或 `layout:<布局名>`（服务端 space 变体）；切换时保留图层显隐 */
  space: string;
}

const MODEL_SPACE = { id: "model", name: "模型" } as const;

function newSession(file: OpenResult): Session {
  return {
    file,
    visibleMap: Object.fromEntries(
      /* 只显式打开非冻结层；冻结层交给引擎按类型决定（带尺寸的冻结层默认可见，
       * 其余冻结层保持隐藏，避免 `地库增加范围` 这类覆盖层重影）。图层面板仍可逐层改。 */
      (file.stats?.layers ?? []).filter((l) => !l.frozen).map((l) => [l.name, true])
    ),
    fullView: false,
    focus: null,
    space: MODEL_SPACE.id,
  };
}

/** 比对图例（与 ChangeOverlay 同一套颜色，契约 §5 固定） */
const COMPARE_LEGEND: { key: CompareKind; label: string; color: string }[] = [
  { key: "added", label: "新增", color: CHANGE_COLORS.added },
  { key: "removed", label: "删除", color: CHANGE_COLORS.removed },
  { key: "modified", label: "修改", color: CHANGE_COLORS.modified },
];

/** 浮动信息面板的标题（按当前分段/对比模式） */
const PANEL_TITLES: Record<string, string> = {
  overview: "概览",
  layers: "图层",
  blocks: "图块",
  compare: "图纸对比",
};

/** 浮动面板的最大高度：扣掉顶栏 + 标签栏 + 底部 dock 的安全区，
 *  保证 1280×800 这种较矮的窗口下面板也不会压到工具条。 */
const PANEL_MAX_H = "calc(100% - 2rem)";

/** /api/compare 一次最多要多少条（契约 §3 options.maxChanges） */
const COMPARE_MAX_CHANGES = 5000;

/** 「只看变更（灰显其余）」的本地记忆：默认开，记住用户上次选择 */
const ONLY_CHANGES_KEY = "cadviewer.compare.onlyChanges";

/** 从解析后的 DXF 头里读 `$INSUNITS`（有的解析器把 header 键写成小写） */
function readUnitCode(doc: unknown): number | undefined {
  try {
    const header = (doc as { header?: Record<string, unknown> } | null)?.header;
    const v = header?.$INSUNITS ?? header?.$insunits;
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

export default function App() {
  /** 已打开图纸的会话（按 id） */
  const [sessions, setSessions] = useState<Record<string, Session>>({});
  /** tab 顺序 */
  const [tabs, setTabs] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dark, setDark] = useState(true);
  /** 浮动信息面板：默认关闭，画布占满整个宽度 */
  const [panelOpen, setPanelOpen] = useState(false);
  /** 缩放百分比（100% = 适应窗口）。⚠️ 刻意用 ref 直写文本而不是 state：
   *  画布在手势中会连续上报，setState 会让整棵树（面板/图层/图块表）跟着重渲染，
   *  实测把缩放帧间隔从 16.7ms 拖到 50ms（60fps → 20fps）。这里只影响一个数字文本。 */
  const scaleRef = useRef<HTMLSpanElement>(null);
  const setScale = useCallback((v: number) => {
    const el = scaleRef.current;
    if (el) el.textContent = `${Math.round(v)}%`;
  }, []);
  const [dragOver, setDragOver] = useState(false);

  /* ---------------- 图纸比对（lane C） ---------------- */
  /** 浮动面板当前分段（受控：顶栏「图纸对比」会把它切到 compare） */
  const [panelTab, setPanelTab] = useState("overview");
  /** 当前画布实例（叠加层要拿它做 WCS → 画布投影） */
  const [viewerApi, setViewerApi] = useState<DxfApi | null>(null);
  /** 比对状态（和 sessions 放一起：换 tab 不丢结果） */
  const [compare, setCompare] = useState<CompareUiState>(EMPTY_COMPARE);
  const [compareFilter, setCompareFilter] =
    useState<CompareFilter>(EMPTY_COMPARE_FILTER);
  /** 高亮的单条变更（其余压暗） */
  const [compareSelId, setCompareSelId] = useState<number | null>(null);
  /** 高亮的变更集（上一处/下一处导航用） */
  const [compareSetId, setCompareSetId] = useState<number | null>(null);
  const [compareShowDiff, setCompareShowDiff] = useState(true);
  /**
   * 只看变更（灰显其余）：默认开，记住上次选择。
   * 语义不是隐藏未变更图形，而是给 canvas 加 grayscale + 低透明度；
   * 变更叠加层保持彩色，所以改动会自然跳出来。
   */
  const [compareOnlyChanges, setCompareOnlyChanges] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(ONLY_CHANGES_KEY) !== "0";
    } catch {
      return true;
    }
  });
  /** 并排对比：主区域换成 基准图 / 对比图 两张画布（默认仍是单图） */
  const [compareView, setCompareView] = useState(false);
  /** 并排模式下两张画布的 DxfApi（「定位」要同时框过去） */
  const compareBaseApi = useRef<DxfApi | null>(null);
  const compareTargetApi = useRef<DxfApi | null>(null);
  /** 浮动面板本体 / 最后触发它的按钮（关闭时把焦点还回去） */
  const panelRef = useRef<HTMLDivElement | null>(null);
  const panelTriggerRef = useRef<HTMLElement | null>(null);
  /** 比对运行号：关图纸 / 清结果 / 重新比对都会 +1，旧响应回来直接丢弃 */
  const compareRunRef = useRef(0);

  const session = activeId ? (sessions[activeId] ?? null) : null;
  const file = session?.file ?? null;

  /** 当前图纸的空间页签（服务端只给了一个"模型"时不显示） */
  const spaces: DrawingSpace[] = useMemo(
    () => file?.spaces?.length ? file.spaces : [{ ...MODEL_SPACE }],
    [file?.spaces]
  );
  const activeSpace =
    session?.space && spaces.some((s) => s.id === session.space)
      ? session.space
      : MODEL_SPACE.id;

  /** 画布要载入的 DXF 地址（空间 + 聚焦 + 派生版本） */
  const canvasUrl = useMemo(() => {
    if (!file) return null;
    const focus = session?.focus;
    return `/api/file/${file.id}/dxf?v=${file.dxfVersion}&space=${encodeURIComponent(
      activeSpace
    )}${
      focus
        ? `&focus=${encodeURIComponent(`${focus.kind}:${focus.name}`)}`
        : ""
    }`;
  }, [file, activeSpace, session?.focus]);

  /** 切换模型/布局：重载对应空间并回到适应窗口（图层显隐存在 session 里，不重置） */
  const switchSpace = useCallback(
    (id: string) => {
      if (!activeId || id === activeSpace) return;
      setSessions((s) => {
        const cur = s[activeId];
        if (!cur || cur.space === id) return s;
        return { ...s, [activeId]: { ...cur, space: id } };
      });
    },
    [activeId, activeSpace]
  );

  /* ---------------- 并排对比（两张画布） ---------------- */
  /** 两张图都选好且不是同一张，才能并排 */
  const canCompareView =
    !!compare.baseId &&
    !!compare.targetId &&
    compare.baseId !== compare.targetId;

  // 关掉被比对的 tab / 清空选择后立即退出并排，避免留两张空气画布
  useEffect(() => {
    if (!canCompareView) setCompareView(false);
  }, [canCompareView]);

  // 记住「只看变更」的选择（默认开；localStorage 不可用时静默退化为会话内状态）
  useEffect(() => {
    try {
      window.localStorage.setItem(
        ONLY_CHANGES_KEY,
        compareOnlyChanges ? "1" : "0"
      );
    } catch {
      /* 隐私模式 / 存储禁用：不影响功能 */
    }
  }, [compareOnlyChanges]);

  /**
   * 一侧画布要的图纸信息。已打开的图走会话（能拿到 dxfVersion 与主体范围）；
   * 从「最近打开」里选、但没打开成 tab 的图只能用 id 兜底，默认取景交给引擎全范围。
   */
  const compareBaseFile = useMemo<ComparePaneFile | null>(() => {
    const id = compare.baseId;
    if (!id) return null;
    const s = sessions[id];
    return {
      id,
      name:
        s?.file.name ??
        (compare.result?.base.id === id ? compare.result.base.name : "") ??
        "",
      format: s?.file.format ?? "",
      dxfVersion: s?.file.dxfVersion ?? 0,
      fitBox: s?.file.stats?.contentBox ?? null,
    };
  }, [compare.baseId, compare.result, sessions]);

  const compareTargetFile = useMemo<ComparePaneFile | null>(() => {
    const id = compare.targetId;
    if (!id) return null;
    const s = sessions[id];
    return {
      id,
      name:
        s?.file.name ??
        (compare.result?.target.id === id ? compare.result.target.name : "") ??
        "",
      format: s?.file.format ?? "",
      dxfVersion: s?.file.dxfVersion ?? 0,
      fitBox: s?.file.stats?.contentBox ?? null,
    };
  }, [compare.targetId, compare.result, sessions]);

  /** 比对结果是否还对应现在选中的两张（改选后别把旧差异画上去） */
  const compareMatched =
    !!compare.result &&
    compare.result.base.id === compare.baseId &&
    compare.result.target.id === compare.targetId;

  const fileInputRef = useRef<HTMLInputElement>(null);
  /** WebGL 引擎（dxf-viewer）的操作句柄与状态 */
  const dxfApi = useRef<DxfApi | null>(null);
  const [dxfStatus, setDxfStatus] = useState<DxfStatus | null>(null);
  const [dxfLayers, setDxfLayers] = useState<DxfLayer[]>([]);
  /** 每次打开图纸 +1，用于强制画布回到"适应窗口"（同一张图重开也要复位） */
  const [viewEpoch, setViewEpoch] = useState(0);

  /* ---------------- 测量（UI 侧；几何由 lib/measure 提供） ---------------- */
  const [measureTool, setMeasureTool] = useState<MeasureTool | null>(null);
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const [measureEngine, setMeasureEngine] = useState<MeasureEngine | null>(null);
  const [measureError, setMeasureError] = useState<string | null>(null);
  const [measureBuilding, setMeasureBuilding] = useState(false);
  /** 「清除」时 +1：叠加层据此把还没落完的点一起收掉 */
  const [measureClearNonce, setMeasureClearNonce] = useState(0);
  const measureSeq = useRef(0);
  /** 引擎是按哪份解析结果建的：同一份就不重复建（聚焦重载会换一份文档） */
  const measureBuiltRef = useRef<{ key: string | null; doc: unknown }>({
    key: null,
    doc: null,
  });

  const openFile = useCallback(
    async (open: () => Promise<OpenResult>): Promise<OpenResult | null> => {
      setLoading(true);
      setError(null);
      try {
        const result = await open();
        // 同一张图重开：保留其会话状态（图层显隐等），仅更新元数据并激活
        setSessions((s) => ({
          ...s,
          [result.id]: s[result.id]
            ? { ...s[result.id], file: result }
            : newSession(result),
        }));
        setTabs((t) => (t.includes(result.id) ? t : [...t, result.id]));
        setActiveId(result.id);
        // 打开图纸一律回到"适应窗口"，不继承上一张的缩放/平移
        setViewEpoch((n) => n + 1);
        return result;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return null;
      } finally {
        setLoading(false);
      }
    },
    []
  );

  /** 关闭 tab：移除会话；若关闭的是当前 tab 则激活相邻的；一张不剩时收起浮动面板 */  const closeTab = useCallback(
    (id: string) => {
      const idx = tabs.indexOf(id);
      const next = tabs.filter((x) => x !== id);
      setTabs(next);
      if (next.length === 0) setPanelOpen(false);
      setSessions((s) => {
        if (!(id in s)) return s;
        const { [id]: _drop, ...rest } = s;
        return rest;
      });
      if (activeId === id) {
        setActiveId(next[Math.min(idx, next.length - 1)] ?? null);
      }
      // 被比对的图纸关掉了：结果立即失效（WCS 仍有效，但一侧已经不在手上了）
      if (compare.baseId === id || compare.targetId === id) {
        compareRunRef.current += 1;
        setCompare((c) => ({
          ...c,
          baseId: c.baseId === id ? null : c.baseId,
          targetId: c.targetId === id ? null : c.targetId,
          result: null,
          error: null,
          running: false,
          elapsedMs: 0,
          startedAt: null,
        }));
        setCompareSelId(null);
        setCompareSetId(null);
      }
    },
    [tabs, activeId, compare.baseId, compare.targetId]
  );

  // 支持 ?open=<绝对路径> 直接打开（书签/快捷方式/自动化测试用，无 UI 入口）
  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get("open");
    if (p) openFile(() => openByPath(p));
  }, [openFile]);

  // 切换图纸时清空上一个文件的图层清单与渲染状态：新图还没读出图层前，
  // 图层面板必须处于"加载中"（开关禁用），不能沿用上一张图的清单。
  useEffect(() => {
    setDxfLayers([]);
    setDxfStatus(null);
  }, [activeId]);

  // 换图纸 / 重开图纸：测量结果是上一套 WCS 里的东西，必须一起清掉
  useEffect(() => {
    setMeasurements([]);
    setMeasureTool(null);
    measureBuiltRef.current = { key: null, doc: null };
  }, [activeId, viewEpoch]);

  // 测量引擎：画布把解析后的 DXF 交出来以后建一次索引。
  // 引擎在 `lib/measure` 里，这里只负责生命周期与错误呈现；
  // 建成后 `engine.units` 决定界面上所有单位文案。
  useEffect(() => {
    if (!activeId) {
      setMeasureEngine(null);
      setMeasureError(null);
      setMeasureBuilding(false);
      return;
    }
    if (dxfStatus?.phase !== "done") {
      // 载入 / 聚焦重载期间先收起：点不出结果比点出错误结果好
      setMeasureEngine(null);
      setMeasureBuilding(false);
      return;
    }

    const doc = dxfApi.current?.getParsedDxf?.() ?? null;
    const key = `${activeId}:${viewEpoch}`;
    if (doc && measureBuiltRef.current.key === key && measureBuiltRef.current.doc === doc) {
      return;
    }

    let cancelled = false;
    setMeasureError(null);
    setMeasureBuilding(true);
    // 让"就绪"先落到画面上，再花几十毫秒建索引。
    // 也顺手避开"换图瞬间旧状态还写着 done"的窗口：40ms 后重读一次文档，读不到就报错。
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      const latest = dxfApi.current?.getParsedDxf?.() ?? null;
      if (!latest) {
        setMeasureEngine(null);
        setMeasureError("画布没有保留解析后的图纸数据");
        setMeasureBuilding(false);
        return;
      }
      try {
        const unitCode = readUnitCode(latest);
        const engine = createMeasureEngine(
          latest,
          unitCode == null ? undefined : { unitCode }
        );
        measureBuiltRef.current = { key, doc: latest };
        setMeasureEngine(engine);
        setMeasureError(null);
      } catch (e) {
        measureBuiltRef.current = { key, doc: latest };
        setMeasureEngine(null);
        setMeasureError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setMeasureBuilding(false);
      }
    }, 40);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeId, viewEpoch, dxfStatus?.phase, viewerApi]);

  const measureReady = measureEngine?.ready === true;
  const measureDisabledTitle = measureError
    ? `测量引擎不可用：${measureError}`
    : measureBuilding
      ? "正在建立测量索引…"
      : !measureReady
        ? "测量引擎尚未就绪"
        : "";

  const commitMeasurement = useCallback((m: Omit<Measurement, "id">) => {
    const id = ++measureSeq.current;
    setMeasurements((list) => [...list, { ...m, id }]);
  }, []);

  const removeMeasurement = useCallback((id: number) => {
    setMeasurements((list) => list.filter((m) => m.id !== id));
  }, []);

  const clearMeasurements = useCallback(() => {
    setMeasurements([]);
    setMeasureClearNonce((n) => n + 1);
  }, []);


  const handleUpload = (f: File) => {
    const ext = f.name.toLowerCase().split(".").pop();
    if (ext !== "dwg" && ext !== "dxf") {
      setError(`不支持的格式 .${ext}，仅支持 DWG / DXF`);
      return;
    }
    // 从顶栏 / 拖拽新开一张图 = 回到单图视图（并排对比是当前两张的事）
    setCompareView(false);
    openFile(() => openByUpload(f));
  };

  const pickFile = () => fileInputRef.current?.click();

  /* ---------------- 图纸比对：打开面板 / 运行 / 定位 ---------------- */

  /** 首次进入对比面板时给出合理默认：基准图 = 当前 tab，对比图 = 另一张打开的图 */
  const seedCompareSelection = useCallback(() => {
    setCompare((c) => {
      const base = c.baseId ?? activeId;
      let target = c.targetId;
      if (target && base && target === base) target = null;
      // 只有两张图时直接把"另一张"填成对比图，省一次选择
      if (!target && base) target = tabs.find((t) => t !== base) ?? null;
      if (c.baseId === base && c.targetId === target) return c;
      return { ...c, baseId: base, targetId: target };
    });
  }, [activeId, tabs]);

  /** 收起浮动面板（可选把焦点还回触发按钮） */
  const closePanel = useCallback((restoreFocus = false) => {
    setPanelOpen(false);
    if (restoreFocus) {
      const el = panelTriggerRef.current;
      if (el) window.requestAnimationFrame(() => el.focus());
    }
  }, []);

  /** 标签栏分段：点当前项收起，点其它项打开/切换（记住的最后分段就是 panelTab） */
  const selectPanelSegment = useCallback(
    (segment: PanelSegment, trigger: HTMLElement) => {
      panelTriggerRef.current = trigger;
      setPanelOpen((open) => !(open && panelTab === segment));
      setPanelTab(segment);
    },
    [panelTab]
  );

  /** 顶栏「图纸对比」：打开/切到对比模式；已经在该模式时再点收起 */
  const openCompare = useCallback(
    (ev?: { currentTarget: HTMLElement }) => {
      if (ev?.currentTarget) panelTriggerRef.current = ev.currentTarget;
      setPanelOpen((open) => !(open && panelTab === "compare"));
      setPanelTab("compare");
      seedCompareSelection();
    },
    [panelTab, seedCompareSelection]
  );

  /* 面板只用「关闭按钮」或「再次点同一个分段/对比按钮」收起：
   * 不响应 Esc，也不响应画布/面板外的点击。这是常驻信息面板，用户会边看图边对照，
   * 误触或随手按 Esc 就关掉反而打断。（「联系我们」模态自己管理 Esc。） */

  /** 对比图从文件挑：先 POST /api/open 拿到 id，再交给面板当 target */
  const openCompareFile = useCallback(
    async (f: File): Promise<OpenResult | null> => {
      const ext = f.name.toLowerCase().split(".").pop();
      if (ext !== "dwg" && ext !== "dxf") {
        setError(`不支持的格式 .${ext}，仅支持 DWG / DXF`);
        return null;
      }
      return openFile(() => openByUpload(f));
    },
    [openFile]
  );

  const changeCompareOptions = useCallback(
    (patch: Partial<CompareOptionsUi>) => {
      setCompare((c) => ({ ...c, options: { ...c.options, ...patch } }));
    },
    []
  );

  const runCompare = useCallback(async () => {
    const { baseId, targetId, options, running } = compare;
    if (!baseId || !targetId || baseId === targetId || running) return;

    const token = ++compareRunRef.current;
    const t0 = performance.now();
    setCompare((c) => ({
      ...c,
      running: true,
      error: null,
      result: null,
      elapsedMs: 0,
      startedAt: Date.now(),
    }));

    try {
      const res = await compareDrawings({
        base: baseId,
        target: targetId,
        options: {
          tolerance: options.tolerance,
          quantize: 1e-6,
          compareProps: options.compareProps,
          includeHatch: options.includeHatch,
          maxChanges: COMPARE_MAX_CHANGES,
        },
      });
      if (compareRunRef.current !== token) return;
      setCompare((c) => ({
        ...c,
        running: false,
        startedAt: null,
        error: null,
        result: res,
        // 用本地往返耗时：用户等的是这个数，服务端 elapsedMs 只是引擎时间
        elapsedMs: Math.round(performance.now() - t0),
        baseId: res.base.id,
        targetId: res.target.id,
      }));
      setCompareSelId(null);
      setCompareSetId(null);
      setCompareFilter(EMPTY_COMPARE_FILTER);
    } catch (e) {
      if (compareRunRef.current !== token) return;
      setCompare((c) => ({
        ...c,
        running: false,
        startedAt: null,
        result: null,
        error: e instanceof Error ? e.message : String(e),
      }));
    }
  }, [compare]);

  const clearCompare = useCallback(() => {
    compareRunRef.current += 1;
    setCompare((c) => ({
      ...c,
      result: null,
      error: null,
      running: false,
      elapsedMs: 0,
      startedAt: null,
    }));
    setCompareSelId(null);
    setCompareSetId(null);
  }, []);

  const locateBBox = useCallback(
    (bbox: [number, number, number, number]) => {
      let [x0, y0, x1, y1] = bbox;
      const w = x1 - x0;
      const h = y1 - y0;
      // 退化包围盒（水平/竖直线、单点）要先补成一个小方框：
      // FitView 拿到 0 宽/高会算出一个夸张的放大倍率，一条竖线就会"飞到脸上"
      const min = Math.max(w, h, 1) * 0.15;
      if (w < min) {
        const cx = (x0 + x1) / 2;
        x0 = cx - min / 2;
        x1 = cx + min / 2;
      }
      if (h < min) {
        const cy = (y0 + y1) / 2;
        y0 = cy - min / 2;
        y1 = cy + min / 2;
      }
      if (compareView) {
        // 并排：两张一起框过去（同步开关不参与「定位」，两边都要看到同一处）
        compareBaseApi.current?.fitBBox?.(x0, y0, x1, y1);
        compareTargetApi.current?.fitBBox?.(x0, y0, x1, y1);
        return;
      }
      dxfApi.current?.fitBBox?.(x0, y0, x1, y1);
    },
    [compareView]
  );

  const locateCompareChange = useCallback(
    (change: CompareChange) => {
      setCompareSelId(change.id);
      setCompareSetId(change.setId);
      locateBBox(change.bbox);
    },
    [locateBBox]
  );

  const locateCompareSet = useCallback(
    (setId: number) => {
      const set = compare.result?.changeSets.find((s) => s.id === setId);
      setCompareSetId(setId);
      setCompareSelId(null);
      if (set) locateBBox(set.bbox);
    },
    [compare.result, locateBBox]
  );

  /** 变更集按"变更多的在前"排序（契约 §4.7 的编号顺序） */
  const orderedCompareSets = useMemo(() => {
    const sets = compare.result?.changeSets ?? [];
    return [...sets].sort((a, b) => b.count - a.count || a.id - b.id);
  }, [compare.result]);

  const compareSetIndex = orderedCompareSets.findIndex(
    (s) => s.id === compareSetId
  );

  /** 上一处 / 下一处：循环导航，顺带把视图框过去 */
  const gotoCompareSet = useCallback(
    (delta: number) => {
      if (!orderedCompareSets.length) return;
      const cur = orderedCompareSets.findIndex((s) => s.id === compareSetId);
      const next =
        cur < 0
          ? delta > 0
            ? 0
            : orderedCompareSets.length - 1
          : (cur + delta + orderedCompareSets.length) %
            orderedCompareSets.length;
      locateCompareSet(orderedCompareSets[next].id);
    },
    [orderedCompareSets, compareSetId, locateCompareSet]
  );

  /** 列表筛选后的变更：列表和叠加层吃同一份，筛选才是一致的 */
  const compareChanges = useMemo<CompareChange[]>(() => {
    const result = compare.result;
    if (!result) return [];
    const { kind, type } = compareFilter;
    if (kind === "all" && !type) return result.changes;
    return result.changes.filter(
      (c) =>
        (kind === "all" || c.kind === kind) && (!type || c.type === type)
    );
  }, [compare.result, compareFilter]);

  /** 差异控制（图例 / 显示差异 / 只看变更 / 导航 / 清除）只在并排且结果对得上时出现 */
  const showCompareDiff = compareView && compareMatched;

  /** 底部对比工具条只在并排模式出现：退出后单图不保留任何对比控件 */
  const showCompareToolbar = compareView;

  /** 并排模式下把每一侧的 DxfApi 交给 App（「定位」要同时框两张） */
  const handleCompareApi = useCallback(
    (side: CompareSide, api: DxfApi | null) => {
      if (side === "base") compareBaseApi.current = api;
      else compareTargetApi.current = api;
    },
    []
  );

  /** 进入 / 退出并排对比（退出后单图视图重新挂载并回到适应窗口） */
  const toggleCompareView = useCallback(() => {
    if (!canCompareView) return;
    setCompareView((v) => !v);
  }, [canCompareView]);

  /**
   * 导出 Word 对比报告。
   * 截图只能从并排的两块画布拿：当前是单图就先切到并排，等两侧 DxfApi 就绪。
   * 生成期间会反复移动两侧相机；结束后把原来的视图还回去。
   */
  const exportCompareReport = useCallback(
    async (onProgress: CompareReportProgress) => {
      const result = compare.result;
      if (!result) throw new Error("请先完成一次图纸对比");
      if (!compareMatched) {
        throw new Error("当前图纸选择与比对结果不一致，请重新对比后再导出");
      }

      /* 先让用户选保存位置：浏览器只在点击手势后的短暂窗口内允许弹「另存为」，
       * 而生成报告要几分钟，生成完再弹会被拒绝。用户取消则整单中止。 */
      const suggestedName = reportDownloadName(
        compareBaseFile?.name || result.base.name,
        compareTargetFile?.name || result.target.name
      );
      let saveTarget: Awaited<ReturnType<typeof pickReportSaveTarget>> = null;
      if (supportsReportSavePicker()) {
        saveTarget = await pickReportSaveTarget(suggestedName);
        if (!saveTarget) return;
      }

      if (!compareView) setCompareView(true);

      // 等并排视图挂载、两侧 DxfApi 交上来（最多 20s；大图加载另有 60s 就绪等待）
      const deadline = performance.now() + 20_000;
      while (
        (!compareBaseApi.current || !compareTargetApi.current) &&
        performance.now() < deadline
      ) {
        await new Promise((r) => window.setTimeout(r, 120));
      }

      const baseApi = compareBaseApi.current;
      const targetApi = compareTargetApi.current;
      if (!baseApi || !targetApi) {
        throw new Error("并排对比视图尚未准备好，请稍后重试");
      }

      const prevBase = baseApi.getView?.() ?? null;
      const prevTarget = targetApi.getView?.() ?? null;
      try {
        // 取景最小跨度：用主体范围的 1% 给变更留上下文（TEXT 插入点没有宽高）
        const fit = compareBaseFile?.fitBox ?? compareTargetFile?.fitBox ?? null;
        const minViewSpan = fit
          ? Math.max(fit.maxX - fit.minX, fit.maxY - fit.minY) * 0.01
          : undefined;
        const payload = await buildCompareReportPayload({
          baseApi,
          targetApi,
          result,
          options: {
            tolerance: compare.options.tolerance,
            compareProps: compare.options.compareProps,
            includeHatch: compare.options.includeHatch,
          },
          baseName: compareBaseFile?.name || result.base.name,
          targetName: compareTargetFile?.name || result.target.name,
          minViewSpan,
          onProgress,
        });
        const { blob, fileName } = await requestCompareReport(payload);
        if (saveTarget) {
          await writeReportToTarget(saveTarget, blob);
        } else {
          downloadReportBlob(blob, fileName || suggestedName);
        }
      } finally {
        // 报告生成会跑到最后一条变更；把用户原来的视图还回去
        if (prevBase) {
          baseApi.setView?.(
            prevBase.centerX,
            prevBase.centerY,
            prevBase.width
          );
        }
        if (prevTarget) {
          targetApi.setView?.(
            prevTarget.centerX,
            prevTarget.centerY,
            prevTarget.width
          );
        }
      }
    },
    [
      compare.result,
      compare.options,
      compareMatched,
      compareView,
      compareBaseFile,
      compareTargetFile,
    ]
  );


  /** 导出：PDF 服务端生成较慢（大图几秒），单独一个 busy；错误用顶栏下方的浮层提示 */
  const [pdfBusy, setPdfBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  /** 「导出」二级菜单展开状态：hover / 键盘聚焦 / 点击都能开，指针离开或失焦收起 */
  const [exportOpen, setExportOpen] = useState(false);

  useEffect(() => {
    if (!exportError) return;
    const t = window.setTimeout(() => setExportError(null), 6000);
    return () => window.clearTimeout(t);
  }, [exportError]);

  const canvasReady = dxfStatus?.phase === "done";

  const handleExportPng = useCallback(async () => {
    if (!file) return;
    setExportError(null);
    try {
      const blob = await dxfApi.current?.capturePng?.(2);
      if (!blob) {
        setExportError("画布还未就绪，等图纸渲染完成后再导出 PNG");
        return;
      }
      downloadPng(blob, file);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : String(e));
    }
  }, [file]);

  const handleExportPdf = useCallback(async () => {
    if (!file || pdfBusy) return;
    setPdfBusy(true);
    setExportError(null);
    try {
      await downloadPdf(file);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : String(e));
    } finally {
      setPdfBusy(false);
    }
  }, [file, pdfBusy]);

  const toggleLayer = useCallback(
    (name: string, visible: boolean) => {
      if (!activeId) return;
      setSessions((s) => {
        const cur = s[activeId];
        if (!cur) return s;
        return {
          ...s,
          [activeId]: {
            ...cur,
            visibleMap: { ...cur.visibleMap, [name]: visible },
          },
        };
      });
    },
    [activeId]
  );

  /** 缩放/取景都直接交给 WebGL 画布 */
  const zoom = (factor: number) => dxfApi.current?.zoomBy(factor);
  const fitCanvas = () => dxfApi.current?.fit();

  /**
   * 亮显某个图层/图块（双击行）。
   *
   * ⚠️ 只以"图纸已打开"为准（有 activeId 且会话里有 file），**不看画布的加载状态**：
   * 画布重载中（focus 重载要几秒）用户仍可继续改聚焦，绝不能把输入丢掉。
   * 交给 DxfCanvas 串行合并，最终画面等于最后一次点击。
   * 同一目标重复设置直接返回，避免多余重载。
   */
  const setFocus = useCallback(
    (kind: DxfFocus["kind"], name: string) => {
      if (!activeId) return;
      setSessions((s) => {
        const cur = s[activeId];
        if (!cur?.file) return s;
        if (cur.focus?.kind === kind && cur.focus.name === name) return s;
        return { ...s, [activeId]: { ...cur, focus: { kind, name } } };
      });
    },
    [activeId]
  );

  /** 还原（单击行）：清空聚焦，回到正常着色。同样不依赖画布加载状态。 */
  const clearFocus = useCallback(() => {
    if (!activeId) return;
    setSessions((s) => {
      const cur = s[activeId];
      if (!cur?.file || !cur.focus) return s;
      return { ...s, [activeId]: { ...cur, focus: null } };
    });
  }, [activeId]);

  /** WebGL 侧的图层显隐：DXF 里实际有内容的层 × 会话里的可见性（默认可见） */
  const dxfLayerVisibility = useMemo(() => {
    const map: Record<string, boolean> = {};
    // 未在 visibleMap 里的层（例如只有块内几何、scanner 未单列的层）跟随画布报告
    // 的初始可见性：冻结层在引擎里初始为隐藏，不能在这里被默认点亮。
    for (const l of dxfLayers) map[l.name] = session?.visibleMap?.[l.name] ?? l.visible;
    return map;
  }, [dxfLayers, session?.visibleMap]);

  /**
   * 图层开关的可用性：以画布**实际读到的图层**为准（`GetLayers(true)` 的结果）。
   * 只有真实存在于 DXF 里的层才能开关；画布还没读出图层时（加载中）一律禁用，
   * 避免用户点了没反应。
   */
  const availableLayers = useMemo(
    () => new Set(dxfLayers.map((l) => l.name)),
    [dxfLayers]
  );

  /**
   * 图层列表只列"真的有内容"的图层（空图层会把列表淹掉：真实图纸的图层表里往往大半没有实体）。
   * 严格按 scanner 的 `entityCount`：实体数为 0 的（空层、冻结层、只剩块定义残留的层）
   * 一律不在列表里显示，折叠数量由 `hiddenEmptyCount` 汇总告知用户。
   * 这里只影响展示口径，`visibleMap` / `dxfLayerVisibility` 不动，画布显隐照旧。
   */
  const visibleLayers = useMemo(() => {
    const all = session?.file.stats?.layers ?? [];
    if (!dxfLayers.length) return all;
    return all.filter((l) => l.entityCount > 0);
  }, [session?.file.stats?.layers, dxfLayers.length]);

  /** 被"没有实体"过滤掉、不在列表里显示的图层数（汇总徽标要如实说，别显示成 0） */
  const hiddenEmptyCount =
    (session?.file.stats?.layers?.length ?? 0) - visibleLayers.length;

  return (
    <div
      className="flex h-full flex-col bg-background"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) handleUpload(f);
      }}
    >
      {/* ---------- 顶栏 ----------
          品牌靠左（副标题收进 title 提示），打开图纸 + 导出水平居中，
          设置齿轮固定在最右。导出面板是悬停容器的子元素，控件之间用面板
          自身的 pt 做桥接，鼠标从按钮移向面板时不会离开容器，因此不闪断。 */}
      <header className="relative flex h-14 shrink-0 items-center gap-3 border-b bg-card px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <Logo className="h-7 w-7 shrink-0 text-foreground" />
          <DockTooltip
            content="DWG / DXF 本地预览与统计"
            wrapperClassName="inline-flex min-w-0"
          >
            <span className="cursor-default truncate text-base font-semibold tracking-tight">
              CADViewer
            </span>
          </DockTooltip>
        </div>

        {/* 打开图纸 · 导出 · 图纸对比：水平居中。绝对定位 + 平移，左右两侧内容宽度变化不会带着它漂移。
            三个都是 ghost：没有边框、没有实心底色，靠 hover:bg-accent + 焦点环表达可点。
            ⚠️ z-50 必须留：translate 会让这一层成为 stacking context，
            不加 z-index 时后面的画布区（DOM 里更靠后）会盖住导出的下拉面板。 */}
        <div className="absolute left-1/2 top-1/2 z-50 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1">
          <Button
            variant="ghost"
            size="lg"
            className="gap-1.5 rounded-full"
            data-header-action="open"
            onClick={pickFile}
          >
            <FolderOpen />
            打开图纸
          </Button>

          {/* 「导出」+ 二级菜单：触发按钮与面板同属一个 hover/focus 容器 */}
          <div
            className="relative"
            onMouseEnter={() => setExportOpen(true)}
            onMouseLeave={() => setExportOpen(false)}
            onFocus={() => setExportOpen(true)}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                setExportOpen(false);
              }
            }}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              setExportOpen(false);
              // 让焦点离开整个容器，否则 :focus 仍然把菜单按在那儿
              if (document.activeElement instanceof HTMLElement) {
                document.activeElement.blur();
              }
            }}
          >
            <DockTooltip
              content={pdfBusy ? "正在生成 PDF…" : null}
              wrapperClassName="block"
            >
              <Button
                size="lg"
                variant="ghost"
                className={cn(
                  "gap-1.5 rounded-full",
                  exportError &&
                    "text-destructive hover:bg-destructive/10 hover:text-destructive"
                )}
                disabled={pdfBusy}
                data-header-action="export"
                aria-haspopup="menu"
                aria-expanded={exportOpen}
                onClick={() => setExportOpen(true)}
              >
                {pdfBusy ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <ArrowUpFromLine />
                )}
                导出
                <ChevronDown
                  className={cn(
                    "size-3.5 opacity-60 transition-transform duration-150",
                    exportOpen && "-rotate-180"
                  )}
                />
              </Button>
            </DockTooltip>

            {/* 面板：绝对定位，不参与顶栏布局（顶栏高度永远是 h-14）。
                pt-1.5 既是视觉间距，也是按钮与面板之间的桥接区——
                它是面板盒子的一部分，指针穿过它时仍算在容器内。 */}
            <div
              className={cn(
                "absolute right-0 top-full z-50 pt-1.5 transition-opacity duration-100",
                exportOpen
                  ? "visible opacity-100"
                  : "invisible opacity-0"
              )}
            >
              <div
                role="menu"
                aria-label="导出图纸"
                className="w-56 rounded-2xl border bg-card p-1 shadow-lg"
              >
                <ExportMenuItem
                  icon={<Image />}
                  label="PNG"
                  note="当前视图"
                  title={
                    !file
                      ? "请先打开图纸"
                      : dxfStatus?.phase === "error"
                        ? "画布渲染失败，无法导出 PNG"
                        : !canvasReady
                          ? "等画布渲染完成后可导出 PNG"
                          : "导出当前视图为 PNG（2×）"
                  }
                  disabled={!file || !canvasReady}
                  onClick={handleExportPng}
                />
                <ExportMenuItem
                  icon={<FileJson />}
                  label="JSON"
                  note="统计"
                  title={
                    !file
                      ? "请先打开图纸"
                      : "导出统计 JSON（图层 / 图块 / 元数据）"
                  }
                  disabled={!file}
                  onClick={() => file && downloadJson(file)}
                />
                <ExportMenuItem
                  icon={<FileCode />}
                  label="DXF"
                  note="原始"
                  title={
                    !file
                      ? "请先打开图纸"
                      : "导出原始 DXF（可直接用 CAD 打开）"
                  }
                  disabled={!file}
                  onClick={() => file && downloadRawDxf(file)}
                />
                <ExportMenuItem
                  icon={
                    pdfBusy ? <Loader2 className="animate-spin" /> : <FileText />
                  }
                  label="PDF"
                  note={pdfBusy ? "生成中…" : "矢量"}
                  title={
                    !file
                      ? "请先打开图纸"
                      : pdfBusy
                        ? "正在生成 PDF…"
                        : "导出矢量 PDF（服务端生成，可能需要几秒）"
                  }
                  disabled={!file || pdfBusy}
                  onClick={handleExportPdf}
                />
              </div>
            </div>

            {/* 导出失败提示：挂在导出容器下方，绝对定位，不参与布局 */}
            {exportError && (
              <div
                role="status"
                aria-live="polite"
                className="absolute right-0 top-full z-50 mt-3 flex w-max max-w-[min(26rem,calc(100vw_-_2rem))] items-start gap-2 rounded-2xl border border-destructive/40 bg-card px-3 py-2 text-xs text-destructive shadow-lg"
              >
                <TriangleAlert className="mt-px size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 leading-relaxed">
                  {exportError}
                </span>
                <DockTooltip content="关闭导出提示" wrapperClassName="shrink-0">
                  <button
                    type="button"
                    className="shrink-0 rounded-full p-0.5 transition-colors hover:bg-destructive/10"
                    aria-label="关闭导出提示"
                    onClick={() => setExportError(null)}
                  >
                    <X className="size-3.5" />
                  </button>
                </DockTooltip>
              </div>
            )}
          </div>

          {/* 图纸对比：紧接「导出」之后。ghost 无边框；少于一张图时禁用。
              有比对结果时只在右上角点一个小圆点（绝对定位，不改变按钮宽度）。
              ⚠️ 提示挂在 DockTooltip 的包裹层上：禁用按钮是 pointer-events:none，
              包一层之后 hover 仍然能被接住，用户才知道为什么点不了。 */}
          <DockTooltip
            content={
              tabs.length >= 1
                ? "对比两张图纸的差异（新增 / 删除 / 修改）"
                : "先打开一张图纸，再选择对比图（可从「最近打开」或文件里挑）"
            }
            wrapperClassName="inline-flex"
          >
            <Button
              variant="ghost"
              size="lg"
              className="relative gap-1.5 rounded-full"
              data-header-action="compare"
              disabled={tabs.length < 1}
              aria-pressed={panelOpen && panelTab === "compare"}
              onClick={openCompare}
            >
              <GitCompareArrows />
              图纸对比
              {compare.result && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute right-1.5 top-1.5 size-1.5 rounded-full bg-foreground/60"
                />
              )}
            </Button>
          </DockTooltip>

          <input
            ref={fileInputRef}
            type="file"
            accept=".dwg,.dxf"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleUpload(f);
              e.target.value = "";
            }}
          />
        </div>

        {/* 设置齿轮：检查更新入口，固定在最右侧 */}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <SettingsMenu />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {/* ---------- 图纸标签栏（画布正上方独立一行） ----------
              没有打开任何图纸时整行不渲染：顶栏直接坐在画布/空状态上方。 */}
          {tabs.length > 0 && (
            <DrawingTabs
              tabs={tabs.map((id) => {
                const s = sessions[id];
                return {
                  id,
                  name: s?.file.name ?? id,
                  format: s?.file.format ?? "?",
                };
              })}
              activeId={activeId}
              onActivate={(id) => {
                // 点 tab = 看单张图：退出并排
                setCompareView(false);
                setActiveId(id);
              }}
              onClose={closeTab}
              panelSegment={
                panelOpen && panelTab !== "compare"
                  ? (panelTab as PanelSegment)
                  : null
              }
              onSelectPanel={selectPanelSegment}
            />
          )}

          {/* ---------- 画布区 ---------- */}
          <main
            className={cn(
              // @container：底部 dock 按画布实际宽度收起单位读数
              "@container relative min-h-0 min-w-0 flex-1",
              // 主题变量挂在画布区根上，使工具条/遮罩/空状态等浮层能取到 cv-* 反色
              dark ? "cv-theme-dark" : "cv-theme-light"
            )}
          >
          {/* 单图画布常驻：并排对比只是盖在它上面，退出时直接露出来。
              相机、测量索引、图层/聚焦状态都不重载，所以退出后与进入前完全一致。 */}
          <DxfCanvas
            key={`dxf-${activeId ?? "empty"}`}
            url={canvasUrl}
            focusKey={
              session?.focus ? `${session.focus.kind}:${session.focus.name}` : null
            }
            dark={dark}
            /* 布局页的坐标是纸张坐标，模型 contentBox 完全不适用 → 交给引擎按布局包围盒取景 */
            fitBox={
              activeSpace === MODEL_SPACE.id
                ? (file?.stats?.contentBox ?? null)
                : null
            }
            layoutMode={activeSpace !== MODEL_SPACE.id}
            resetKey={viewEpoch}
            onScale={setScale}
            onLayers={setDxfLayers}
            onStatus={setDxfStatus}
            layerVisibility={dxfLayerVisibility}
            onApi={(api) => {
              dxfApi.current = api;
              setViewerApi(api);
            }}
          />

          {/* 加载提示：解析过程中只在画布正中显示一枚轻量进度；完成后整体消失，
              不再在左下角常驻"就绪/图层数"之类的状态文字。 */}
          {!compareView && file && dxfStatus?.phase !== "done" && (
            <div
              className="pointer-events-none absolute inset-0 z-20 grid place-items-center"
              data-dxf-status={dxfStatus?.phase ?? "idle"}
            >
              <div
                className={cn(
                  "flex items-center gap-2 rounded-full border border-border/50 bg-card/90 px-3.5 py-2 text-xs shadow-sm backdrop-blur-sm",
                  dxfStatus?.phase === "error"
                    ? "text-destructive/90"
                    : "text-muted-foreground"
                )}
              >
                {dxfStatus?.phase === "error" ? (
                  <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
                ) : (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
                )}
                <span className="max-w-[70vw] truncate">
                  {dxfStatus?.phase === "error"
                    ? `渲染失败：${dxfStatus.error ?? "未知错误"}`
                    : dxfStatus
                      ? `加载中 · ${DX_PHASE_LABEL[dxfStatus.phase] ?? dxfStatus.phase} ${Math.round(dxfStatus.progress * 100)}%`
                      : "准备中"}
                </span>
              </div>
            </div>
          )}
          {/* 完成后的不可见标记：页面上没有状态文字，但保留 data-dxf-status="done"
              供既有验收脚本（test/*.mjs、Skill 文档）判断"已加载完"。 */}
          {!compareView && file && dxfStatus?.phase === "done" && (
            <span className="sr-only" data-dxf-status="done">
              {`${dxfLayers.length} 图层 · 就绪 ${dxfStatus.ms ?? 0}ms`}
            </span>
          )}

          {/* 单图叠加层：并排时全部收起（不会透到对比画布上），退出后原样出现 */}
          {!compareView && file && (
            <MeasureOverlay
              api={viewerApi}
              engine={measureEngine}
              tool={measureTool}
              measurements={measurements}
              dark={dark}
              unitLabel={measureEngine?.units.label ?? "未知"}
              clearNonce={measureClearNonce}
              onCommit={commitMeasurement}
              onRemove={removeMeasurement}
              onExit={() => setMeasureTool(null)}
            />
          )}

          {/* 并排对比：盖在单图画布上；退出即卸载，露出下面那张原封不动的画布 */}
          {compareView && compareBaseFile && compareTargetFile && (
            <CompareView
              base={compareBaseFile}
              target={compareTargetFile}
              dark={dark}
              changes={compareMatched ? compareChanges : []}
              dimBase={compareOnlyChanges}
              showDiff={compareShowDiff}
              selectedId={compareSelId}
              activeSetId={compareSetId}
              onApi={handleCompareApi}
              onToggleTheme={() => setDark((d) => !d)}
            />
          )}

          {/* ---------- 底部浮动 dock：空间页签 / 比对控制 /（测量 + 视图控制） ----------
              外列水平居中、自下向上生长；外层 pointer-events-none，只有控件自身接管指针。
              「测量」和「视图」是同一行上的两个独立容器：左测量、右视图，
              各自圆角/描边/模糊，中间只留间距——不合并成一个长 pill，也不拿分隔线串起来。
              模型/布局页签也在这一列里，位于工具条正上方（同一视觉带）。 */}
          <div
            data-canvas-dock="1"
            className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex flex-col items-center gap-2 px-3 @max-[760px]:bottom-12"
          >
            {/* 比对控制条：只在并排对比时出现（图例 / 显示差异 / 只看变更 /
                导航 / 清除）。退出并排后整条消失，单图不保留任何对比控件。 */}
            {showCompareToolbar && (
              <div
                data-compare-toolbar="1"
                className="pointer-events-auto flex max-w-full items-center gap-0.5 overflow-x-auto rounded-full border bg-card/95 p-1 shadow-sm backdrop-blur [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              >
                {showCompareDiff && (
                  <>
                    <div className="flex items-center gap-2.5 pl-1.5 pr-2">
                      {COMPARE_LEGEND.map((l) => (
                        <span
                          key={l.key}
                          className="flex items-center gap-1 text-[11px] text-muted-foreground"
                        >
                          <span
                            className="size-2 shrink-0 rounded-full"
                            style={{ backgroundColor: l.color }}
                          />
                          <span className="tabular-nums text-foreground/80">
                            {compare.result?.summary[l.key] ?? 0}
                          </span>
                          {l.label}
                        </span>
                      ))}
                    </div>
                    <Separator orientation="vertical" className="mx-0.5 h-6" />
                    <DockTooltip
                      content={
                        compareShowDiff
                          ? "隐藏画布上的差异"
                          : "显示画布上的差异"
                      }
                    >
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="rounded-full"
                        aria-label={compareShowDiff ? "隐藏差异" : "显示差异"}
                        aria-pressed={compareShowDiff}
                        onClick={() => setCompareShowDiff((v) => !v)}
                      >
                        {compareShowDiff ? <Eye /> : <EyeOff />}
                      </Button>
                    </DockTooltip>
                  </>
                )}

                {/* 只看变更（灰显其余）：纯 CSS 滤镜只作用于 canvas，叠加层保持彩色 */}
                <DockTooltip
                  content={
                    compareOnlyChanges
                      ? "只看变更（灰显其余）：未变更的图形灰显，改动保持彩色；点击恢复两侧彩色"
                      : "只看变更（灰显其余）：灰显未变更的图形，让改动跳出来"
                  }
                  wrapperClassName="ml-0.5 shrink-0"
                >
                  <Button
                    variant={compareOnlyChanges ? "secondary" : "ghost"}
                    size="icon-sm"
                    className="rounded-full"
                    aria-label="只看变更（灰显其余）"
                    aria-pressed={compareOnlyChanges}
                    onClick={() => setCompareOnlyChanges((v) => !v)}
                  >
                    <Focus />
                  </Button>
                </DockTooltip>

                {showCompareDiff && (
                  <>
                    <Separator orientation="vertical" className="mx-0.5 h-6" />
                    <DockTooltip content="上一处变更集">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="rounded-full"
                        aria-label="上一处变更集"
                        disabled={!orderedCompareSets.length}
                        onClick={() => gotoCompareSet(-1)}
                      >
                        <ChevronLeft />
                      </Button>
                    </DockTooltip>
                    <span className="min-w-9 text-center text-[11px] tabular-nums text-muted-foreground">
                      {compareSetIndex >= 0 ? compareSetIndex + 1 : "–"} /{" "}
                      {orderedCompareSets.length}
                    </span>
                    <DockTooltip content="下一处变更集">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="rounded-full"
                        aria-label="下一处变更集"
                        disabled={!orderedCompareSets.length}
                        onClick={() => gotoCompareSet(1)}
                      >
                        <ChevronRight />
                      </Button>
                    </DockTooltip>
                    <Separator orientation="vertical" className="mx-0.5 h-6" />
                    <DockTooltip content="清除比对结果（画布上的差异一起消失）">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="rounded-full"
                        aria-label="清除比对结果"
                        onClick={clearCompare}
                      >
                        <X />
                      </Button>
                    </DockTooltip>
                  </>
                )}

                {compareView && (
                  <>
                    <Separator orientation="vertical" className="mx-0.5 h-6" />
                    <DockTooltip content="退出并排对比（回到单图视图）">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="rounded-full"
                        aria-label="退出并排对比"
                        onClick={() => setCompareView(false)}
                      >
                        <PanelRightClose />
                      </Button>
                    </DockTooltip>
                  </>
                )}
              </div>
            )}

            {/* 并排模式：测量整组隐藏（两张画布的测量归属太容易混），
                每格标题条已有自己的缩放 / 取景，主题开关挂在右侧标题条。 */}

            {/* 测量操作提示已移到 MeasureToolbar 内部：锚定在激活按钮正上方 */}

            {/* 单行、两个独立容器：左测量 · 右视图，中间只留间距（并排模式隐藏） */}
            {!compareView && file && (
              <div
                data-dock-row="1"
                className="pointer-events-none relative flex w-full max-w-full items-center justify-center gap-2"
              >
                {/* 模型 / 布局页签：与「测量」工具条同一行、同一垂直中心，
                    贴画布左缘（绝对定位，不参与这一行的居中对齐计算）。 */}
                {spaces.length > 1 && (
                  <div className="pointer-events-auto absolute bottom-1 left-0">
                    <SpaceTabs
                      spaces={spaces}
                      active={activeSpace}
                      onSelect={switchSpace}
                    />
                  </div>
                )}
                {/* 测量容器：标尺标识 / 工具 / 清除 / 单位（胶囊形，自带描边与模糊） */}
                <div
                  data-dock-measure="1"
                  className="pointer-events-auto flex shrink-0 items-center rounded-full border bg-card/95 px-1.5 py-1 shadow-sm backdrop-blur"
                >
                  <MeasureToolbar
                    active={measureTool}
                    onSelect={(t) =>
                      setMeasureTool((cur) => (cur === t ? null : t))
                    }
                    onClear={clearMeasurements}
                    canMeasure={measureReady}
                    disabledTitle={measureDisabledTitle}
                    count={measurements.length}
                    units={
                      measureEngine
                        ? measureEngine.units.suffix || "无"
                        : undefined
                    }
                    unitTitle={
                      measureEngine
                        ? `单位：${measureEngine.units.label}${measureEngine.units.suffix ? `（${measureEngine.units.suffix}）` : ""}`
                        : "单位未知"
                    }
                  />
                </div>

                {/* 视图容器：缩小 / 百分比 / 放大 / 适应 / 全图 / 主题（同样独立胶囊） */}
                <div
                  data-dock-view="1"
                  className="pointer-events-auto flex shrink-0 items-center rounded-full border bg-card/95 px-1.5 py-1 shadow-sm backdrop-blur"
                >
                  <ViewToolbar
                    scaleRef={scaleRef}
                    onZoomIn={() => zoom(1.2)}
                    onZoomOut={() => zoom(1 / 1.2)}
                    onFit={fitCanvas}
                    fullView={!!session?.fullView}
                    onToggleFullView={() => {
                      if (!activeId) return;
                      const next = !session?.fullView;
                      setSessions((s) => {
                        const cur = s[activeId];
                        if (!cur) return s;
                        return {
                          ...s,
                          [activeId]: { ...cur, fullView: next },
                        };
                      });
                      // 没有 viewBox 可取，直接按"主体 / 全范围"重新取景
                      if (next) dxfApi.current?.fitAll();
                      else dxfApi.current?.fit();
                    }}
                    dark={dark}
                    onToggleTheme={() => setDark((d) => !d)}
                  />
                </div>
              </div>
            )}
          </div>

          {/* 加载遮罩 */}
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="cv-text flex flex-col items-center gap-3 rounded-2xl border cv-border cv-surface px-8 py-6 backdrop-blur-sm">
                <div className="h-7 w-7 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                <div className="space-y-1 text-center">
                  <div className="text-base font-medium">正在解析图纸…</div>
                  <div className="cv-text-muted text-xs opacity-75">
                    大图首次打开可能需要十几秒，之后打开会快很多
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 错误提示 */}
          {error && (
            <div className="absolute inset-x-4 top-4 z-20 flex items-start gap-2.5 rounded-2xl border border-destructive/40 bg-destructive/[0.07] px-3.5 py-2.5 text-xs text-destructive shadow-lg backdrop-blur">
              <TriangleAlert className="mt-px h-4 w-4 shrink-0" />
              <span className="flex-1 leading-relaxed">{error}</span>
              <DockTooltip content="关闭提示" wrapperClassName="shrink-0">
                <button
                  type="button"
                  className="shrink-0 rounded-full p-0.5 transition-colors hover:bg-destructive/10"
                  aria-label="关闭提示"
                  onClick={() => setError(null)}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </DockTooltip>
            </div>
          )}

          {/* 空状态：引导卡片（文字跟随画布明暗反转）
              顺序：带边框的「打开图纸」→ 操作提示 → 隐私说明。
              这里刻意用 outline 风格（有描边），和顶栏那个无边框的「打开图纸」区分开。 */}
          {!file && !loading && !compareView && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-8">
              <div
                className={cn(
                  "pointer-events-auto flex w-full max-w-md flex-col items-center gap-4 rounded-2xl border border-dashed px-8 py-10 text-center transition-all duration-200",
                  dragOver
                    ? "scale-[1.02] border-primary bg-primary/10"
                    : "cv-border cv-surface"
                )}
              >
                <Button
                  variant="outline"
                  size="lg"
                  className="cv-text gap-2 rounded-full border-[color-mix(in_oklab,var(--cv-line)_32%,transparent)] bg-transparent px-3 hover:bg-[color-mix(in_oklab,var(--cv-line)_10%,transparent)] hover:text-[var(--cv-fg)]"
                  onClick={pickFile}
                >
                  <FolderOpen />
                  打开图纸
                </Button>
                <div className="cv-text-muted text-sm leading-relaxed">
                  点击「打开图纸」选择文件，也可以把图纸直接拖进来
                </div>
                <div className="cv-text-muted flex items-center gap-1.5 text-xs opacity-85">
                  <ShieldCheck className="h-3 w-3" />
                  全程本地解析 · 不上传云端
                </div>
              </div>
            </div>
          )}

          {/* ---------- 浮动信息面板：贴标签栏下沿 / 画布右缘，浮在画布上 ----------
              头部是标题 + 关闭；下面是各分段自己的滚动区。
              只有面板本体接管指针，面板之外的画布照常可交互。 */}
          {panelOpen && (
            <div
              ref={panelRef}
              data-float-panel="1"
              role="dialog"
              aria-modal="false"
              aria-label={PANEL_TITLES[panelTab] ?? "信息面板"}
              className={cn(
                "absolute right-4 z-30 flex max-h-[calc(100%-2rem)] w-[400px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl bg-card shadow-2xl",
                // 并排时把面板让到两格标题条下面：面板仍浮在右侧画布上，
                // 但「同步显示 / 主题 / 这一格的缩放」不会被整个盖住
                compareView ? "top-12" : "top-4"
              )}
              style={{
                height: compareView ? "calc(100% - 3.5rem)" : PANEL_MAX_H,
              }}
            >
              <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 px-5 py-3">
                <div className="text-sm font-semibold tracking-tight">
                  {PANEL_TITLES[panelTab] ?? "信息"}
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="rounded-full text-muted-foreground"
                  aria-label="关闭信息面板"
                  onClick={() => closePanel(true)}
                >
                  <X className="size-4" />
                </Button>
              </div>

              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                {panelTab === "overview" &&
                  (file ? (
                    <OverviewTab file={file} />
                  ) : (
                    <EmptyHint
                      icon={<FileDigit className="h-6 w-6" />}
                      text="打开图纸后显示文件与实体统计"
                    />
                  ))}

                {panelTab === "layers" &&
                  (session?.file.stats ? (
                    <LayersTab
                      layers={visibleLayers}
                      visibleMap={session.visibleMap}
                      onToggleLayer={toggleLayer}
                      availableLayers={availableLayers}
                      hiddenEmptyCount={hiddenEmptyCount}
                      focus={session.focus}
                      onSetFocus={setFocus}
                      onClearFocus={clearFocus}
                    />
                  ) : (
                    <EmptyHint
                      icon={<Layers className="h-6 w-6" />}
                      text="打开图纸后显示图层信息"
                    />
                  ))}

                {panelTab === "blocks" &&
                  (file?.stats ? (
                    <BlocksTab
                      blocks={file.stats.blocks}
                      focus={session?.focus ?? null}
                      onSetFocus={setFocus}
                      onClearFocus={clearFocus}
                    />
                  ) : (
                    <EmptyHint
                      icon={<Boxes className="h-6 w-6" />}
                      text="打开图纸后显示图块统计"
                    />
                  ))}

                {panelTab === "compare" && (
                  <ComparePanel
                    state={compare}
                    changes={compareChanges}
                    tabs={tabs.map((id) => {
                      const s = sessions[id];
                      return {
                        id,
                        name: s?.file.name ?? id,
                        format: s?.file.format ?? "?",
                      };
                    })}
                    active={panelOpen && panelTab === "compare"}
                    filter={compareFilter}
                    selectedId={compareSelId}
                    activeSetId={compareSetId}
                    onBaseChange={(id) =>
                      setCompare((c) => ({ ...c, baseId: id }))
                    }
                    onTargetChange={(id) =>
                      setCompare((c) => ({ ...c, targetId: id }))
                    }
                    onOptionsChange={changeCompareOptions}
                    onRun={runCompare}
                    onClear={clearCompare}
                    onDismissError={() =>
                      setCompare((c) => ({ ...c, error: null }))
                    }
                    onOpenFile={openCompareFile}
                    onFilterChange={setCompareFilter}
                    onSelect={setCompareSelId}
                    onLocateChange={locateCompareChange}
                    onLocateSet={locateCompareSet}
                    onActivateSet={setCompareSetId}
                    compareView={compareView}
                    onToggleCompareView={toggleCompareView}
                    onExportReport={exportCompareReport}
                    reportAvailable={compareMatched}
                  />
                )}
              </div>
            </div>
          )}
          </main>
        </div>
      </div>

      {/* 拖拽高亮 */}
      {dragOver && (
        <div className="pointer-events-none absolute inset-2 z-50 rounded-2xl border-2 border-dashed border-primary bg-primary/[0.06]" />
      )}
    </div>
  );
}

function EmptyHint({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-dashed bg-muted/40 text-muted-foreground/70">
        {icon}
      </div>
      <div className="max-w-56 text-xs leading-relaxed text-muted-foreground">
        {text}
      </div>
    </div>
  );
}

/**
 * 导出菜单项。整行可点，右侧一两个字说明导出的内容；图标只做区分，不做装饰。
 * 标题挂在外层 span：禁用时按钮是 pointer-events-none，只有外层还能收到 hover。
 */
function ExportMenuItem({
  icon,
  label,
  note,
  title,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  note: string;
  title: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <span className="block" role="none">
      <DockTooltip content={title} wrapperClassName="block">
        <button
          type="button"
          role="menuitem"
          disabled={disabled}
          onClick={onClick}
          className={cn(
            "flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-sm transition-colors outline-hidden",
            "hover:bg-muted focus-visible:bg-muted disabled:pointer-events-none disabled:opacity-50",
            "[&_svg]:size-3.5 [&_svg]:shrink-0"
          )}
        >
          <span className="text-muted-foreground">{icon}</span>
          <span className="font-medium">{label}</span>
          <span className="ml-auto truncate text-xs text-muted-foreground">
            {note}
          </span>
        </button>
      </DockTooltip>
    </span>
  );
}
