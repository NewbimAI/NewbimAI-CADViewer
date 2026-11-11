/**
 * WebGL 引擎（DXF 直读）画布。
 *
 * 与 SVG 引擎的区别就一句话：几何不再是一棵 DOM 树，而是 worker 里生成的顶点缓冲，
 * 缩放/平移只是改一个正交相机的 projection，**每帧只发几十个 draw call**。
 * 所以"拖一下一块块刷出来"这个现象在这条路上不存在。
 *
 * 服务端给的地址是 `/api/file/:id/dxf`，那份文件已经做过两件预处理（见 server/dxf-web.js）：
 *   · `\U+XXXX` → 真字符（解析器自己不认这个转义，不处理就是满屏 `\U+5C4B`）
 *   · ACAD_TABLE 的网格与单元格文字注回成 LWPOLYLINE / TEXT（解析器不认表格实体）
 */
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { DxfViewer } from "dxf-viewer";
import type { Vec2 } from "../lib/measure";
import { FONT_URLS, TEXT_OPTIONS } from "../lib/fonts";
import { sceneRobustBox, unionBox, type RobustBox } from "../lib/robustBox";

export type DxfLayer = { name: string; color: number; visible: boolean };

type Box = { minX: number; minY: number; maxX: number; maxY: number };

export type DxfStatus = {
  phase: "font" | "fetch" | "parse" | "prepare" | "done" | "error";
  /** 0~1 */
  progress: number;
  /** 从开始到 loaded 的耗时（ms），done 时有值 */
  ms?: number;
  error?: string | null;
};

export type DxfApi = {
  fit: () => void;
  /** 全图视图：连图框、幕墙延伸一起框进画面（对应 SVG 引擎的"全图"按钮） */
  fitAll: () => void;
  zoomBy: (factor: number) => void;
  showLayer: (name: string, on: boolean) => void;
  setBackground: (hex: string) => void;
  /** 导出 PNG：当前视图、白底、`scale` 倍像素（2 = 2×）。画布未就绪时返回 null */
  capturePng?: (scale?: number) => Promise<Blob | null>;
  /**
   * 对比报告用的同步抓图：当前视图、白底、1 图像像素 = 1 CSS 像素，
   * 返回 `canvas.toDataURL("image/png")`。画布未就绪时返回 null。
   *
   * 为什么不用 `capturePng`：报告要把 WCS 包围盒用 `project()`（CSS 像素）
   * 画成云线，必须保证截图分辨率与投影坐标 1:1；这里临时把 pixelRatio 固定为 1。
   * 取图在 `render()` 之后同一任务里完成，所以不需要常开 `preserveDrawingBuffer`。
   */
  capture?: () => string | null;
  /**
   * 图纸 WCS → 画布 CSS 像素，按契约 §1 分两步：
   *   scene = wcs - viewer.GetOrigin()  →  viewer.SceneToCanvasCoord(scene)
   * 比对叠加层只认这个投影，绝不自己拼矩阵。viewer 已销毁时返回 null。
   */
  project?: (wcsX: number, wcsY: number) => { x: number; y: number } | null;
  /**
   * 订阅视图变化（平移 / 缩放 / 换图 / 尺寸变化）。回调里请自己做 rAF 合并。
   * 返回取消订阅函数。与内部的 onScale 订阅互不影响。
   */
  onViewChange?: (cb: () => void) => () => void;
  /** 把视图框到 WCS 包围盒（比对"定位"用）。参数顺序固定：minX, minY, maxX, maxY */
  fitBBox?: (
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    padding?: number
  ) => void;
  /**
   * dxf-viewer 解析后的文档（`GetDxf()`）。需要构造时传 `retainParsedDxf: true`，
   * 否则永远拿不到。测量内核用它建吸附索引。画布未载入 / 已销毁时返回 null。
   */
  getParsedDxf?: () => unknown | null;
  /**
   * 屏幕坐标（clientX/clientY）→ 图纸 WCS：canvas 相对坐标 → `CanvasToSceneCoord`
   * → `+ GetOrigin()`。彻底走 viewer 自己的投影，不自己拼矩阵。
   */
  clientToWcs?: (clientX: number, clientY: number) => Vec2 | null;
  /** 一个屏幕像素对应多少 WCS 单位（把 10px 的吸附容差换算成图纸单位） */
  wcsPerPixel?: () => number;
  /**
   * 当前视图中心与可见宽度，**图纸 WCS 单位**（相机位置已经加回 `GetOrigin()`）。
   * 并排对比的「同步显示」用它把一侧的视图原样交给另一侧；画布未就绪时返回 null。
   * ⚠️ 不用裸 scene 坐标：两张图的 GetOrigin() 不同（各自按包围盒算），
   *   用 scene 坐标同步会整体错位。
   */
  getView?: () => { centerX: number; centerY: number; width: number } | null;
  /**
   * 应用视图中心与可见宽度（同样按图纸 WCS 传参，内部减掉本画布的 `GetOrigin()`）。
   * 与 `getView` 成对使用，是同步显示的唯一写入口。
   */
  setView?: (centerX: number, centerY: number, width: number) => void;
};

type Props = {
  url: string | null;
  dark: boolean;
  /**
   * 默认取景盒（服务端算好的**主体范围** contentBox）。
   * ⚠️ 必须传：dxf-viewer 自己按 GetBounds() 取景用的是"全范围"（含图框/幕墙/游离图元），
   * 同一个画面上主体会小掉一大截，看起来就像"内容比 SVG 少"（实测 472e：全范围宽
   * 1,503,732 vs 主体 630,498，面积差 5.7 倍）。
   */
  fitBox?: Box | null;
  /** 布局页：纸张坐标与模型 contentBox 无关，适应窗口必须用引擎的纸张场景 bounds。 */
  layoutMode?: boolean;
  /** 改变即回到"适应窗口" */
  resetKey?: number;
  /**
   * 当前聚焦标识（`layer:xxx` / `block:xxx` / null）。仅当它**变化**引起的 url 重载
   * 才保留视口；首次加载、重开图纸、复位仍然 fit。
   */
  focusKey?: string | null;
  /** 缩放百分比，100 = 适应窗口，语义与 SVG 引擎完全一致 */
  onScale?: (percent: number) => void;
  onLayers?: (layers: DxfLayer[]) => void;
  onStatus?: (s: DxfStatus) => void;
  /** 外力控制图层显隐（图层面板） */
  layerVisibility?: Record<string, boolean>;
  onApi?: (api: DxfApi | null) => void;
};

const DARK_BG = "#1c1c1c";
const LIGHT_BG = "#ffffff";

/** 中文字体：dxf-viewer 只认传进去的 TTF 顺序，不看 DXF 里的文字样式，
 *  所以这里直接给它仿宋（与 SVG 文字层同一套字面）。 */
/** 字体：随产品分发的 OFL 字体（思源宋体 / Noto Serif SC），不读 Windows 系统字体。
 *  ⚠️ 字体必须是 **TrueType(glyf)**，且**字形轮廓不能自交**：
 *    dxf-viewer 用 earcut 三角化字形，而 CJK 字体常把字画成"重叠笔画"（靠 nonzero 填充规则
 *    才画得对）。自交轮廓会被 earcut 填成**实心块**——实测 Noto Serif SC 的 `7` 就是这样
 *    （外缘冲进顶栏内部再折回，与顶栏底边交叉）。
 *    随包字体都由 `scripts/normalize-font.py` 处理过（instancer 定字重 + skia-pathops 并集去重叠），
 *    **换字体时必须重跑这个脚本**，否则会再现"某个字变实心块"。
 *    另外 opentype.js 不支持可变轴：变体字体只会渲染**默认实例**（Noto 的默认是 ExtraLight，太细）。 */

export default function DxfCanvas({
  url,
  dark,
  fitBox = null,
  layoutMode = false,
  resetKey = 0,
  focusKey = null,
  onScale,
  onLayers,
  onStatus,
  layerVisibility,
  onApi,
}: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<DxfViewer | null>(null);
  /** 100% 对应的视口宽度（场景单位），由 loaded 时的相机宽度定 */
  const fitWRef = useRef(0);
  const scaleEmit = useRef(0);
  const fitBoxRef = useRef<Box | null>(fitBox);
  fitBoxRef.current = fitBox;
  /* 场景真实内容的稳健盒（见 lib/robustBox.ts）：服务端 contentBox 只统计顶层锚点，
   * 看不见块内几何；引擎 bounds 又会被坐标损坏的飞点撑爆。默认取景取两者的并集。 */
  const robustBoxRef = useRef<RobustBox | null>(null);
  const focusKeyRef = useRef<string | null>(focusKey);
  focusKeyRef.current = focusKey;
  /** 上一次 url 重载时的聚焦标识；undefined = 还没载入过 */
  const loadedFocusKeyRef = useRef<string | null | undefined>(undefined);
  /**
   * 并发合并用的队列。dxf-viewer 的 `Load()` 不可重入（它一进门就 `Clear()`，
   * 把正在跑的上一个 worker terminate 掉，收尾时又会把 `this.worker/layers/blocks`
   * 覆写一遍），所以同一时刻只允许一次 Load 在飞：
   * `pendingUrlRef` 永远只保存"最新想要的 url"，中间目标直接跳过；
   * `loadedUrlRef` 是"最近一次已交给 Load 的 url"，用来吃掉回到同一个 url 的无效重载。
   */
  const pendingUrlRef = useRef<string | null>(null);
  const loadedUrlRef = useRef<string | null>(null);
  const loadingRef = useRef(false);
  /** 运行号：被顶掉的旧运行无权复位 loadingRef / 写状态 */
  const runIdRef = useRef(0);
  /** 组件是否已卸载（viewer 已销毁）：卸载后绝不再触碰 viewer 与回调 */
  const unmountedRef = useRef(false);
  /** 比对叠加层的视图订阅（与 onScale 的节流订阅相互独立） */
  const viewCbsRef = useRef(new Set<() => void>());
  /** 队列泵（在渲染期赋值，和 cbs.current 同一套做法） */
  const pumpRef = useRef<() => void>(() => {});
  const cbs = useRef({ onScale, onLayers, onStatus, onApi });
  cbs.current = { onScale, onLayers, onStatus, onApi };
  const darkRef = useRef(dark);
  darkRef.current = dark;
  /** 图层显隐：Load 会重建图层表，所以载入完成后要按这份映射重新套一遍（换空间/聚焦重载时保留） */
  const layerVisRef = useRef<Record<string, boolean> | undefined>(layerVisibility);
  layerVisRef.current = layerVisibility;

  /**
   * 串行执行 Load：把 `pendingUrlRef` 里的最新 url 交给 viewer。
   *
   * 目标语义是"最终画面 = 最后一次点击的聚焦状态"。做法是**合并**：
   * 在飞的 Load 不受打扰地跑完，期间到来的新请求只更新 pending；
   * 等它在飞结束时，若 pending 还在，就在同一个微任务里接着加载最新那个。
   * 于是不会有两个 Load 相互清理/覆写，也不会卡在旧状态。
   */
  pumpRef.current = () => {
    if (unmountedRef.current) return;
    const viewer = viewerRef.current;
    const nextUrl = pendingUrlRef.current;
    if (!viewer || loadingRef.current || !nextUrl) return;
    // 回到正在加载/已加载的同一个 url：没有实际变化，直接吃掉
    if (nextUrl === loadedUrlRef.current) {
      pendingUrlRef.current = null;
      return;
    }

    // 认领本次请求
    pendingUrlRef.current = null;
    loadedUrlRef.current = nextUrl;
    loadingRef.current = true;
    const runId = ++runIdRef.current;
    /* 新一次 Load 之前先丢掉上一张图的稳健盒，避免取景用到旧坐标 */
    robustBoxRef.current = null;

    // 只有「聚焦切换」引起的重载才保住视口；首次载入（undefined）与重开图纸仍 fit。
    const isFocusTransition =
      loadedFocusKeyRef.current !== undefined &&
      loadedFocusKeyRef.current !== focusKeyRef.current;
    loadedFocusKeyRef.current = focusKeyRef.current;
    const prevView = isFocusTransition
      ? (() => {
          const cam = viewer.GetCamera();
          return {
            x: cam.position.x,
            y: cam.position.y,
            w: (cam.right - cam.left) / (cam.zoom || 1),
          };
        })()
      : null;

    const t0 = performance.now();
    cbs.current.onStatus?.({ phase: "fetch", progress: 0 });

    /** 本次运行收尾：只有最年轻的那次运行能复位 loadingRef；返回 true = 应当放弃 */
    const ended = () => {
      if (runIdRef.current === runId) loadingRef.current = false;
      return unmountedRef.current || viewerRef.current !== viewer;
    };

    viewer
      .Load({
        url: nextUrl,
        fonts: FONT_URLS,
        // 解析与几何准备全在 worker 里跑，主线程不卡
        workerFactory: () =>
          new Worker(new URL("../dxf-worker.ts", import.meta.url), { type: "module" }),
        progressCbk: (phase, processed, total) => {
          // 被顶掉的旧运行不许再写状态（避免进度条闪回旧阶段）
          if (unmountedRef.current || viewerRef.current !== viewer) return;
          if (runIdRef.current !== runId) return;
          const p = total > 0 ? processed / total : 0;
          cbs.current.onStatus?.({
            phase: phase as DxfStatus["phase"],
            progress: p,
          });
        },
      })
      .then(() => {
        if (ended()) return;
        if (prevView) {
          // focus 重载：Load 完成后再恢复原相机位置与可视宽度（不能提前，否则被载入复位覆盖）
          viewer.SetView(new THREE.Vector3(prevView.x, prevView.y, 0), prevView.w);
        } else {
          /* 默认取景：模型页 = 服务端 contentBox ∪ 场景稳健盒（contentBox 看不到块内几何，
           * 见 lib/robustBox.ts 的说明）；布局页没有 contentBox，直接按纸张场景 bounds。
           * ⚠️ 不能只依赖 Load 内部那次自动 fit：它发生在 Load promise 解析前/后的时序不保证，
           *    而且 fitWRef 若沿用了上一个空间的值，缩放百分比会算成天文数字（实测切换后
           *    曾显示 501388%）。这里统一自己 fit 一次，并把 fitWRef 归一到当前相机宽度。 */
          const box = fitBoxRef.current;
          /* contentBox 只统计顶层锚点（块内几何看不见），因此这里再按**实际画出来的顶点**
           * 求一个稳健盒并与它取并集：只扩大、不缩小，本图能把被裁掉的顶部落回来。 */
          const robust = sceneRobustBox(viewer);
          robustBoxRef.current = robust;
          (window as unknown as Record<string, unknown>).__dxfRobustBox = robust;
          /* 布局页不能按稳健盒取景：Tukey 分位数会按顶点密度丢掉稀疏但真实的纸张内容
           * （实测本图 A1 图框/左侧视口只占 1% 顶点，被裁掉 1/4，切到布局页只看到右半张）。 */
          const fit = layoutMode
            ? viewer.GetBounds()
            : (box ? unionBox(box, robust) : (robust ?? viewer.GetBounds()));
          const pad = box ? 0.03 : 0.1;
          const o = viewer.GetOrigin();
          if (fit) {
            viewer.FitView(
              fit.minX - o.x,
              fit.maxX - o.x,
              fit.minY - o.y,
              fit.maxY - o.y,
              pad
            );
          }
          const cam = viewer.GetCamera();
          fitWRef.current = (cam.right - cam.left) / (cam.zoom || 1);
          // 适应窗口按定义就是 100%：显式播一次，避免沿用上一个空间的旧比例
          cbs.current.onScale?.(100);
        }
        const vis = layerVisRef.current;
        if (vis) {
          for (const [name, on] of Object.entries(vis)) {
            try {
              viewer.ShowLayer(name, on);
            } catch {
              /* 该空间没有这个层：忽略 */
            }
          }
        }
        const layers = [...viewer.GetLayers(true)].map((l) => ({
          name: l.name,
          color: l.color,
          visible: l.visible,
        }));
        cbs.current.onLayers?.(layers);
        cbs.current.onStatus?.({
          phase: "done",
          progress: 1,
          ms: Math.round(performance.now() - t0),
          error: null,
        });
        // 期间用户又改了聚焦 → 立刻加载最新那个（上面 done 与这里 fetch 在同一个微任务，
        // React 会合并成一次渲染，不会出现"完成"闪一下又"加载中"）
        if (pendingUrlRef.current !== null) pumpRef.current();
      })
      .catch((e: unknown) => {
        if (ended()) return;
        // 失败但已有更新的目标：不报错，直接把最新目标加载起来
        if (pendingUrlRef.current !== null) {
          pumpRef.current();
          return;
        }
        cbs.current.onStatus?.({
          phase: "error",
          progress: 0,
          error: e instanceof Error ? e.message : String(e),
        });
      });
  };

  // ---- 建 viewer（只建一次；url 变化走 Load 而不是重建，避免闪烁） ----
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;

    // 新的 viewer 生命周期开始：复位卸载/在飞标记（StrictMode / 重挂载会重建本 effect）。
    // 上一次运行遗留的 Load promise 会随着 worker 被 terminate 而永远不落定，不会再来搅局。
    unmountedRef.current = false;
    loadingRef.current = false;

    let viewer: DxfViewer;
    try {
      viewer = new DxfViewer(wrap, {
        autoResize: true,
        antialias: true,
        // 纯黑/纯白图元在当前底色上不可见时自动反转（深色底上黑线变白线）
        blackWhiteInversion: true,
        clearColor: new THREE.Color(darkRef.current ? DARK_BG : LIGHT_BG),
        pointSize: 2,
        // 文字：字形曲线离散度（默认只有 2，导致笔画有棱角）与缺字占位符。
        // 注意不要设 fileEncoding：服务端 dxf-web.js 已经把下发的 DXF 统一成 UTF-8。
        sceneOptions: { textOptions: TEXT_OPTIONS },
        // 打开就能拿到指针位置：后续做"点选图元/测距"要靠它
        pointerMoveEvent: false,
        // 测量需要在 Load 之后还能拿到解析后的 DXF（GetDxf()），默认是丢掉的
        retainParsedDxf: true,
      });
    } catch (e) {
      cbs.current.onStatus?.({
        phase: "error",
        progress: 0,
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    viewerRef.current = viewer;
    // 调试挂钩（与 SVG 引擎的 window.__cvdbg 同一套路）：验收脚本要靠它精确取景
    (window as unknown as Record<string, unknown>).__dxfViewer = viewer;

    if (!viewer.HasRenderer()) {
      cbs.current.onStatus?.({
        phase: "error",
        progress: 0,
        error: "当前环境不支持 3D 渲染，无法显示图纸",
      });
      return;
    }

    const onView = () => {
      const cam = viewer.GetCamera();
      // ⚠️ 滚轮缩放改的是 camera.zoom，不是 left/right —— 只算 right-left 会永远读到 100%
      const w = (cam.right - cam.left) / (cam.zoom || 1);
      if (!w) return;
      const fitW = fitWRef.current || w;
      const pct = (fitW / w) * 100;
      // 手势中每帧都会触发，节流到 120ms，和 SVG 引擎同一套口径
      const now = performance.now();
      if (now - scaleEmit.current < 120) return;
      scaleEmit.current = now;
      cbs.current.onScale?.(pct);
    };
    viewer.Subscribe("viewChanged", onView);

    /**
     * 视图变化广播（比对叠加层订阅）。
     * - `viewChanged`：平移/缩放/FitView；
     * - `loaded`：换图后 GetOrigin() 变了，必须让叠加层重新投影，
     *   否则会停在上一个坐标系上（loaded 之后内部还会 FitView 再发一次，重复也无害）。
     * 单个订阅者抛错不能打断 viewer 的事件链，所以逐个 try。
     */
    const viewCbs = viewCbsRef.current;
    const emitView = () => {
      for (const cb of viewCbs) {
        try {
          cb();
        } catch {
          /* 订阅者自己的问题，不影响画布 */
        }
      }
    };
    viewer.Subscribe("viewChanged", emitView);
    viewer.Subscribe("loaded", emitView);

    const onMsg = (ev: { level?: string; text?: string }) => {
      if (ev?.level === "error") {
        cbs.current.onStatus?.({ phase: "error", progress: 0, error: ev.text || "渲染错误" });
      }
    };
    viewer.Subscribe("message", onMsg);

    /** 落位 + 把「100%」基准宽度归一到这次取景（适应窗口 = 100% 的定义） */
    const applyFit = (target: Box, pad: number) => {
      const o = viewer.GetOrigin();
      viewer.FitView(
        target.minX - o.x,
        target.maxX - o.x,
        target.minY - o.y,
        target.maxY - o.y,
        pad
      );
      const cam = viewer.GetCamera();
      fitWRef.current = (cam.right - cam.left) / (cam.zoom || 1);
      cbs.current.onScale?.(100);
    };

    /**
     * 统一取景入口。
     * @param box 模型页的 contentBox；布局页忽略它，改用纸张场景 bounds
     */
    const fitTo = (box: Box | null) => {
      /* 「适应窗口」用服务端内容盒 + 场景稳健盒的并集；「全图」不再用引擎 bounds
       * （会被坐标损坏的飞点撑到 1e11，等于把图缩成一个点），无稳健盒时才回退。
       * 布局页例外：纸张场景 bounds 才是图纸范围，稳健盒会按顶点密度丢掉稀疏但真实的
       * 图框/视口（实测 A1 图只看到右半张）。 */
      const target = layoutMode
        ? viewer.GetBounds()
        : (box ? unionBox(box, robustBoxRef.current) : robustBoxRef.current);
      if (target) {
        applyFit(target, box ? 0.03 : 0.01);
        return;
      }
      const b = viewer.GetBounds();
      if (b) applyFit(b, 0.1);
    };

    const api: DxfApi = {
      fit: () => fitTo(fitBoxRef.current),
      fitAll: () => fitTo(null),
      zoomBy: (factor: number) => {
        const cam = viewer.GetCamera();
        /* SetView 会把 cam.zoom 重置为 1，所以必须把**当前 zoom** 折算进可见宽度，
         * 否则 (right-left) 始终是基准宽度，每次点击都算出一模一样的宽度 →
         * 连续点 +/− 看起来完全没反应（滚轮缩放走的是 cam.zoom，不走 left/right）。 */
        const visibleW = (cam.right - cam.left) / (cam.zoom || 1);
        viewer.SetView(
          new THREE.Vector3(cam.position.x, cam.position.y, 0),
          visibleW / factor
        );
      },
      getView: () => {
        if (unmountedRef.current) return null;
        try {
          const cam = viewer.GetCamera();
          const o = viewer.GetOrigin();
          // 与 onView / zoomBy 同一口径：滚轮只改 cam.zoom，可见宽度要除掉它
          const width = (cam.right - cam.left) / (cam.zoom || 1);
          if (!Number.isFinite(width) || width <= 0) return null;
          return {
            centerX: cam.position.x + o.x,
            centerY: cam.position.y + o.y,
            width,
          };
        } catch {
          return null;
        }
      },
      setView: (centerX: number, centerY: number, width: number) => {
        if (unmountedRef.current) return;
        if (
          !Number.isFinite(centerX) ||
          !Number.isFinite(centerY) ||
          !Number.isFinite(width) ||
          width <= 0
        ) {
          return;
        }
        try {
          // SetView 收的是 scene 坐标，这里把 WCS 中心换回本画布的 scene 系
          const o = viewer.GetOrigin();
          viewer.SetView(
            new THREE.Vector3(centerX - o.x, centerY - o.y, 0),
            width
          );
        } catch {
          /* 视图已销毁：这一次同步当作没发生 */
        }
      },
      showLayer: (name: string, on: boolean) => viewer.ShowLayer(name, on),
      setBackground: (hex: string) => viewer.SetClearColor(new THREE.Color(hex)),
      capturePng: async (scale = 1) => {
        const renderer = viewer.GetRenderer();
        if (!renderer) return null;

        const canvas = renderer.domElement;
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (!w || !h) return null;

        const factor = Number.isFinite(scale) && scale > 0 ? scale : 1;
        // 下面几项在 finally 里必须原样还回去
        const prevColor = renderer.getClearColor(new THREE.Color());
        const prevAlpha = renderer.getClearAlpha();
        const prevRatio = renderer.getPixelRatio();
        let dataUrl: string | null = null;

        try {
          // 1) 白底：SetClearColor 会让材质缓存按新背景重新做一次颜色修正
          //    （纯白线 → 黑线），不需要重新 Load，也不会丢图层颜色
          viewer.SetClearColor(new THREE.Color("#ffffff"));

          // 2) 放大绘制缓冲：只改像素比与 buffer 尺寸，第三参数 false 保持 CSS 尺寸不变
          renderer.setPixelRatio(prevRatio * factor);
          renderer.setSize(w, h, false);

          // 3) 同步渲染并同步取图。toBlob 是异步编码，等回调时主题可能已经恢复，
          //    抓到的会是深色底，所以这里必须用 toDataURL。
          renderer.render(viewer.GetScene(), viewer.GetCamera());
          dataUrl = canvas.toDataURL("image/png");
        } catch {
          dataUrl = null;
        } finally {
          try {
            renderer.setPixelRatio(prevRatio);
            renderer.setSize(w, h, false);
            viewer.SetClearColor(prevColor);
            // SetClearColor 保留原 clearAlpha（它只改颜色），这里再显式还一次，双保险
            renderer.setClearColor(prevColor, prevAlpha);
            renderer.render(viewer.GetScene(), viewer.GetCamera());
          } catch {
            /* 恢复失败也只吞掉，不能把异常抛给导出调用方 */
          }
        }

        if (!dataUrl) return null;
        try {
          return await (await fetch(dataUrl)).blob();
        } catch {
          return null;
        }
      },
      capture: () => {
        const renderer = viewer.GetRenderer();
        if (!renderer) return null;

        const canvas = renderer.domElement;
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (!w || !h) return null;

        // 下面几项在 finally 里原样还回去
        const prevColor = renderer.getClearColor(new THREE.Color());
        const prevAlpha = renderer.getClearAlpha();
        const prevRatio = renderer.getPixelRatio();
        let dataUrl: string | null = null;

        try {
          // 报告统一白底（深色主题下也一页一张白图），并强制 1:1，
          // 这样 project() 返回的 CSS 像素可以直接当图片像素用来画云线。
          viewer.SetClearColor(new THREE.Color("#ffffff"));
          renderer.setPixelRatio(1);
          renderer.setSize(w, h, false);
          renderer.render(viewer.GetScene(), viewer.GetCamera());
          dataUrl = canvas.toDataURL("image/png");
        } catch {
          dataUrl = null;
        } finally {
          try {
            renderer.setPixelRatio(prevRatio);
            renderer.setSize(w, h, false);
            viewer.SetClearColor(prevColor);
            renderer.setClearColor(prevColor, prevAlpha);
            renderer.render(viewer.GetScene(), viewer.GetCamera());
          } catch {
            /* 恢复失败也只吞掉，不能把异常抛给报告导出 */
          }
        }
        return dataUrl;
      },
      project: (wcsX, wcsY) => {
        try {
          const o = viewer.GetOrigin();
          return viewer.SceneToCanvasCoord(wcsX - o.x, wcsY - o.y);
        } catch {
          // 视图已销毁（切换图纸的间隙）：宁可这一帧不画，也不要抛给 rAF
          return null;
        }
      },
      onViewChange: (cb) => {
        viewCbs.add(cb);
        return () => {
          viewCbs.delete(cb);
        };
      },
      fitBBox: (minX, minY, maxX, maxY, padding = 0.08) => {
        if (unmountedRef.current) return;
        const o = viewer.GetOrigin();
        // FitView 的参数顺序是 (minX, maxX, minY, maxY)——不要按字面顺序想当然
        viewer.FitView(minX - o.x, maxX - o.x, minY - o.y, maxY - o.y, padding);
      },
      getParsedDxf: () => {
        try {
          return viewer.GetDxf() ?? null;
        } catch {
          return null;
        }
      },
      clientToWcs: (clientX, clientY) => {
        try {
          const canvas = viewer.GetCanvas();
          if (!canvas) return null;
          const rect = canvas.getBoundingClientRect();
          if (!rect.width || !rect.height) return null;
          const scene = viewer.CanvasToSceneCoord(
            clientX - rect.left,
            clientY - rect.top
          );
          if (!scene || !Number.isFinite(scene.x) || !Number.isFinite(scene.y)) {
            return null;
          }
          const o = viewer.GetOrigin();
          return { x: scene.x + o.x, y: scene.y + o.y };
        } catch {
          // 视图正在换图 / 已销毁：这一下当作没点到
          return null;
        }
      },
      wcsPerPixel: () => {
        try {
          // 同一段 WCS 单位在画布上占多少像素；正交相机下必然 > 0
          const a = viewer.SceneToCanvasCoord(0, 0);
          const b = viewer.SceneToCanvasCoord(1, 0);
          const d = Math.hypot(b.x - a.x, b.y - a.y);
          return Number.isFinite(d) && d > 0 ? 1 / d : 0;
        } catch {
          return 0;
        }
      },
    };
    cbs.current.onApi?.(api);

    return () => {
      // 先立"已卸载"旗：任何在飞的 Load 落定后都不许再触碰这个已销毁的 viewer
      unmountedRef.current = true;
      viewer.Unsubscribe("viewChanged", onView);
      viewer.Unsubscribe("viewChanged", emitView);
      viewer.Unsubscribe("loaded", emitView);
      viewer.Unsubscribe("message", onMsg);
      viewCbs.clear();
      cbs.current.onApi?.(null);
      try {
        viewer.Destroy();
      } catch {
        /* 已经销毁过就算了 */
      }
      viewerRef.current = null;
    };
  }, []);

  // ---- 底色跟随主题 ----
  useEffect(() => {
    const v = viewerRef.current;
    if (!v?.HasRenderer()) return;
    v.SetClearColor(new THREE.Color(dark ? DARK_BG : LIGHT_BG));
  }, [dark]);

  // ---- 载入（url 变就请求重载） ----
  // 不在这里直接 Load：只把它记成"最新目标"再泵一次。真正的串行/合并逻辑在 pumpRef 里，
  // 这样重载期间连续改聚焦时，不会有两次 Load 相互清理、也不会丢掉最后一次点击。
  useEffect(() => {
    if (!url) return;
    pendingUrlRef.current = url;
    pumpRef.current();
  }, [url]);

  // ---- 复位 ----
  useEffect(() => {
    if (!resetKey) return;
    const v = viewerRef.current;
    if (!v?.GetBounds()) return;
    const box = fitBoxRef.current;
    const o = v.GetOrigin();
    /* 布局页：按纸张场景 bounds 取景 */
    const target = layoutMode
      ? v.GetBounds()
      : (box ? unionBox(box, robustBoxRef.current) : robustBoxRef.current);
    if (target) {
      v.FitView(
        target.minX - o.x,
        target.maxX - o.x,
        target.minY - o.y,
        target.maxY - o.y,
        box ? 0.03 : 0.01
      );
    } else {
      const b = v.GetBounds()!;
      v.FitView(b.minX - o.x, b.maxX - o.x, b.minY - o.y, b.maxY - o.y);
    }
    const cam = v.GetCamera();
    fitWRef.current = (cam.right - cam.left) / (cam.zoom || 1);
    cbs.current.onScale?.(100);
  }, [resetKey]);

  // ---- 外力控图层 ----
  useEffect(() => {
    const v = viewerRef.current;
    if (!v || !layerVisibility) return;
    for (const [name, on] of Object.entries(layerVisibility)) {
      try {
        v.ShowLayer(name, on);
      } catch {
        /* 层名不存在就算了 */
      }
    }
  }, [layerVisibility]);

  return <div ref={wrapRef} className="absolute inset-0 size-full" data-dxf-canvas="1" />;
}
