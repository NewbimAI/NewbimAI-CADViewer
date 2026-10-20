import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Boxes,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileCode,
  FileDigit,
  FileJson,
  FileText,
  Image,
  Layers,
  Loader2,
  Maximize2,
  Minus,
  Moon,
  Plus,
  ScanSearch,
  ShieldCheck,
  Sun,
  TriangleAlert,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { openByPath, openByUpload } from "@/api";
import {
  downloadJson,
  downloadPdf,
  downloadPng,
  downloadRawDxf,
} from "@/lib/export";
import type { DxfFocus, OpenResult } from "@/types";
import DxfCanvas, {
  type DxfApi,
  type DxfLayer,
  type DxfStatus,
} from "@/components/DxfCanvas";
import { Logo } from "@/components/Logo";
import OverviewTab from "@/components/tabs/OverviewTab";
import LayersTab from "@/components/tabs/LayersTab";
import BlocksTab from "@/components/tabs/BlocksTab";

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
}

function newSession(file: OpenResult): Session {
  return {
    file,
    visibleMap: Object.fromEntries(
      (file.stats?.layers ?? []).map((l) => [l.name, true])
    ),
    fullView: false,
    focus: null,
  };
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
  const [showPanel, setShowPanel] = useState(true);
  /** 缩放百分比（100% = 适应窗口）。⚠️ 刻意用 ref 直写文本而不是 state：
   *  画布在手势中会连续上报，setState 会让整棵树（面板/图层/图块表）跟着重渲染，
   *  实测把缩放帧间隔从 16.7ms 拖到 50ms（60fps → 20fps）。这里只影响一个数字文本。 */
  const scaleRef = useRef<HTMLSpanElement>(null);
  const setScale = useCallback((v: number) => {
    const el = scaleRef.current;
    if (el) el.textContent = `${Math.round(v)}%`;
  }, []);
  const [dragOver, setDragOver] = useState(false);

  const session = activeId ? (sessions[activeId] ?? null) : null;
  const file = session?.file ?? null;

  const fileInputRef = useRef<HTMLInputElement>(null);
  /** WebGL 引擎（dxf-viewer）的操作句柄与状态 */
  const dxfApi = useRef<DxfApi | null>(null);
  const [dxfStatus, setDxfStatus] = useState<DxfStatus | null>(null);
  const [dxfLayers, setDxfLayers] = useState<DxfLayer[]>([]);
  /** 每次打开图纸 +1，用于强制画布回到"适应窗口"（同一张图重开也要复位） */
  const [viewEpoch, setViewEpoch] = useState(0);

  const openFile = useCallback(async (open: () => Promise<OpenResult>) => {
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
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  /** 关闭 tab：移除会话；若关闭的是当前 tab 则激活相邻的 */
  const closeTab = useCallback(
    (id: string) => {
      const idx = tabs.indexOf(id);
      const next = tabs.filter((x) => x !== id);
      setTabs(next);
      setSessions((s) => {
        if (!(id in s)) return s;
        const { [id]: _drop, ...rest } = s;
        return rest;
      });
      if (activeId === id) {
        setActiveId(next[Math.min(idx, next.length - 1)] ?? null);
      }
    },
    [tabs, activeId]
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

  const handleUpload = (f: File) => {
    const ext = f.name.toLowerCase().split(".").pop();
    if (ext !== "dwg" && ext !== "dxf") {
      setError(`不支持的格式 .${ext}，仅支持 DWG / DXF`);
      return;
    }
    openFile(() => openByUpload(f));
  };

  const pickFile = () => fileInputRef.current?.click();

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
    for (const l of dxfLayers) map[l.name] = session?.visibleMap?.[l.name] ?? true;
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
   *
   * ⚠️ 不能只看 stats.layers[].entityCount：scanner 只统计模型空间/图纸空间的实体，
   *    不统计**块定义内部**的实体（scanner.js 的 inBlockDef 分支只累加 blocks）。
   *    于是"只在块里用到"的图层（例如块内容画在 LAYER_C / LAYER_A 层上）也显示 0，
   *    但它确实会画出来 —— 只看 entityCount 会把它误隐藏。
   *    所以再加一条：画布引擎的非空图层表（GetLayers(true)）里有它 → 保留。
   *    引擎图层表还没到（dxfLayers 为空）时先不过滤，避免列表先缩后涨闪一下。
   */
  const visibleLayers = useMemo(() => {
    const all = session?.file.stats?.layers ?? [];
    if (!dxfLayers.length) return all;
    return all.filter((l) => l.entityCount > 0 || availableLayers.has(l.name));
  }, [session?.file.stats?.layers, dxfLayers.length, availableLayers]);

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
          品牌靠左，操作区 ml-auto 右对齐：打开图纸 + 导出（二级菜单）。
          导出面板是悬停容器的子元素，控件之间用面板自身的 pt 做桥接，
          鼠标从按钮移向面板时不会离开容器，因此不闪断。 */}
      <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-card px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <Logo className="h-7 w-7 shrink-0 text-foreground" />
          <div className="flex min-w-0 items-baseline gap-2 whitespace-nowrap">
            <span className="shrink-0 text-base font-semibold tracking-tight">
              CADViewer
            </span>
            <span className="shrink-0 text-muted-foreground/50">|</span>
            <span
              className="min-w-0 truncate text-sm text-muted-foreground"
              title="DWG / DXF 本地预览与统计"
            >
              DWG / DXF 本地预览与统计
            </span>
          </div>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button size="lg" className="gap-1.5 shadow-xs" onClick={pickFile}>
            <ArrowDownToLine />
            打开图纸
          </Button>

          {/* 「导出」+ 二级菜单：触发按钮与面板同属一个 hover/focus 容器 */}
          <div
            className="relative"
            title={pdfBusy ? "正在生成 PDF…" : undefined}
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
            <Button
              size="lg"
              variant="outline"
              className={cn(
                "gap-1.5",
                // 生成中：转圈顶到最外层按钮上，这样菜单收起也看得见"正在进行"
                pdfBusy && "shadow-xs",
                exportError && "border-destructive/50 text-destructive"
              )}
              disabled={pdfBusy}
              title={
                pdfBusy
                  ? "正在生成 PDF…"
                  : "导出 PNG / JSON / DXF / PDF"
              }
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
                className="w-56 rounded-lg border bg-card p-1 shadow-lg"
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
                className="absolute right-0 top-full z-50 mt-3 flex w-max max-w-[min(26rem,calc(100vw_-_2rem))] items-start gap-2 rounded-lg border border-destructive/40 bg-card px-3 py-2 text-xs text-destructive shadow-lg"
              >
                <TriangleAlert className="mt-px size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 leading-relaxed">
                  {exportError}
                </span>
                <button
                  type="button"
                  className="shrink-0 rounded p-0.5 transition-colors hover:bg-destructive/10"
                  title="关闭"
                  onClick={() => setExportError(null)}
                >
                  <X className="size-3.5" />
                </button>
              </div>
            )}
          </div>

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
      </header>

      <div className="flex min-h-0 flex-1">
        {/* ---------- 画布区 ---------- */}
        <main
          className={cn(
            "relative min-w-0 flex-1",
            // 主题变量挂在画布区根上，使工具条/遮罩/空状态等浮层能取到 cv-* 反色
            dark ? "cv-theme-dark" : "cv-theme-light"
          )}
        >
          <DxfCanvas
            key={`dxf-${activeId ?? "empty"}`}
            url={
              file
                ? `/api/file/${file.id}/dxf?v=${file.dxfVersion}${
                    session?.focus
                      ? `&focus=${encodeURIComponent(`${session.focus.kind}:${session.focus.name}`)}`
                      : ""
                  }`
                : null
            }
            focusKey={
              session?.focus ? `${session.focus.kind}:${session.focus.name}` : null
            }
            dark={dark}
            fitBox={file?.stats?.contentBox ?? null}
            resetKey={viewEpoch}
            onScale={setScale}
            onLayers={setDxfLayers}
            onStatus={setDxfStatus}
            layerVisibility={dxfLayerVisibility}
            onApi={(api) => (dxfApi.current = api)}
          />

          {/* ---------- 图纸 tab（悬浮在视口上方，从左到右） ---------- */}
          {tabs.length > 0 && (
            <div className="absolute left-3 top-3 z-20 flex max-w-[75%] items-center gap-1.5">
              {tabs.map((id) => {
                const s = sessions[id];
                if (!s) return null;
                const active = id === activeId;
                return (
                  <div
                    key={id}
                    onClick={() => setActiveId(id)}
                    className={cn(
                      "group flex h-9 min-w-0 max-w-64 cursor-pointer items-center gap-2 rounded-2xl border px-3.5 text-sm shadow-sm backdrop-blur transition-colors",
                      active
                        ? "border-border bg-card font-medium text-foreground"
                        : "border-transparent bg-card/70 text-muted-foreground hover:bg-card hover:text-foreground"
                    )}
                  >
                    <Badge
                      variant="secondary"
                      className="h-5 shrink-0 px-1.5 text-xs font-semibold"
                    >
                      {s.file.format}
                    </Badge>
                    <span
                      className="min-w-0 flex-1 truncate text-xs"
                      title={s.file.name}
                    >
                      {s.file.name}
                    </span>
                    <button
                      className="-mr-1 shrink-0 rounded p-0.5 text-muted-foreground/70 transition-colors hover:bg-foreground/10 hover:text-foreground"
                      title="关闭后可再次打开"
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTab(id);
                      }}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {/* 渲染状态徽标：加载阶段/耗时/实体规模，都要能看见，
              否则"为什么还没出来"会被当成丢图。 */}
          {file && (
            <div className="pointer-events-none absolute bottom-3 left-3 z-20">
              <Badge
                variant="outline"
                className="gap-1.5 border-border bg-card/90 py-1 text-[11px] font-normal shadow-sm backdrop-blur"
                data-dxf-status={dxfStatus?.phase ?? "idle"}
              >
                <Boxes className="h-3 w-3" />
                {dxfStatus?.phase === "error"
                  ? `渲染失败：${dxfStatus.error ?? "未知错误"}`
                  : dxfStatus?.phase === "done"
                    ? `${dxfLayers.length} 图层 · 就绪 ${dxfStatus.ms ?? 0}ms`
                    : dxfStatus
                      ? `加载中 · ${DX_PHASE_LABEL[dxfStatus.phase] ?? dxfStatus.phase} ${Math.round(dxfStatus.progress * 100)}%`
                      : "准备中"}
              </Badge>
            </div>
          )}

          {/* 画布工具条：贴左缘竖排（无图纸时隐藏） */}
          {file && (
            <div className="absolute left-3 top-1/2 flex -translate-y-1/2 flex-col items-center gap-0.5 rounded-2xl border bg-card/95 p-1.5 shadow-sm backdrop-blur">
              <Button
                variant="ghost"
                size="icon-sm"
                title="缩小"
                onClick={() => zoom(1 / 1.2)}
              >
                <Minus />
              </Button>
              <button
                className="flex h-8 min-w-9 items-center justify-center rounded-md px-1 text-xs tabular-nums text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                title="适应窗口（双击画布 / F 键）"
                onClick={fitCanvas}
              >
                <span ref={scaleRef} className="tabular-nums">
                  100%
                </span>
              </button>
              <Button
                variant="ghost"
                size="icon-sm"
                title="放大"
                onClick={() => zoom(1.2)}
              >
                <Plus />
              </Button>
              <Separator orientation="horizontal" className="my-0.5 w-6!" />
              <Button
                variant="ghost"
                size="icon-sm"
                title="适应窗口（双击画布 / F 键）"
                onClick={fitCanvas}
              >
                <Maximize2 />
              </Button>
              <Button
                variant={session?.fullView ? "default" : "ghost"}
                size="icon-sm"
                title="全图视图：显示图框、幕墙延伸等主体范围外的内容"
                onClick={() => {
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
              >
                <ScanSearch />
              </Button>
              <Separator orientation="horizontal" className="my-0.5 w-6!" />
              <Button
                variant="ghost"
                size="icon-sm"
                title={dark ? "切换浅色画布" : "切换深色画布"}
                onClick={() => setDark((d) => !d)}
              >
                {dark ? <Sun /> : <Moon />}
              </Button>
            </div>
          )}

          {/* 加载遮罩 */}
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="cv-text flex flex-col items-center gap-3 rounded-xl border cv-border cv-surface px-8 py-6 backdrop-blur-sm">
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
            <div className="absolute inset-x-4 top-4 z-20 flex items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/[0.07] px-3.5 py-2.5 text-xs text-destructive shadow-lg backdrop-blur">
              <TriangleAlert className="mt-px h-4 w-4 shrink-0" />
              <span className="flex-1 leading-relaxed">{error}</span>
              <button
                className="shrink-0 rounded p-0.5 transition-colors hover:bg-destructive/10"
                title="关闭"
                onClick={() => setError(null)}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {/* 空状态：引导卡片（文字跟随画布明暗反转） */}
          {!file && !loading && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-8">
              <div
                className={cn(
                  "pointer-events-auto flex w-full max-w-md flex-col items-center gap-5 rounded-xl border border-dashed px-8 py-10 text-center transition-all duration-200",
                  dragOver
                    ? "scale-[1.02] border-primary bg-primary/10"
                    : "cv-border cv-surface"
                )}
              >
                <div
                  className={cn(
                    "flex h-14 w-14 items-center justify-center rounded-xl ring-1 transition-colors",
                    dragOver
                      ? "bg-primary/20 ring-primary/40"
                      : "cv-surface-strong cv-border"
                  )}
                >
                  <Logo className="cv-text h-8 w-8 opacity-90" />
                </div>
                <div className="space-y-1.5">
                  <div className="cv-text text-base font-semibold tracking-tight">
                    {dragOver ? "松开以打开图纸" : "拖入 DWG / DXF 图纸"}
                  </div>
                  <div className="cv-text-muted text-sm leading-relaxed">
                    或点击「打开图纸」选择文件，也可以把图纸直接拖进来
                  </div>
                </div>
                <Button size="default" className="gap-2 shadow-xs" onClick={pickFile}>
                  <ArrowDownToLine />
                  选择文件
                </Button>
                <div className="cv-text-muted flex items-center gap-1.5 text-xs opacity-85">
                  <ShieldCheck className="h-3 w-3" />
                  全程本地解析 · 不上传云端
                </div>
              </div>
            </div>
          )}

          {/* 面板边线折叠开关：指针滑到边线才浮现（默认完全隐藏，不抢注意力） */}
          <div className="group/edge pointer-events-none absolute inset-y-0 right-0 z-30 w-9">
            {/* 命中热区：边线上贯穿高度的窄带——只有它参与命中，避免遮挡画布拖拽 */}
            <div data-edge-hot="1" className="pointer-events-auto absolute inset-y-0 right-0 w-3" />
            <button
              type="button"
              className={cn(
                "group/btn absolute right-1 top-1/2 flex size-7 -translate-y-1/2 scale-90 items-center justify-center rounded-full",
                "pointer-events-none border border-border/70 bg-background/85 text-muted-foreground opacity-0",
                "shadow-sm outline-hidden backdrop-blur-sm transition-all duration-200 ease-out",
                // 指针进入边线热区 → 浮现并接管命中：这样指针从边线移到按钮上不会闪烁
                "group-hover/edge:pointer-events-auto group-hover/edge:scale-100 group-hover/edge:opacity-100",
                "focus-visible:pointer-events-auto focus-visible:scale-100 focus-visible:opacity-100",
                "hover:border-foreground/25 hover:bg-card hover:text-foreground hover:shadow-md"
              )}
              title={showPanel ? "收起信息面板" : "展开信息面板"}
              aria-label={showPanel ? "收起信息面板" : "展开信息面板"}
              onClick={() => setShowPanel((v) => !v)}
            >
              {showPanel ? (
                <ChevronRight className="size-4 transition-transform duration-200 group-hover/btn:translate-x-0.5" />
              ) : (
                <ChevronLeft className="size-4 transition-transform duration-200 group-hover/btn:-translate-x-0.5" />
              )}
            </button>
          </div>
        </main>

        {/* ---------- 右侧信息面板（宽度过渡动画） ---------- */}
        <aside
          className={cn(
            "relative flex shrink-0 flex-col overflow-hidden transition-[width] duration-300 ease-in-out",
            showPanel ? "w-96" : "w-0"
          )}
        >
          <div className="flex h-full w-96 flex-col border-l bg-card">
            <Tabs defaultValue="overview" className="flex min-h-0 flex-1 flex-col">
              <div className="px-4 pt-4">
                <TabsList className="w-full">
                  <TabsTrigger value="overview" className="gap-2">
                    <FileDigit className="size-4" />
                    概览
                  </TabsTrigger>
                  <TabsTrigger value="layers" className="gap-2">
                    <Layers className="size-4" />
                    图层
                    {file?.stats && (
                      <span className="text-xs opacity-70">
                        {visibleLayers.length}
                      </span>
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="blocks" className="gap-2">
                    <Boxes className="size-4" />
                    图块
                    {file?.stats && (
                      <span className="text-xs opacity-70">
                        {file.stats.blocks.length -
                          (file.stats.unusedBlockDefCount ?? 0)}
                      </span>
                    )}
                  </TabsTrigger>
                </TabsList>
              </div>

              <TabsContent value="overview" className="mt-0 min-h-0 flex-1">
                {file ? (
                  <OverviewTab file={file} />
                ) : (
                  <EmptyHint
                    icon={<FileDigit className="h-6 w-6" />}
                    text="打开图纸后显示文件与实体统计"
                  />
                )}
              </TabsContent>
              <TabsContent value="layers" className="mt-0 min-h-0 flex-1">
                {session?.file.stats ? (
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
                )}
              </TabsContent>
              <TabsContent value="blocks" className="mt-0 min-h-0 flex-1">
                {file?.stats ? (
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
                )}
              </TabsContent>
            </Tabs>
          </div>
        </aside>
      </div>

      {/* 拖拽高亮 */}
      {dragOver && (
        <div className="pointer-events-none absolute inset-2 z-50 rounded-xl border-2 border-dashed border-primary bg-primary/[0.06]" />
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
    <span className="block" role="none" title={title}>
      <button
        type="button"
        role="menuitem"
        disabled={disabled}
        onClick={onClick}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors outline-hidden",
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
    </span>
  );
}
