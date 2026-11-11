/**
 * 并排对比视图：基准图 / 对比图各占一半，两张独立的 WebGL 画布。
 *
 * 和单图视图的关系：
 *   · 单图视图（App 里那张 DxfCanvas）是默认形态，本组件只在用户点「并排对比」时挂载；
 *   · 退出即卸载，单图视图重新挂载并回到适应窗口。
 *
 * 两侧完全独立：各自的 DxfApi、各自的相机、各自的差异叠加层。唯一的联系是
 * 「同步显示」——打开后把一侧的**视图中心 + 可见宽度**（图纸 WCS）写给另一侧。
 *
 * 同步的回声守卫：
 *   dxf-viewer 的 SetView() 会同步派发 viewChanged，所以写入另一侧的瞬间就会回调到
 *   我们自己的订阅里。这里用 `applyingRef` 在写入期间忽略一切 viewChanged；
 *   另外再用「数值已经一样」做第二道保险（异步的 controls change 也拦得住）。
 *   两道守卫都不依赖计时器，不会吞掉用户紧接着的真实拖动。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Boxes,
  Link2,
  Link2Off,
  Maximize2,
  Minus,
  Moon,
  Plus,
  Sun,
  TriangleAlert,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import ChangeOverlay from "@/components/ChangeOverlay";
import DockTooltip from "@/components/DockTooltip";
import DxfCanvas, {
  type DxfApi,
  type DxfLayer,
  type DxfStatus,
} from "@/components/DxfCanvas";
import { cn } from "@/lib/utils";
import type { CompareChange } from "@/types";

/** 一格画布要画哪张图（App 从会话 / 比对结果里拼出来） */
export type ComparePaneFile = {
  id: string;
  name: string;
  format: string;
  /** 拼进 `/api/file/:id/dxf?v=` 的缓存失效键；未知时 0 */
  dxfVersion: number;
  /** 默认取景盒（主体范围 contentBox）；不知道时退回引擎自己的全范围 */
  fitBox: { minX: number; minY: number; maxX: number; maxY: number } | null;
};

export type CompareSide = "base" | "target";

type View = { centerX: number; centerY: number; width: number };

type Props = {
  base: ComparePaneFile;
  target: ComparePaneFile;
  dark: boolean;
  /** 已按类型/种类筛选过的变更（两侧叠加层各自分流） */
  changes: CompareChange[];
  /** 底图灰显：未修改的图形压暗，改动更跳（只作用于 canvas，叠加层保持原色） */
  dimBase: boolean;
  showDiff: boolean;
  selectedId: number | null;
  activeSetId: number | null;
  /** 把每一侧的 DxfApi 交给 App（「定位」要把两张画布一起框过去） */
  onApi: (side: CompareSide, api: DxfApi | null) => void;
  /** 画布底色主题（两侧共用一个开关，放在右侧标题条） */
  onToggleTheme: () => void;
};

const SIDE_LABEL: Record<CompareSide, string> = {
  base: "基准图",
  target: "对比图",
};

const PHASE_LABEL: Record<string, string> = {
  font: "字体",
  fetch: "获取",
  parse: "解析",
  prepare: "准备",
};

/** 两个视图是否已经一致（相对误差 1e-6，远小于验收要求的 0.5%） */
function sameView(a: View, b: View): boolean {
  const tol = Math.max(1, Math.abs(a.width), Math.abs(b.width)) * 1e-6;
  return (
    Math.abs(a.centerX - b.centerX) <= tol &&
    Math.abs(a.centerY - b.centerY) <= tol &&
    Math.abs(a.width - b.width) <= tol
  );
}

export default function CompareView({
  base,
  target,
  dark,
  changes,
  dimBase,
  showDiff,
  selectedId,
  activeSetId,
  onApi,
  onToggleTheme,
}: Props) {
  const apiRefs = useRef<Record<CompareSide, DxfApi | null>>({
    base: null,
    target: null,
  });
  const unsubsRef = useRef<Partial<Record<CompareSide, () => void>>>({});
  /** 两侧是否都完成了首次取景：没就绪时不搬运视图，免得加载中的自动 fit 抢走另一侧 */
  const readyRef = useRef<Record<CompareSide, boolean>>({
    base: false,
    target: false,
  });
  /** 同步显示（默认关） */
  const [sync, setSync] = useState(false);
  const syncRef = useRef(false);
  /** 最后被点过的那一格：只做焦点环，底部 dock 在并排模式下不镜像测量 */
  const [focused, setFocused] = useState<CompareSide>("base");
  /** 程序化 setView 期间为 true：忽略由此产生的 viewChanged 回声 */
  const applyingRef = useRef(false);

  /**
   * 把 `from` 一侧的视图写给另一侧。
   * @returns 是否真的写入了（源/目标未就绪、数值已一致时返回 false）
   */
  const pushView = useCallback((from: CompareSide, force = false): boolean => {
    const to: CompareSide = from === "base" ? "target" : "base";
    const src = apiRefs.current[from];
    const dst = apiRefs.current[to];
    if (!src?.getView || !dst?.setView) return false;
    // 两侧都完成首次取景前不搬视图：加载过程中的自动 fit 不能抢走另一侧
    if (!readyRef.current.base || !readyRef.current.target) return false;
    // 回声守卫（SetView 同步派发 viewChanged）
    if (applyingRef.current && !force) return false;

    const v = src.getView();
    if (!v) return false;

    // 数值守卫：已经是同一个视图就不用再写一遍（异步回声也走这里）
    const cur = dst.getView?.();
    if (cur && sameView(cur, v)) return true;

    applyingRef.current = true;
    try {
      dst.setView(v.centerX, v.centerY, v.width);
    } finally {
      applyingRef.current = false;
    }
    return true;
  }, []);

  const syncFrom = useCallback(
    (side: CompareSide) => {
      if (!syncRef.current) return;
      pushView(side);
    },
    [pushView]
  );

  const toggleSync = useCallback(() => {
    const next = !syncRef.current;
    syncRef.current = next;
    setSync(next);
    // 打开同步立刻对齐一次：右侧采纳左侧当前视图（未就绪时等 handleReady 再对齐）
    if (next) pushView("base", true);
  }, [pushView]);

  /** 一侧就绪 / 重新加载：两侧都就绪且同步开着时，统一对齐到基准图 */
  const handleReady = useCallback(
    (side: CompareSide, ready: boolean) => {
      readyRef.current[side] = ready;
      if (
        ready &&
        syncRef.current &&
        readyRef.current.base &&
        readyRef.current.target
      ) {
        pushView("base", true);
      }
    },
    [pushView]
  );

  /** 子画布挂载/卸载：记 api，并订阅视图变化（同步的驱动源） */
  const handleApi = useCallback(
    (side: CompareSide, api: DxfApi | null) => {
      apiRefs.current[side] = api;
      if (!api) readyRef.current[side] = false;
      unsubsRef.current[side]?.();
      delete unsubsRef.current[side];
      if (api?.onViewChange) {
        unsubsRef.current[side] = api.onViewChange(() => syncFrom(side));
      }
      onApi(side, api);
    },
    [onApi, syncFrom]
  );

  useEffect(() => {
    return () => {
      unsubsRef.current.base?.();
      unsubsRef.current.target?.();
      unsubsRef.current = {};
    };
  }, []);

  /**
   * 验收/排查挂钩（只读）：DxfCanvas 自己会把最后挂载的 viewer 写到 `window.__dxfViewer`，
   * 两张画布会互相覆盖，所以这里单独给一个能同时读到两侧相机的出口。
   */
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__compareView = {
      getViews: () => ({
        base: apiRefs.current.base?.getView?.() ?? null,
        target: apiRefs.current.target?.getView?.() ?? null,
      }),
      isSync: () => syncRef.current,
    };
    return () => {
      delete w.__compareView;
    };
  }, []);

  return (
    <div
      data-compare-view="1"
      data-compare-sync={sync ? "1" : "0"}
      // 不透明底 + 叠在常驻单图画布之上：退出时整层卸载，直接露出原画布
      className="absolute inset-0 z-10 flex gap-2 bg-background p-2"
    >
      <ComparePane
        side="base"
        file={base}
        dark={dark}
        focused={focused === "base"}
        onFocus={() => setFocused("base")}
        changes={changes}
        dimBase={dimBase}
        showDiff={showDiff}
        selectedId={selectedId}
        activeSetId={activeSetId}
        onApi={handleApi}
        onReady={handleReady}
      />
      <ComparePane
        side="target"
        file={target}
        dark={dark}
        focused={focused === "target"}
        onFocus={() => setFocused("target")}
        changes={changes}
        dimBase={dimBase}
        showDiff={showDiff}
        selectedId={selectedId}
        activeSetId={activeSetId}
        onApi={handleApi}
        onReady={handleReady}
        sync={sync}
        onToggleSync={toggleSync}
        onToggleTheme={onToggleTheme}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 单格：标题条 + 画布 + 叠加层 + 自己的缩放/取景                       */
/* ------------------------------------------------------------------ */

function ComparePane({
  side,
  file,
  dark,
  focused,
  onFocus,
  changes,
  dimBase,
  showDiff,
  selectedId,
  activeSetId,
  onApi,
  onReady,
  sync = false,
  onToggleSync,
  onToggleTheme,
}: {
  side: CompareSide;
  file: ComparePaneFile;
  dark: boolean;
  focused: boolean;
  onFocus: () => void;
  changes: CompareChange[];
  dimBase: boolean;
  showDiff: boolean;
  selectedId: number | null;
  activeSetId: number | null;
  onApi: (side: CompareSide, api: DxfApi | null) => void;
  onReady: (side: CompareSide, ready: boolean) => void;
  sync?: boolean;
  onToggleSync?: () => void;
  onToggleTheme?: () => void;
}) {
  const [api, setApi] = useState<DxfApi | null>(null);
  const [status, setStatus] = useState<DxfStatus | null>(null);
  const [layers, setLayers] = useState<DxfLayer[]>([]);
  /** 百分比文本直写，避免手势里 setState 带着整块面板重渲染（同 App 的做法） */
  const scaleEl = useRef<HTMLSpanElement | null>(null);

  // 换图：这一格的加载状态从零开始（DxfCanvas 由 key 保证重建）。
  // 用 ref 记住上次的图，避免首次挂载时（父 effect 晚于子 effect）把已经上报的「加载中」清掉。
  const fileIdRef = useRef(file.id);
  useEffect(() => {
    if (fileIdRef.current === file.id) return;
    fileIdRef.current = file.id;
    setStatus(null);
    setLayers([]);
    onReady(side, false);
  }, [file.id, onReady, side]);

  const handleApi = useCallback(
    (next: DxfApi | null) => {
      setApi(next);
      onApi(side, next);
    },
    [onApi, side]
  );

  const handleStatus = useCallback(
    (next: DxfStatus) => {
      setStatus(next);
      onReady(side, next.phase === "done");
    },
    [onReady, side]
  );

  const handleScale = useCallback((pct: number) => {
    if (scaleEl.current) scaleEl.current.textContent = `${Math.round(pct)}%`;
  }, []);

  /* 灰显走服务端实体级 mute（和双击图层/块时其余变灰同一套逻辑），不再给画布盖 CSS 滤镜：
   * 滤镜会把背景/文字一起压灰，看起来像蒙版。 */
  const url = `/api/file/${encodeURIComponent(file.id)}/dxf?v=${file.dxfVersion}${
    dimBase ? "&focus=mute:all" : ""
  }`;
  const loading =
    !!status && status.phase !== "done" && status.phase !== "error";
  const failed = status?.phase === "error";

  return (
    <div
      data-compare-pane={side}
      onPointerDownCapture={onFocus}
      className={cn(
        "relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl bg-card transition-shadow duration-150",
        focused
          ? "ring-2 ring-primary/55 ring-offset-1 ring-offset-background"
          : "ring-1 ring-border/60"
      )}
    >
      {/* ---- 标题条：名称 + 这一格自己的缩放/取景；右侧画布多一个同步开关 ---- */}
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b bg-card px-2 text-card-foreground">
        <DockTooltip
          content={
            side === "base"
              ? "基准图：差异里的删除 / 修改旧侧"
              : "对比图：差异里的新增 / 修改新侧"
          }
          wrapperClassName="shrink-0"
        >
          <span className="rounded-full border border-border/70 px-1.5 text-[10px] leading-4 text-muted-foreground">
            {SIDE_LABEL[side]}
          </span>
        </DockTooltip>
        <span
          className="min-w-0 flex-1 truncate text-xs font-medium"
          title={file.name}
        >
          {file.name || file.id.slice(0, 8)}
        </span>
        {file.format && (
          <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground/70">
            {file.format}
          </span>
        )}

        <div className="flex shrink-0 items-center">
          <DockTooltip content="缩小（只作用于这一侧）">
            <Button
              variant="ghost"
              size="icon-xs"
              className="rounded-full text-muted-foreground"
              aria-label="缩小（只作用于这一侧）"
              disabled={!api}
              onClick={() => api?.zoomBy(1 / 1.2)}
            >
              <Minus />
            </Button>
          </DockTooltip>
          <DockTooltip content="适应窗口（只作用于这一侧）">
            <button
              type="button"
              className="flex h-6 min-w-10 items-center justify-center rounded-full px-1 text-[11px] tabular-nums text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none"
              aria-label="适应窗口（只作用于这一侧）"
              disabled={!api}
              onClick={() => api?.fit()}
            >
              <span ref={scaleEl} className="tabular-nums">
                100%
              </span>
            </button>
          </DockTooltip>
          <DockTooltip content="放大（只作用于这一侧）">
            <Button
              variant="ghost"
              size="icon-xs"
              className="rounded-full text-muted-foreground"
              aria-label="放大（只作用于这一侧）"
              disabled={!api}
              onClick={() => api?.zoomBy(1.2)}
            >
              <Plus />
            </Button>
          </DockTooltip>
          <DockTooltip content="适应窗口（只作用于这一侧）">
            <Button
              variant="ghost"
              size="icon-xs"
              className="rounded-full text-muted-foreground"
              aria-label="适应窗口（只作用于这一侧）"
              disabled={!api}
              onClick={() => api?.fit()}
            >
              <Maximize2 />
            </Button>
          </DockTooltip>
        </div>

        {/* 画布底色：两侧共用一个主题，开关只放一份（右侧标题条） */}
        {side === "target" && onToggleTheme && (
          <DockTooltip
            content={dark ? "切换浅色画布" : "切换深色画布"}
            wrapperClassName="shrink-0"
          >
            <Button
              variant="ghost"
              size="icon-xs"
              className="rounded-full text-muted-foreground"
              aria-label={dark ? "切换浅色画布" : "切换深色画布"}
              onClick={onToggleTheme}
            >
              {dark ? <Sun /> : <Moon />}
            </Button>
          </DockTooltip>
        )}

        {/* 同步显示：只挂在右侧画布的右上角，默认关 */}
        {side === "target" && onToggleSync && (
          <DockTooltip
            wrapperClassName="ml-0.5 shrink-0"
            content={
              sync
                ? "同步显示已开：拖动 / 缩放任一侧，另一侧跟随"
                : "同步显示：两侧保持同一视图中心与可见宽度"
            }
          >
            <button
              type="button"
              aria-pressed={sync}
              aria-label="同步显示"
              onClick={onToggleSync}
              className={cn(
                "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11px] transition-colors",
                sync
                  ? "border-transparent bg-primary text-primary-foreground shadow-xs hover:bg-primary/90"
                  : "border-border/70 text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
            >
              {sync ? (
                <Link2 className="size-3" aria-hidden />
              ) : (
                <Link2Off className="size-3" aria-hidden />
              )}
              同步显示
            </button>
          </DockTooltip>
        )}
      </div>

      {/* ---- 画布本体 ---- */}
      <div className="relative min-h-0 flex-1">
        {/* 底图灰显：由服务端 `focus=mute:all` 把实体颜色改成 ACI 8（与双击图层/块时
            其余变灰同一套逻辑），不再用 CSS 滤镜把整张画布（含背景）压灰。
            dimBase 切换时 key 变化 → 重新加载对应的灰/彩变体。 */}
        <div className="absolute inset-0" data-compare-canvas-dim={dimBase ? "1" : "0"}>
          <DxfCanvas
            key={`${side}-${file.id}-${dimBase ? "dim" : "full"}`}
            url={url}
            dark={dark}
            fitBox={file.fitBox}
            focusKey={null}
            onScale={handleScale}
            onLayers={setLayers}
            onStatus={handleStatus}
            onApi={handleApi}
          />
        </div>

        {/* 差异叠加层：左边只画删除 + 修改旧侧，右边只画新增 + 修改新侧 */}
        <ChangeOverlay
          api={api}
          changes={changes}
          side={side}
          hidden={!showDiff || status?.phase !== "done"}
          selectedId={selectedId}
          activeSetId={activeSetId}
        />

        {/* 加载中：只在画布中央报阶段，不挡操作 */}
        {loading && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            <div className="cv-text flex items-center gap-2 rounded-full border cv-border cv-surface px-3 py-1.5 text-xs backdrop-blur-sm">
              <span className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent opacity-70" />
              {PHASE_LABEL[status.phase] ?? status.phase}{" "}
              {Math.round(status.progress * 100)}%
            </div>
          </div>
        )}

        {/* 渲染失败：一张失败不该把另一张也拖黑 */}
        {failed && (
          <div className="absolute inset-x-3 top-3 z-10 flex items-start gap-2 rounded-lg border border-destructive/40 bg-card/95 px-2.5 py-2 text-[11px] leading-relaxed text-destructive shadow-sm backdrop-blur">
            <TriangleAlert className="mt-px size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 break-words">
              {status?.error || "渲染失败"}
            </span>
          </div>
        )}

        {/* 就绪徽标：和单图视图同一套措辞，贴在这一格左下角 */}
        {status?.phase === "done" && (
          <div className="pointer-events-none absolute bottom-2 left-2 z-10">
            <Badge
              variant="outline"
              className="h-5 gap-1 rounded-full border-transparent bg-card/75 px-2 py-0 text-[10px] font-normal text-muted-foreground shadow-xs backdrop-blur-sm"
              data-dxf-status="done"
            >
              <Boxes className="size-2.5 opacity-60" aria-hidden />
              {layers.length} 图层 · 就绪 {status.ms ?? 0}ms
            </Badge>
          </div>
        )}
      </div>
    </div>
  );
}

