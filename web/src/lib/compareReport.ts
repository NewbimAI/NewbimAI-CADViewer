/**
 * 图纸对比 → Word 报告：前端逐条取景、截图、画云线并合成 PNG。
 *
 * 为什么在浏览器里做：
 *   · 截图只能从两块 WebGL 画布拿（服务端没有同一套渲染）；
 *   · 云线要贴着变更包围盒画，必须用 DxfCanvas 的 `project()` 做 WCS → 画布投影；
 *   · 图片在本地合成、降采样后再上传，服务端只负责排版（见 server/compare-report.js）。
 *
 * 和普通截图导出的区别：
 *   `capture()` 固定白底、1 图像像素 = 1 CSS 像素，所以 `project()` 返回的像素
 *   可以直接当图片像素用；报告里的云线不会因为 DPR 而偏到别处。
 *
 * 大批量导出：
 *   每条变更都要移动两侧相机 + 抓两张图 + 合成，天然会让出事件循环；
 *   另外每 10 条再显式 setTimeout(0) 一次，避免长任务把页面卡死。
 */
import type { DxfApi } from "@/components/DxfCanvas";
import type {
  CompareBBox,
  CompareChange,
  CompareKind,
  CompareResult,
} from "@/types";

export type CompareReportProgress = (
  done: number,
  total: number,
  label?: string
) => void;

export interface CompareReportOptions {
  tolerance: number;
  compareProps: string[];
  includeHatch: boolean;
}

export interface CompareReportChange {
  type: string;
  layer: string;
  handle: string | null;
  kind: CompareKind;
  kindLabel: string;
  note: string;
  bbox: CompareBBox | null;
  /** PNG base64（不带 data:image/png;base64, 前缀） */
  image: string;
  imageWidth: number;
  imageHeight: number;
}

export interface CompareReportSet {
  name: string;
  setId: number;
  bbox: CompareBBox | null;
  changes: CompareReportChange[];
}

export interface CompareReportPayload {
  baseName: string;
  targetName: string;
  createdAt: string;
  options: CompareReportOptions;
  summary: CompareResult["summary"];
  totalChanges: number;
  sets: CompareReportSet[];
}

const KIND_LABEL: Record<CompareKind, string> = {
  added: "新增",
  removed: "删除",
  modified: "修改",
};

/** 报告里的云线颜色：按需求固定，不跟随界面主题 */
const KIND_COLOR: Record<CompareKind, string> = {
  added: "#16a34a",
  removed: "#dc2626",
  modified: "#f59e0b",
};

/** 合成图总宽（≤ 1200）。变更很多时继续降，避免上传体积爆掉 */
function composeWidth(total: number): number {
  if (total > 4000) return 640;
  if (total > 2500) return 800;
  if (total > 1200) return 960;
  return 1200;
}

const HEADER_H = 38;
const PANE_BOX_H = 430;
const DIVIDER_W = 10;
const IMAGE_PAD = 6;

type OrderedSet = {
  setId: number;
  name: string;
  bbox: CompareBBox | null;
  changes: CompareChange[];
};

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function isBBox(raw: CompareBBox | null | undefined): raw is CompareBBox {
  if (!raw || raw.length < 4) return false;
  const [x0, y0, x1, y1] = raw;
  return [x0, y0, x1, y1].every((v) => Number.isFinite(v));
}

/**
 * 取“这条变更实际有多大”。compare 引擎对 TEXT 只给插入点（宽高为 0），
 * 直接用这个点去取景会放到一个汉字笔画的内部，画面一片空白。
 * 这里用 base/target 里的 text 图元补一个近似文字盒（高度 × 字数的 0.75 倍）；
 * 其它实体仍用引擎给的包围盒。
 */
function effectiveBBox(change: CompareChange): CompareBBox | null {
  let box: CompareBBox | null = isBBox(change.bbox)
    ? [...change.bbox]
    : null;
  for (const prim of [...(change.base ?? []), ...(change.target ?? [])]) {
    if (!prim || prim.kind !== "text") continue;
    const h = Math.abs(Number(prim.height)) || 0;
    const len = Math.max(1, (prim.text || "").length);
    const w = h > 0 ? h * len * 0.75 : 0;
    const x0 = prim.x;
    const y0 = prim.y - h * 0.3;
    const x1 = prim.x + w;
    const y1 = prim.y + h * 1.3;
    if (!box) {
      box = [x0, y0, x1, y1];
    } else {
      box = [
        Math.min(box[0], x0),
        Math.min(box[1], y0),
        Math.max(box[2], x1),
        Math.max(box[3], y1),
      ];
    }
  }
  return box;
}

/**
 * 取景盒：保证最小跨度。零宽/零高的 TEXT 插入点如果按 0.15 单位取景，
 * 会放大到笔画内部；minSpan 用整张图宽度的 1% 兜底，给变更留出上下文。
 * 与 App.locateBBox 同一套：退化包围盒先补成小方框，避免 FitView 飞到脸上。
 */
function fitBoxOf(
  raw: CompareBBox,
  minSpan: number
): [number, number, number, number] {
  let [x0, y0, x1, y1] = raw;
  const w = x1 - x0;
  const h = y1 - y0;
  const local = Math.max(w, h, 1) * 0.15;
  const target = Math.max(local, Number.isFinite(minSpan) ? minSpan : 0);
  if (w < target) {
    const cx = (x0 + x1) / 2;
    x0 = cx - target / 2;
    x1 = cx + target / 2;
  }
  if (h < target) {
    const cy = (y0 + y1) / 2;
    y0 = cy - target / 2;
    y1 = cy + target / 2;
  }
  return [x0, y0, x1, y1];
}

function unionBBox(list: CompareChange[]): CompareBBox | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const c of list) {
    if (!isBBox(c.bbox)) continue;
    x0 = Math.min(x0, c.bbox[0]);
    y0 = Math.min(y0, c.bbox[1]);
    x1 = Math.max(x1, c.bbox[2]);
    y1 = Math.max(y1, c.bbox[3]);
  }
  return Number.isFinite(x0) ? [x0, y0, x1, y1] : null;
}

function mergeBBox(
  a: CompareBBox | null,
  b: CompareBBox | null
): CompareBBox | null {
  if (!a) return b;
  if (!b) return a;
  return [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[2], b[2]),
    Math.max(a[3], b[3]),
  ];
}

/** 变更集按"变更多的在前"排（与面板列表一致），每条变更按 id 稳定排序 */
function orderSets(result: CompareResult): OrderedSet[] {
  const bySet = new Map<number, CompareChange[]>();
  for (const change of result.changes) {
    const list = bySet.get(change.setId);
    if (list) list.push(change);
    else bySet.set(change.setId, [change]);
  }

  const meta = [...result.changeSets].sort(
    (a, b) => b.count - a.count || a.id - b.id
  );
  const used = new Set<number>();
  const out: OrderedSet[] = [];

  for (const set of meta) {
    const list = bySet.get(set.id);
    if (!list?.length) continue;
    used.add(set.id);
    out.push({
      setId: set.id,
      name: `变更集 ${out.length + 1}`,
      bbox: isBBox(set.bbox) ? set.bbox : unionBBox(list),
      changes: [...list].sort((a, b) => a.id - b.id),
    });
  }

  // 极端情况下 changes 里出现 changeSets 没收录的 setId：也放进报告，绝不漏条
  for (const [setId, list] of bySet) {
    if (used.has(setId)) continue;
    out.push({
      setId,
      name: `其他变更（集 ${setId + 1}）`,
      bbox: unionBBox(list),
      changes: [...list].sort((a, b) => a.id - b.id),
    });
  }

  return out;
}

function handleOf(change: CompareChange): string | null {
  return change.handleTarget ?? change.handleBase ?? null;
}

function noteOf(change: CompareChange): string {
  const handle = handleOf(change);
  const parts = [`${KIND_LABEL[change.kind]} ${change.type || "实体"}`];
  if (change.layer) parts.push(`图层「${change.layer}」`);
  if (handle) parts.push(`句柄 #${handle}`);
  return parts.join("，");
}

async function waitForReady(
  baseApi: DxfApi,
  targetApi: DxfApi,
  shouldAbort?: () => boolean
): Promise<void> {
  if (!baseApi.capture || !targetApi.capture) {
    throw new Error("当前画布不支持截图，无法生成报告");
  }
  const deadline = performance.now() + 60_000;
  while (performance.now() < deadline) {
    if (shouldAbort?.()) throw new Error("已取消");
    // getParsedDxf() 只有 Load 完成后才非空；比 status 更直接，也不依赖 React 状态
    let baseReady = false;
    let targetReady = false;
    try {
      baseReady = !!baseApi.getParsedDxf?.();
      targetReady = !!targetApi.getParsedDxf?.();
    } catch {
      baseReady = false;
      targetReady = false;
    }
    if (baseReady && targetReady) return;
    await sleep(120);
  }
  throw new Error("并排对比画布尚未加载完成，请稍后再导出");
}

async function captureSide(api: DxfApi): Promise<string> {
  for (let i = 0; i < 4; i++) {
    const shot = api.capture?.();
    if (shot) return shot;
    await sleep(100);
  }
  throw new Error("画布截图失败（WebGL 缓冲未就绪）");
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("截图解码失败"));
    img.src = src;
  });
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function pngBase64(dataUrl: string): string {
  const i = dataUrl.indexOf(",");
  return i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
}

type PaneTransform = {
  /** 投影坐标 → 合成图坐标：x' = ox + x * scale */
  ox: number;
  oy: number;
  scale: number;
  /** 图片实际绘制区域（用于裁剪云线/标签） */
  boxX: number;
  boxY: number;
  boxW: number;
  boxH: number;
};

function projectRect(
  api: DxfApi,
  bbox: CompareBBox,
  pane: PaneTransform
): { x: number; y: number; w: number; h: number } | null {
  if (!api.project) return null;
  const [minX, minY, maxX, maxY] = bbox;
  const p00 = api.project(minX, minY);
  const p10 = api.project(maxX, minY);
  const p01 = api.project(minX, maxY);
  const p11 = api.project(maxX, maxY);
  if (!p00 || !p10 || !p01 || !p11) return null;

  const xs = [p00.x, p10.x, p01.x, p11.x];
  const ys = [p00.y, p10.y, p01.y, p11.y];
  const x0 = pane.ox + Math.min(...xs) * pane.scale;
  const x1 = pane.ox + Math.max(...xs) * pane.scale;
  const y0 = pane.oy + Math.min(...ys) * pane.scale;
  const y1 = pane.oy + Math.max(...ys) * pane.scale;

  // 太小（单点、极短线段）时给一个可见的云线框（报告图在 Word 里会缩到约一半，
  // 18px 会变成不到 10px，几乎看不见；54×34 缩完仍有 25px 左右）
  const minW = 54;
  const minH = 34;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const w = Math.max(minW, x1 - x0);
  const h = Math.max(minH, y1 - y0);
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/** 圆角矩形路径（Canvas2D.roundRect 在旧浏览器里没有） */
function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

/**
 * 一条边的"修云"波峰：把线段切成若干小段，每段用二次贝塞尔向外鼓一下。
 * 返回时当前点已经落到边的终点。
 */
function waveEdge(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  nx: number,
  ny: number,
  amp: number
): void {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const n = Math.max(2, Math.round(len / 16));
  for (let i = 0; i < n; i++) {
    const t0 = i / n;
    const t1 = (i + 1) / n;
    const ax = x0 + (x1 - x0) * t0;
    const ay = y0 + (y1 - y0) * t0;
    const bx = x0 + (x1 - x0) * t1;
    const by = y0 + (y1 - y0) * t1;
    const mx = (ax + bx) / 2 + nx * amp * 1.55;
    const my = (ay + by) / 2 + ny * amp * 1.55;
    ctx.quadraticCurveTo(mx, my, bx, by);
  }
}

/** 在合成图上画一条外扩的修云 + 引线 + 图例小标签 */
function drawCloud(
  ctx: CanvasRenderingContext2D,
  rect: { x: number; y: number; w: number; h: number },
  color: string,
  label: string,
  bounds: { x: number; y: number; w: number; h: number }
): void {
  const pad = clamp(Math.min(rect.w, rect.h) * 0.12, 8, 12);
  let x0 = rect.x - pad;
  let y0 = rect.y - pad;
  let x1 = rect.x + rect.w + pad;
  let y1 = rect.y + rect.h + pad;

  // 至少给一个能看出波浪的尺寸；再裁到图片区域内，避免压到标题条
  if (x1 - x0 < 54) {
    const cx = (x0 + x1) / 2;
    x0 = cx - 27;
    x1 = cx + 27;
  }
  if (y1 - y0 < 34) {
    const cy = (y0 + y1) / 2;
    y0 = cy - 17;
    y1 = cy + 17;
  }
  x0 = clamp(x0, bounds.x + 2, bounds.x + bounds.w - 4);
  x1 = clamp(x1, x0 + 10, bounds.x + bounds.w - 2);
  y0 = clamp(y0, bounds.y + 2, bounds.y + bounds.h - 4);
  y1 = clamp(y1, y0 + 8, bounds.y + bounds.h - 2);

  const amp = clamp(Math.min(x1 - x0, y1 - y0) * 0.06, 2.2, 5.5);

  // 顺时针：上 → 右 → 下 → 左，外法线依次是 (0,-1)、(1,0)、(0,1)、(-1,0)
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  waveEdge(ctx, x0, y0, x1, y0, 0, -1, amp);
  waveEdge(ctx, x1, y0, x1, y1, 1, 0, amp);
  waveEdge(ctx, x1, y1, x0, y1, 0, 1, amp);
  waveEdge(ctx, x0, y1, x0, y0, -1, 0, amp);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.09;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();
  ctx.restore();

  // 引线 + 标签：优先放在云线右上方，放不下就换到左上方，最后夹回图片内
  const fontSize = 14;
  ctx.font = `600 ${fontSize}px "Microsoft YaHei", "PingFang SC", sans-serif`;
  const textW = ctx.measureText(label).width;
  const tagW = Math.min(textW + 18, bounds.w - 8);
  const tagH = 24;
  let tagX = x1 + 16;
  let tagY = y0 - tagH - 8;
  if (tagX + tagW > bounds.x + bounds.w - 4) {
    tagX = x0 - 16 - tagW;
  }
  tagX = clamp(tagX, bounds.x + 4, bounds.x + bounds.w - tagW - 4);
  tagY = clamp(tagY, bounds.y + 4, bounds.y + bounds.h - tagH - 4);

  const anchorX = tagX > (x0 + x1) / 2 ? x1 : x0;
  const anchorY = y0;
  const targetX = tagX > (x0 + x1) / 2 ? tagX : tagX + tagW;
  const targetY = tagY + tagH / 2;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(anchorX, anchorY);
  ctx.lineTo(targetX, targetY);
  ctx.stroke();

  roundRectPath(ctx, tagX, tagY, tagW, tagH, 6);
  ctx.fillStyle = "rgba(255,255,255,0.94)";
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.stroke();

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(tagX + 8, tagY + tagH / 2, 3, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#111827";
  ctx.font = `600 ${fontSize}px "Microsoft YaHei", "PingFang SC", sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(label, tagX + 15, tagY + tagH / 2 + 0.5, tagW - 20);
  ctx.restore();
}

function layoutPane(
  img: HTMLImageElement,
  boxX: number,
  boxY: number,
  boxW: number,
  boxH: number
): PaneTransform {
  const scale = Math.min(boxW / img.naturalWidth, boxH / img.naturalHeight);
  const w = img.naturalWidth * scale;
  const h = img.naturalHeight * scale;
  const x = boxX + (boxW - w) / 2;
  const y = boxY + (boxH - h) / 2;
  return {
    ox: x,
    oy: y,
    scale,
    boxX: x,
    boxY: y,
    boxW: w,
    boxH: h,
  };
}

function drawHeaderText(
  ctx: CanvasRenderingContext2D,
  text: string,
  sub: string,
  cx: number,
  cy: number,
  maxW: number
): void {
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  let main = text;
  ctx.font = '600 16px "Microsoft YaHei", "PingFang SC", sans-serif';
  while (main.length > 2 && ctx.measureText(main).width > maxW) {
    main = main.slice(0, -1);
  }
  ctx.fillStyle = "#111827";
  ctx.fillText(main, cx, cy - 7);

  if (sub) {
    let s = sub;
    ctx.font = '11px "Microsoft YaHei", "PingFang SC", sans-serif';
    while (s.length > 4 && ctx.measureText(s).width > maxW) {
      s = s.slice(0, -1);
    }
    ctx.fillStyle = "#6b7280";
    ctx.fillText(s, cx, cy + 10);
  }
  ctx.restore();
}

async function composeChangeImage(args: {
  baseShot: string;
  targetShot: string;
  baseName: string;
  targetName: string;
  change: CompareChange;
  cloudBBox: CompareBBox | null;
  totalWidth: number;
  baseApi: DxfApi;
  targetApi: DxfApi;
}): Promise<{ image: string; imageWidth: number; imageHeight: number }> {
  const {
    baseShot,
    targetShot,
    baseName,
    targetName,
    change,
    cloudBBox,
    totalWidth,
    baseApi,
    targetApi,
  } = args;

  const [baseImg, targetImg] = await Promise.all([
    loadImage(baseShot),
    loadImage(targetShot),
  ]);

  const width = Math.round(totalWidth);
  const paneW = Math.floor((width - DIVIDER_W) / 2);
  const height = HEADER_H + PANE_BOX_H + IMAGE_PAD;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("浏览器不支持 Canvas 2D，无法合成报告图片");

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  // 标题条
  ctx.fillStyle = "#f8fafc";
  ctx.fillRect(0, 0, width, HEADER_H);
  ctx.strokeStyle = "#e5e7eb";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, HEADER_H + 0.5);
  ctx.lineTo(width, HEADER_H + 0.5);
  ctx.stroke();

  drawHeaderText(
    ctx,
    "基准图",
    baseName,
    paneW / 2,
    HEADER_H / 2,
    paneW - 20
  );
  drawHeaderText(
    ctx,
    "对比图",
    targetName,
    paneW + DIVIDER_W + paneW / 2,
    HEADER_H / 2,
    paneW - 20
  );

  // 中间分隔线
  ctx.strokeStyle = "#d1d5db";
  ctx.lineWidth = 2;
  ctx.beginPath();
  const dividerX = paneW + DIVIDER_W / 2;
  ctx.moveTo(dividerX, 0);
  ctx.lineTo(dividerX, height);
  ctx.stroke();

  const basePane = layoutPane(
    baseImg,
    0,
    HEADER_H,
    paneW,
    PANE_BOX_H
  );
  const targetPane = layoutPane(
    targetImg,
    paneW + DIVIDER_W,
    HEADER_H,
    paneW,
    PANE_BOX_H
  );

  const drawPane = (img: HTMLImageElement, pane: PaneTransform) => {
    ctx.drawImage(img, pane.boxX, pane.boxY, pane.boxW, pane.boxH);
    ctx.strokeStyle = "#e5e7eb";
    ctx.lineWidth = 1;
    ctx.strokeRect(
      pane.boxX + 0.5,
      pane.boxY + 0.5,
      pane.boxW - 1,
      pane.boxH - 1
    );
  };
  drawPane(baseImg, basePane);
  drawPane(targetImg, targetPane);

  if (isBBox(cloudBBox)) {
    const color = KIND_COLOR[change.kind];
    const label = `${KIND_LABEL[change.kind]} ${change.type || "实体"}`;
    // 新增只存在于对比侧、删除只存在于基准侧；修改两侧都有
    if (change.kind !== "added") {
      const rect = projectRect(baseApi, cloudBBox, basePane);
      if (rect) {
        drawCloud(ctx, rect, color, label, {
          x: basePane.boxX,
          y: basePane.boxY,
          w: basePane.boxW,
          h: basePane.boxH,
        });
      }
    }
    if (change.kind !== "removed") {
      const rect = projectRect(targetApi, cloudBBox, targetPane);
      if (rect) {
        drawCloud(ctx, rect, color, label, {
          x: targetPane.boxX,
          y: targetPane.boxY,
          w: targetPane.boxW,
          h: targetPane.boxH,
        });
      }
    }
  }

  return {
    image: pngBase64(canvas.toDataURL("image/png")),
    imageWidth: width,
    imageHeight: height,
  };
}

export async function buildCompareReportPayload(args: {
  baseApi: DxfApi;
  targetApi: DxfApi;
  result: CompareResult;
  options: CompareReportOptions;
  baseName?: string;
  targetName?: string;
  /** 取景最小跨度（图纸单位）；App 用主体范围宽度的 1% 传进来 */
  minViewSpan?: number;
  onProgress?: CompareReportProgress;
  shouldAbort?: () => boolean;
}): Promise<CompareReportPayload> {
  const {
    baseApi,
    targetApi,
    result,
    options,
    baseName,
    targetName,
    minViewSpan,
    onProgress,
    shouldAbort,
  } = args;

  await waitForReady(baseApi, targetApi, shouldAbort);

  const sets = orderSets(result);
  const total = sets.reduce((n, s) => n + s.changes.length, 0);
  const totalWidth = composeWidth(total);
  const outSets: CompareReportSet[] = [];
  let done = 0;

  // 取景至少要有“整图宽度的 1%”这么多上下文，否则 TEXT 插入点会放大到笔画内部。
  // 优先用调用方给的主体范围；拿不到时退回当前视图宽度（进对比时通常就是全图）。
  const initialBase = baseApi.getView?.() ?? null;
  const initialTarget = targetApi.getView?.() ?? null;
  const fallbackSpan =
    Math.max(initialBase?.width ?? 0, initialTarget?.width ?? 0) * 0.01;
  const span =
    Number.isFinite(minViewSpan) && (minViewSpan ?? 0) > 0
      ? (minViewSpan as number)
      : fallbackSpan;

  for (const set of sets) {
    const outChanges: CompareReportChange[] = [];
    let outBBox: CompareBBox | null = null;
    for (const change of set.changes) {
      if (shouldAbort?.()) throw new Error("已取消");
      onProgress?.(done, total, `${set.name} · ${noteOf(change)}`);

      const cloudBBox = effectiveBBox(change);
      if (cloudBBox) {
        outBBox = mergeBBox(outBBox, cloudBBox);
        const fit = fitBoxOf(cloudBBox, span);
        baseApi.fitBBox?.(fit[0], fit[1], fit[2], fit[3], 0.85);
        targetApi.fitBBox?.(fit[0], fit[1], fit[2], fit[3], 0.85);
      }
      // FitView 内部是同步 Render；这一帧是让浏览器把画布搬运/合成完
      await nextFrame();

      const [baseShot, targetShot] = await Promise.all([
        captureSide(baseApi),
        captureSide(targetApi),
      ]);
      const composed = await composeChangeImage({
        baseShot,
        targetShot,
        baseName: baseName || result.base.name || "基准图",
        targetName: targetName || result.target.name || "对比图",
        change,
        cloudBBox,
        totalWidth,
        baseApi,
        targetApi,
      });

      outChanges.push({
        type: change.type,
        layer: change.layer,
        handle: handleOf(change),
        kind: change.kind,
        kindLabel: KIND_LABEL[change.kind],
        note: noteOf(change),
        bbox: cloudBBox,
        ...composed,
      });

      done++;
      onProgress?.(done, total, `${set.name} · ${noteOf(change)}`);

      // 显式让出事件循环：每 10 条一次（单条内部的 rAF 已经会让，但小图很快，
      // 连续 10 条仍可能在同一个长任务里堆出可感知的卡顿）
      if (done % 10 === 0) await sleep(0);
    }
    outSets.push({
      name: set.name,
      setId: set.setId,
      bbox: outBBox ?? set.bbox,
      changes: outChanges,
    });
  }

  return {
    baseName: baseName || result.base.name || "基准图",
    targetName: targetName || result.target.name || "对比图",
    createdAt: new Date().toISOString(),
    options,
    summary: result.summary,
    totalChanges: done,
    sets: outSets,
  };
}

/* ------------------------------------------------------------------ */
/* 文件名 / 下载                                                       */
/* ------------------------------------------------------------------ */

/** 去掉扩展名和 Windows/URL 非法字符，避免下载名带路径分隔符 */
function cleanFileStem(name: string): string {
  const stem = (name || "").replace(/\.[^.\\/]+$/, "");
  return stem
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60) || "图纸";
}

/** 对比报告_基准_vs_对比_YYYYMMDD-HHmm.docx */
export function reportDownloadName(
  baseName: string,
  targetName: string,
  date = new Date()
): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(
    date.getDate()
  )}-${p(date.getHours())}${p(date.getMinutes())}`;
  return `对比报告_${cleanFileStem(baseName)}_vs_${cleanFileStem(
    targetName
  )}_${stamp}.docx`;
}

/** File System Access 的保存句柄；不支持时返回 null。 */
export type ReportSaveTarget = {
  createWritable: () => Promise<{
    write: (data: Blob) => Promise<void>;
    close: () => Promise<void>;
  }>;
};

/** 浏览器是否支持「另存为」选择目录（Chrome/Edge 支持）。 */
export function supportsReportSavePicker(): boolean {
  return (
    typeof (window as unknown as { showSaveFilePicker?: unknown })
      .showSaveFilePicker === "function"
  );
}

/**
 * 让用户自己选保存位置（系统「另存为」）。
 * **必须在点击事件里第一时间调用**——浏览器只在用户手势后的短暂窗口内允许弹出。
 * 返回 null 表示浏览器不支持（走普通下载回退）；用户取消时返回 null 且不报错。
 * 真正的写入在报告生成完成后用 `writeReportToTarget`。
 */
export async function pickReportSaveTarget(
  fileName: string
): Promise<ReportSaveTarget | null> {
  type SavePicker = (opts: {
    suggestedName?: string;
    types?: { description?: string; accept: Record<string, string[]> }[];
  }) => Promise<ReportSaveTarget>;

  const picker = (window as unknown as { showSaveFilePicker?: SavePicker })
    .showSaveFilePicker;
  if (typeof picker !== "function") return null;
  try {
    return await picker({
      suggestedName: fileName,
      types: [
        {
          description: "Word 文档",
          accept: {
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
              [".docx"],
          },
        },
      ],
    });
  } catch (err) {
    // 用户取消：静默（不抛错，也不回退下载）
    if ((err as { name?: string } | null)?.name === "AbortError") return null;
    return null;
  }
}

/** 把生成好的报告写进用户选好的位置。 */
export async function writeReportToTarget(
  target: ReportSaveTarget,
  blob: Blob
): Promise<void> {
  const writable = await target.createWritable();
  await writable.write(blob);
  await writable.close();
}

/**
 * 回退保存（浏览器不支持 File System Access，或用户取消选择时由调用方决定不用）。
 */
export function downloadReportBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.style.display = "none";
  document.body.append(a);
  a.click();
  a.remove();
  // 给浏览器留出开始下载的时间；不 revoke 也不会泄漏太久
  window.setTimeout(() => URL.revokeObjectURL(url), 15_000);
}
