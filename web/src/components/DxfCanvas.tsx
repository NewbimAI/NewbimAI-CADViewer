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

export type DxfLayer = { name: string; color: number; visible: boolean };

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
};

type Box = { minX: number; minY: number; maxX: number; maxY: number };

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
 *    当前随包字体已用 `fonttools`(instancer, wght=400) + `skia-pathops`(并集去重叠) 处理过，
 *    **换字体时必须重复这两步**，否则会再现"某个字变实心块"。
 *    另外 opentype.js 不支持可变轴：变体字体只会渲染**默认实例**（Noto 的默认是 ExtraLight，太细）。 */
const FONT_URLS = ["/fonts/NotoSerifSC-Regular.ttf"];

export default function DxfCanvas({
  url,
  dark,
  fitBox = null,
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
  /** 队列泵（在渲染期赋值，和 cbs.current 同一套做法） */
  const pumpRef = useRef<() => void>(() => {});
  const cbs = useRef({ onScale, onLayers, onStatus, onApi });
  cbs.current = { onScale, onLayers, onStatus, onApi };
  const darkRef = useRef(dark);
  darkRef.current = dark;

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
          // 默认取景用服务端算好的主体范围；没有就退回引擎自己的全范围
          const box = fitBoxRef.current;
          const o = viewer.GetOrigin();
          if (box) {
            viewer.FitView(box.minX - o.x, box.maxX - o.x, box.minY - o.y, box.maxY - o.y, 0.03);
          }
          const cam = viewer.GetCamera();
          fitWRef.current = (cam.right - cam.left) / (cam.zoom || 1);
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
        // 打开就能拿到指针位置：后续做"点选图元/测距"要靠它
        pointerMoveEvent: false,
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

    const onMsg = (ev: { level?: string; text?: string }) => {
      if (ev?.level === "error") {
        cbs.current.onStatus?.({ phase: "error", progress: 0, error: ev.text || "渲染错误" });
      }
    };
    viewer.Subscribe("message", onMsg);

    const fitTo = (box: Box | null) => {
      const o = viewer.GetOrigin();
      if (box) {
        viewer.FitView(box.minX - o.x, box.maxX - o.x, box.minY - o.y, box.maxY - o.y, 0.03);
      } else {
        const b = viewer.GetBounds();
        if (!b) return;
        viewer.FitView(b.minX - o.x, b.maxX - o.x, b.minY - o.y, b.maxY - o.y);
      }
      const cam = viewer.GetCamera();
      fitWRef.current = (cam.right - cam.left) / (cam.zoom || 1);
    };

    const api: DxfApi = {
      fit: () => fitTo(fitBoxRef.current),
      fitAll: () => fitTo(null),
      zoomBy: (factor: number) => {
        const cam = viewer.GetCamera();
        const w = (cam.right - cam.left) / factor;
        viewer.SetView(new THREE.Vector3(cam.position.x, cam.position.y, 0), w);
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
    };
    cbs.current.onApi?.(api);

    return () => {
      // 先立"已卸载"旗：任何在飞的 Load 落定后都不许再触碰这个已销毁的 viewer
      unmountedRef.current = true;
      viewer.Unsubscribe("viewChanged", onView);
      viewer.Unsubscribe("message", onMsg);
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
    if (box) {
      v.FitView(box.minX - o.x, box.maxX - o.x, box.minY - o.y, box.maxY - o.y, 0.03);
    } else {
      const b = v.GetBounds()!;
      v.FitView(b.minX - o.x, b.maxX - o.x, b.minY - o.y, b.maxY - o.y);
    }
    const cam = v.GetCamera();
    fitWRef.current = (cam.right - cam.left) / (cam.zoom || 1);
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
