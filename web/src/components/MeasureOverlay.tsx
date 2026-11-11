/**
 * 测量叠加层。
 *
 * 和 `ChangeOverlay` 同一套路：一块铺在 WebGL 画布上的 SVG（`pointer-events: none`），
 * 用 `api.project()` 把 WCS 投影成画布 CSS 像素。区别是这里还要吃指针：
 *
 *   · 指针事件挂在 window 上（冒泡阶段、不拦截），只处理落在 `[data-dxf-canvas]` 里的；
 *     画布自己的平移/缩放手势完全不受影响。pointerdown → pointerup 位移 > 4px 视为拖拽，不落点。
 *   · pointermove 只记一个坐标，真正的换算 / 吸附 / 重绘都在 rAF 里做：
 *     既不按原始事件频率扫几何，也不触发任何 React 重渲染。
 *   · 已完成的测量是 WCS 的点，每帧用仿射基重投影 —— 缩放、平移不会让标注漂移；
 *     线宽、字号、吸附标记全是屏幕像素，不随缩放变粗变细。
 *   · 文字用 DOM 绝对定位（同样吃投影结果），所以永远是清晰的 CSS 字号，而不是被缩放拉糊的 <text>。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

import type { DxfApi } from "@/components/DxfCanvas";
import DockTooltip from "@/components/DockTooltip";
import { MEASURE_LABEL, type MeasureTool } from "@/components/MeasureToolbar";
import { ScrollArea } from "@/components/ui/scroll-area";
import type {
  MeasureEngine,
  SnapHit,
  SnapKind,
  Vec2,
} from "../lib/measure";

/** 一条已保存的测量（点一律是 WCS） */
export type Measurement = {
  id: number;
  kind: MeasureTool;
  points: Vec2[];
  /** 数值结果；坐标测量为 null，半径三点共线也为 null */
  value: number | null;
  /** 主读数（已经过 engine.fmt） */
  text: string;
  /** 次读数（面积的周长等） */
  note?: string;
};

type Props = {
  api: DxfApi | null;
  engine: MeasureEngine | null;
  tool: MeasureTool | null;
  measurements: Measurement[];
  dark: boolean;
  /** 单位全称，例如「毫米」 */
  unitLabel: string;
  /** 「清除」时递增：让还没落完的点也一起收掉 */
  clearNonce: number;
  onCommit: (m: Omit<Measurement, "id">) => void;
  onRemove: (id: number) => void;
  /** Esc：取消当前取点并退出工具 */
  onExit: () => void;
};

type Pt = { x: number; y: number };
type Twin = { main: SVGElement; halo: SVGElement };

const SVG_NS = "http://www.w3.org/2000/svg";
/** 吸附半径（屏幕像素） */
const SNAP_PX = 10;
/** 按下到抬起位移超过这个值就算拖拽，不落点 */
const CLICK_SLOP = 4;
/** 原地重复点击（双击的第二下）判定的屏幕距离 */
const DUP_PX = 2;

const SNAP_LABEL: Record<SnapKind, string> = {
  endpoint: "端点",
  midpoint: "中点",
  center: "圆心",
  quadrant: "象限点",
  intersection: "交点",
  nearest: "最近点",
  vertex: "顶点",
};

type Ink = {
  accent: string;
  halo: string;
  snapFg: string;
};

function inkFor(dark: boolean): Ink {
  return dark
    ? {
        accent: "#67e8f9",
        halo: "#1c1c1c",
        snapFg: "#04222a",
      }
    : {
        accent: "#0e7490",
        halo: "#ffffff",
        snapFg: "#ffffff",
      };
}

/* ------------------------------ 小工具 ------------------------------ */

function f1(v: number): number {
  return Math.round(v * 10) / 10;
}

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K
): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, tag) as SVGElementTagNameMap[K];
}

function showEl(el: SVGElement | HTMLElement | null, on: boolean) {
  if (!el) return;
  el.style.display = on ? "" : "none";
}

function hideTwin(t: Twin | undefined) {
  if (!t) return;
  showEl(t.main, false);
  showEl(t.halo, false);
}

function setLine(t: Twin | undefined, a: Pt, b: Pt) {
  if (!t) return;
  const x1 = `${f1(a.x)}`;
  const y1 = `${f1(a.y)}`;
  const x2 = `${f1(b.x)}`;
  const y2 = `${f1(b.y)}`;
  for (const el of [t.main, t.halo]) {
    el.setAttribute("x1", x1);
    el.setAttribute("y1", y1);
    el.setAttribute("x2", x2);
    el.setAttribute("y2", y2);
  }
  showEl(t.main, true);
  showEl(t.halo, true);
}

function pointsStr(pts: Pt[], closed: boolean): string {
  let s = "";
  for (let i = 0; i < pts.length; i++) {
    s += `${i ? " " : ""}${f1(pts[i].x)},${f1(pts[i].y)}`;
  }
  if (closed && pts.length > 1) {
    s += ` ${f1(pts[0].x)},${f1(pts[0].y)}`;
  }
  return s;
}

function setPoly(t: Twin | undefined, pts: Pt[], closed: boolean) {
  if (!t) return;
  const s = pointsStr(pts, closed);
  t.main.setAttribute("points", s);
  t.halo.setAttribute("points", s);
  showEl(t.main, pts.length > 1);
  showEl(t.halo, pts.length > 1);
}

function setFill(el: SVGPolygonElement | null, pts: Pt[]) {
  if (!el) return;
  el.setAttribute("points", pointsStr(pts, true));
  showEl(el, pts.length > 2);
}

function setCircle(t: Twin | undefined, c: Pt, r: number) {
  if (!t) return;
  for (const el of [t.main, t.halo]) {
    el.setAttribute("cx", `${f1(c.x)}`);
    el.setAttribute("cy", `${f1(c.y)}`);
    el.setAttribute("r", `${f1(Math.max(0, r))}`);
  }
  showEl(t.main, true);
  showEl(t.halo, true);
}

function setPath(t: Twin | undefined, d: string) {
  if (!t) return;
  t.main.setAttribute("d", d);
  t.halo.setAttribute("d", d);
  showEl(t.main, true);
  showEl(t.halo, true);
}

function setCenter(el: SVGCircleElement, c: Pt) {
  el.setAttribute("cx", `${f1(c.x)}`);
  el.setAttribute("cy", `${f1(c.y)}`);
}

/** 画布上的读数胶囊：深色半透明底 + 白字、rounded-full、无边框（深浅画布通用） */
function makeLabel(): HTMLDivElement {
  const el = document.createElement("div");
  el.className =
    "pointer-events-none absolute left-0 top-0 z-10 whitespace-nowrap rounded-full px-2 py-[3px] text-xs font-medium leading-none tabular-nums shadow-sm will-change-transform";
  el.style.background = "rgba(20, 22, 24, 0.8)";
  el.style.color = "#ffffff";
  el.style.backdropFilter = "blur(4px)";
  el.style.display = "none";
  el.dataset.measureLabel = "1";
  return el;
}

function placeLabel(el: HTMLDivElement, x: number, y: number) {
  el.style.display = "";
  el.style.transform = `translate3d(${f1(x)}px, ${f1(y)}px, 0) translate(-50%, -50%)`;
}

function centroid(pts: Pt[]): Pt {
  let sx = 0;
  let sy = 0;
  for (const p of pts) {
    sx += p.x;
    sy += p.y;
  }
  const n = pts.length || 1;
  return { x: sx / n, y: sy / n };
}

/** 三点定圆（WCS）；共线返回 null */
function circumcircle(a: Vec2, b: Vec2, c: Vec2): { c: Vec2; r: number } | null {
  const d =
    2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (!Number.isFinite(d) || Math.abs(d) < 1e-12) return null;
  const a2 = a.x * a.x + a.y * a.y;
  const b2 = b.x * b.x + b.y * b.y;
  const c2 = c.x * c.x + c.y * c.y;
  const ux = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
  const uy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  const r = Math.hypot(a.x - ux, a.y - uy);
  if (!Number.isFinite(r)) return null;
  return { c: { x: ux, y: uy }, r };
}

/** 角度的屏幕弧线：固定 26px 半径，永远不随缩放变大 */
function angleArc(A: Pt, B: Pt, C: Pt): { d: string; mid: Pt; delta: number } {
  const r = 26;
  const ang1 = Math.atan2(A.y - B.y, A.x - B.x);
  const ang2 = Math.atan2(C.y - B.y, C.x - B.x);
  let delta = ang2 - ang1;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  const sweep = delta >= 0 ? 1 : 0;
  const p1 = { x: B.x + Math.cos(ang1) * r, y: B.y + Math.sin(ang1) * r };
  const p2 = {
    x: B.x + Math.cos(ang1 + delta) * r,
    y: B.y + Math.sin(ang1 + delta) * r,
  };
  const d = `M ${f1(p1.x)} ${f1(p1.y)} A ${r} ${r} 0 0 ${sweep} ${f1(p2.x)} ${f1(p2.y)}`;
  const midAng = ang1 + delta / 2;
  const mid = {
    x: B.x + Math.cos(midAng) * (r + 18),
    y: B.y + Math.sin(midAng) * (r + 18),
  };
  return { d, mid, delta };
}

/* --------------------------- 已完成的标注 --------------------------- */

type AnnHandles = {
  line?: Twin;
  line2?: Twin;
  tick1?: Twin;
  tick2?: Twin;
  poly?: Twin;
  arc?: Twin;
  circle?: Twin;
  cross1?: Twin;
  cross2?: Twin;
  fill?: SVGPolygonElement;
};

type AnnNodes = {
  group: SVGGElement;
  halo: SVGGElement;
  main: SVGGElement;
  handles: AnnHandles;
  dots: { ring: SVGCircleElement; main: SVGCircleElement }[];
  label: HTMLDivElement;
};

type AnnRec = { m: Measurement; n: AnnNodes };

function pair(
  halo: SVGGElement,
  main: SVGGElement,
  tag: "line" | "polyline" | "path" | "circle"
): Twin {
  const h = svgEl(tag) as SVGElement;
  const m = svgEl(tag) as SVGElement;
  halo.append(h);
  main.append(m);
  return { main: m, halo: h };
}

function buildAnn(ink: Ink, m: Measurement, labels: HTMLElement): AnnNodes {
  const group = svgEl("g");
  group.setAttribute("data-measure-id", `${m.id}`);

  const halo = svgEl("g");
  halo.setAttribute("fill", "none");
  halo.setAttribute("stroke", ink.halo);
  halo.setAttribute("stroke-opacity", "0.9");
  halo.setAttribute("stroke-width", "4.5");
  halo.setAttribute("stroke-linecap", "round");
  halo.setAttribute("stroke-linejoin", "round");

  const main = svgEl("g");
  main.setAttribute("fill", "none");
  main.setAttribute("stroke", ink.accent);
  main.setAttribute("stroke-width", "1.5");
  main.setAttribute("stroke-linecap", "round");
  main.setAttribute("stroke-linejoin", "round");

  const dotsG = svgEl("g");
  group.append(halo, main, dotsG);

  const handles: AnnHandles = {};

  switch (m.kind) {
    case "distance":
      handles.line = pair(halo, main, "line");
      handles.tick1 = pair(halo, main, "line");
      handles.tick2 = pair(halo, main, "line");
      break;
    case "length":
      handles.poly = pair(halo, main, "polyline");
      break;
    case "area": {
      const fill = svgEl("polygon");
      fill.setAttribute("fill", ink.accent);
      fill.setAttribute("fill-opacity", "0.1");
      fill.setAttribute("stroke", "none");
      fill.style.display = "none";
      main.append(fill);
      handles.fill = fill;
      handles.poly = pair(halo, main, "polyline");
      break;
    }
    case "angle":
      handles.line = pair(halo, main, "line");
      handles.line2 = pair(halo, main, "line");
      handles.arc = pair(halo, main, "path");
      break;
    case "radius":
      handles.circle = pair(halo, main, "circle");
      handles.cross1 = pair(halo, main, "line");
      handles.cross2 = pair(halo, main, "line");
      break;
    case "coord":
      handles.cross1 = pair(halo, main, "line");
      handles.cross2 = pair(halo, main, "line");
      break;
  }

  const dots: AnnNodes["dots"] = [];
  const dotCount = Math.min(m.points.length, 96);
  for (let i = 0; i < dotCount; i++) {
    const ring = svgEl("circle");
    ring.setAttribute("fill", ink.halo);
    ring.setAttribute("r", "4.2");
    const dot = svgEl("circle");
    dot.setAttribute("fill", ink.accent);
    dot.setAttribute("r", "2.4");
    dotsG.append(ring, dot);
    dots.push({ ring, main: dot });
  }

  const label = makeLabel();
  label.textContent = m.note ? `${m.text} · ${m.note}` : m.text;
  labels.append(label);

  return { group, halo, main, handles, dots, label };
}

function updateAnn(rec: AnnRec, P: (x: number, y: number) => Pt) {
  const { m, n } = rec;
  const H = n.handles;
  const pts = m.points.map((p) => P(p.x, p.y));

  for (let i = 0; i < n.dots.length; i++) {
    const s = pts[i];
    if (!s) {
      showEl(n.dots[i].main, false);
      showEl(n.dots[i].ring, false);
      continue;
    }
    showEl(n.dots[i].main, true);
    showEl(n.dots[i].ring, true);
    setCenter(n.dots[i].main, s);
    setCenter(n.dots[i].ring, s);
  }

  switch (m.kind) {
    case "distance": {
      const [a, b] = pts;
      if (!a || !b) {
        hideTwin(H.line);
        hideTwin(H.tick1);
        hideTwin(H.tick2);
        showEl(n.label, false);
        return;
      }
      setLine(H.line, a, b);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = (-dy / len) * 5;
      const ny = (dx / len) * 5;
      setLine(H.tick1, { x: a.x - nx, y: a.y - ny }, { x: a.x + nx, y: a.y + ny });
      setLine(H.tick2, { x: b.x - nx, y: b.y - ny }, { x: b.x + nx, y: b.y + ny });
      placeLabel(
        n.label,
        (a.x + b.x) / 2 + (-dy / len) * 14,
        (a.y + b.y) / 2 + (dx / len) * 14
      );
      break;
    }
    case "length": {
      setPoly(H.poly, pts, false);
      if (pts.length < 2) {
        showEl(n.label, false);
        return;
      }
      const a = pts[pts.length - 2];
      const b = pts[pts.length - 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      placeLabel(
        n.label,
        (a.x + b.x) / 2 + (-dy / len) * 14,
        (a.y + b.y) / 2 + (dx / len) * 14
      );
      break;
    }
    case "area": {
      setPoly(H.poly, pts, true);
      if (H.fill) {
        const closed = pts.length > 2 ? [...pts, pts[0]] : pts;
        H.fill.setAttribute("points", pointsStr(closed, false));
        showEl(H.fill, pts.length > 2);
      }
      if (pts.length < 3) {
        showEl(n.label, false);
        return;
      }
      const c = centroid(pts);
      placeLabel(n.label, c.x, c.y);
      break;
    }
    case "angle": {
      const [a, b, c] = pts;
      if (!a || !b || !c) {
        hideTwin(H.line);
        hideTwin(H.line2);
        hideTwin(H.arc);
        showEl(n.label, false);
        return;
      }
      setLine(H.line, b, a);
      setLine(H.line2, b, c);
      const arc = angleArc(a, b, c);
      setPath(H.arc, arc.d);
      placeLabel(n.label, arc.mid.x, arc.mid.y);
      break;
    }
    case "radius": {
      if (pts.length < 3) {
        hideTwin(H.circle);
        hideTwin(H.cross1);
        hideTwin(H.cross2);
        showEl(n.label, false);
        return;
      }
      const cc = circumcircle(m.points[0], m.points[1], m.points[2]);
      if (!cc) {
        hideTwin(H.circle);
        hideTwin(H.cross1);
        hideTwin(H.cross2);
        const c = centroid(pts);
        placeLabel(n.label, c.x, c.y);
        return;
      }
      const sc = P(cc.c.x, cc.c.y);
      const edge = P(cc.c.x + cc.r, cc.c.y);
      const rpx = Math.hypot(edge.x - sc.x, edge.y - sc.y);
      setCircle(H.circle, sc, rpx);
      const k = 6;
      setLine(H.cross1, { x: sc.x - k, y: sc.y }, { x: sc.x + k, y: sc.y });
      setLine(H.cross2, { x: sc.x, y: sc.y - k }, { x: sc.x, y: sc.y + k });
      const off = Math.min(rpx * 0.707, 160);
      placeLabel(n.label, sc.x + off, sc.y - off);
      break;
    }
    case "coord": {
      const a = pts[0];
      if (!a) {
        hideTwin(H.cross1);
        hideTwin(H.cross2);
        showEl(n.label, false);
        return;
      }
      const k = 7;
      setLine(H.cross1, { x: a.x - k, y: a.y }, { x: a.x + k, y: a.y });
      setLine(H.cross2, { x: a.x, y: a.y - k }, { x: a.x, y: a.y + k });
      placeLabel(n.label, a.x + 18, a.y - 16);
      break;
    }
  }
}

/* ------------------------------ 预览层 ------------------------------ */

type LiveNodes = {
  layer: SVGGElement;
  halo: SVGGElement;
  main: SVGGElement;
  dotsG: SVGGElement;
  markG: SVGGElement;
  poly: Twin;
  rubber: Twin;
  arc: Twin;
  circle: Twin;
  cross: Twin;
  fill: SVGPolygonElement;
  dots: { ring: SVGCircleElement; main: SVGCircleElement }[];
  markHalo: SVGPathElement;
  markPath: SVGPathElement;
  markCircle: SVGCircleElement;
  markDot: SVGCircleElement;
  label: HTMLDivElement;
  snapLabel: HTMLDivElement;
};

function buildLive(ink: Ink, layer: SVGGElement, labels: HTMLElement): LiveNodes {
  layer.replaceChildren();

  const halo = svgEl("g");
  halo.setAttribute("fill", "none");
  halo.setAttribute("stroke", ink.halo);
  halo.setAttribute("stroke-opacity", "0.85");
  halo.setAttribute("stroke-width", "4.5");
  halo.setAttribute("stroke-linecap", "round");
  halo.setAttribute("stroke-linejoin", "round");

  const main = svgEl("g");
  main.setAttribute("fill", "none");
  main.setAttribute("stroke", ink.accent);
  main.setAttribute("stroke-width", "1.6");
  main.setAttribute("stroke-linecap", "round");
  main.setAttribute("stroke-linejoin", "round");

  const fill = svgEl("polygon");
  fill.setAttribute("fill", ink.accent);
  fill.setAttribute("fill-opacity", "0.08");
  fill.setAttribute("stroke", "none");
  fill.style.display = "none";
  main.append(fill);

  const poly = pair(halo, main, "polyline");
  const rubber = pair(halo, main, "line");
  const arc = pair(halo, main, "path");
  const circle = pair(halo, main, "circle");
  const cross = pair(halo, main, "path");
  hideTwin(poly);
  hideTwin(rubber);
  hideTwin(arc);
  hideTwin(circle);
  hideTwin(cross);
  // 皮筋用虚线：和已落下的实线区分开
  for (const el of [rubber.main, rubber.halo]) {
    el.setAttribute("stroke-dasharray", "5 4");
  }

  const dotsG = svgEl("g");

  const markG = svgEl("g");
  const markHalo = svgEl("path");
  markHalo.setAttribute("fill", ink.halo);
  markHalo.setAttribute("fill-opacity", "0.6");
  markHalo.setAttribute("stroke", ink.halo);
  markHalo.setAttribute("stroke-width", "3");
  markHalo.setAttribute("stroke-linejoin", "round");
  markHalo.style.display = "none";
  const markPath = svgEl("path");
  markPath.setAttribute("fill", ink.accent);
  markPath.setAttribute("fill-opacity", "0.18");
  markPath.setAttribute("stroke", ink.accent);
  markPath.setAttribute("stroke-width", "1.6");
  markPath.setAttribute("stroke-linejoin", "round");
  markPath.style.display = "none";
  const markCircle = svgEl("circle");
  markCircle.setAttribute("fill", "none");
  markCircle.setAttribute("stroke", ink.accent);
  markCircle.setAttribute("stroke-width", "1.6");
  markCircle.setAttribute("r", "5");
  markCircle.style.display = "none";
  const markDot = svgEl("circle");
  markDot.setAttribute("fill", ink.accent);
  markDot.setAttribute("r", "2.6");
  markDot.style.display = "none";
  markG.append(markHalo, markPath, markCircle, markDot);

  layer.append(halo, main, dotsG, markG);

  const label = makeLabel();
  const snapLabel = makeLabel();
  snapLabel.style.background = ink.accent;
  snapLabel.style.color = ink.snapFg;
  snapLabel.style.padding = "0px 4px";
  snapLabel.style.fontSize = "10px";
  labels.append(label, snapLabel);

  return {
    layer,
    halo,
    main,
    dotsG,
    markG,
    poly,
    rubber,
    arc,
    circle,
    cross,
    fill,
    dots: [],
    markHalo,
    markPath,
    markCircle,
    markDot,
    label,
    snapLabel,
  };
}

function ensureDots(nodes: LiveNodes, n: number, ink: Ink) {
  const want = Math.min(n, 128);
  while (nodes.dots.length < want) {
    const ring = svgEl("circle");
    ring.setAttribute("fill", ink.halo);
    ring.setAttribute("r", "4.2");
    const dot = svgEl("circle");
    dot.setAttribute("fill", ink.accent);
    dot.setAttribute("r", "2.4");
    nodes.dotsG.append(ring, dot);
    nodes.dots.push({ ring, main: dot });
  }
}

/** 吸附标记：端点/顶点=方，中点=三角，交点=菱形，圆心/象限点=圆，最近点=点 */
function markerPathFor(kind: SnapKind, x: number, y: number): string | null {
  const s = 5.5;
  switch (kind) {
    case "endpoint":
    case "vertex":
      return `M ${f1(x - s)} ${f1(y - s)} h ${f1(2 * s)} v ${f1(2 * s)} h ${f1(-2 * s)} z`;
    case "midpoint":
      return `M ${f1(x)} ${f1(y - s)} L ${f1(x + s)} ${f1(y + s * 0.8)} L ${f1(
        x - s
      )} ${f1(y + s * 0.8)} z`;
    case "intersection":
      return `M ${f1(x)} ${f1(y - s)} L ${f1(x + s)} ${f1(y)} L ${f1(x)} ${f1(
        y + s
      )} L ${f1(x - s)} ${f1(y)} z`;
    default:
      return null;
  }
}

/* ------------------------------ 组件 ------------------------------ */

type LiveState = {
  points: Vec2[];
  cursor: Vec2 | null;
  snap: SnapHit | null;
  inside: boolean;
};

export default function MeasureOverlay({
  api,
  engine,
  tool,
  measurements,
  dark,
  unitLabel,
  clearNonce,
  onCommit,
  onRemove,
  onExit,
}: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const persistRef = useRef<SVGGElement | null>(null);
  const liveLayerRef = useRef<SVGGElement | null>(null);
  const labelsRef = useRef<HTMLDivElement | null>(null);

  const annsRef = useRef<AnnRec[]>([]);
  const liveNodesRef = useRef<LiveNodes | null>(null);
  const liveRef = useRef<LiveState>({
    points: [],
    cursor: null,
    snap: null,
    inside: false,
  });
  const downRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const pendingRef = useRef<{ x: number; y: number } | null>(null);
  const rafRef = useRef(0);
  const hoverIdRef = useRef<number | null>(null);
  const inkRef = useRef<Ink>(inkFor(dark));
  inkRef.current = inkFor(dark);

  // 渲染期写 ref：事件回调 / rAF 里永远拿到最新值，且不会造成重渲染
  const apiRef = useRef(api);
  apiRef.current = api;
  const engineRef = useRef(engine);
  engineRef.current = engine;
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const cbRef = useRef({ onCommit, onRemove, onExit });
  cbRef.current = { onCommit, onRemove, onExit };

  const [hoverId, setHoverId] = useState<number | null>(null);
  hoverIdRef.current = hoverId;

  /* ---------- 坐标换算 ---------- */

  /** 屏幕点 → 吸附后的 WCS 点（吸附容差是 10 屏幕像素换算成 WCS） */
  const readPoint = useCallback(
    (clientX: number, clientY: number) => {
      const a = apiRef.current;
      if (!a?.clientToWcs) return null;
      let wcs: Vec2 | null = null;
      try {
        wcs = a.clientToWcs(clientX, clientY);
      } catch {
        wcs = null;
      }
      if (!wcs) return null;
      const perPx = a.wcsPerPixel?.() ?? 0;
      let snap: SnapHit | null = null;
      const eng = engineRef.current;
      if (eng && perPx > 0) {
        try {
          snap = eng.snap(wcs.x, wcs.y, perPx * SNAP_PX);
        } catch {
          snap = null;
        }
      }
      const cursor = snap ? { x: snap.x, y: snap.y } : wcs;
      return { wcs, snap, cursor };
    },
    []
  );

  /* ---------- rAF 合并 ---------- */

  const drawLive = useCallback((P: (x: number, y: number) => Pt) => {
    const nodes = liveNodesRef.current;
    if (!nodes) return;
    const st = liveRef.current;
    const t = toolRef.current;
    const eng = engineRef.current;
    const ink = inkRef.current;
    const pts = st.points;
    const cur = st.cursor;

    ensureDots(nodes, pts.length, ink);
    for (let i = 0; i < nodes.dots.length; i++) {
      const p = pts[i];
      if (!p) {
        showEl(nodes.dots[i].main, false);
        showEl(nodes.dots[i].ring, false);
        continue;
      }
      const s = P(p.x, p.y);
      showEl(nodes.dots[i].main, true);
      showEl(nodes.dots[i].ring, true);
      setCenter(nodes.dots[i].main, s);
      setCenter(nodes.dots[i].ring, s);
    }

    if (pts.length >= 2) {
      setPoly(
        nodes.poly,
        pts.map((p) => P(p.x, p.y)),
        false
      );
    } else {
      hideTwin(nodes.poly);
    }

    const last = pts[pts.length - 1];
    if (last && cur && st.inside) {
      const a = P(last.x, last.y);
      const b = P(cur.x, cur.y);
      setLine(nodes.rubber, a, b);
    } else {
      hideTwin(nodes.rubber);
    }

    if (t === "area" && cur && st.inside && pts.length >= 2) {
      setFill(nodes.fill, [...pts.map((p) => P(p.x, p.y)), P(cur.x, cur.y)]);
    } else {
      showEl(nodes.fill, false);
    }

    if (t === "angle" && cur && st.inside && pts.length >= 2) {
      const A = P(pts[0].x, pts[0].y);
      const B = P(pts[1].x, pts[1].y);
      const C = P(cur.x, cur.y);
      const arc = angleArc(A, B, C);
      setPath(nodes.arc, arc.d);
    } else {
      hideTwin(nodes.arc);
    }

    if (t === "radius" && cur && st.inside && pts.length >= 2) {
      const cc = circumcircle(pts[0], pts[1], cur);
      if (cc) {
        const sc = P(cc.c.x, cc.c.y);
        const edge = P(cc.c.x + cc.r, cc.c.y);
        setCircle(nodes.circle, sc, Math.hypot(edge.x - sc.x, edge.y - sc.y));
      } else {
        hideTwin(nodes.circle);
      }
    } else {
      hideTwin(nodes.circle);
    }

    if (t === "coord" && cur && st.inside) {
      const a = P(cur.x, cur.y);
      const k = 8;
      setPath(
        nodes.cross,
        `M ${f1(a.x - k)} ${f1(a.y)} h ${f1(2 * k)} M ${f1(a.x)} ${f1(
          a.y - k
        )} v ${f1(2 * k)}`
      );
    } else {
      hideTwin(nodes.cross);
    }

    // 光标标记 + 两个浮动读数
    const showCursor = !!cur && st.inside && !!t;
    if (!showCursor || !cur) {
      showEl(nodes.markHalo, false);
      showEl(nodes.markPath, false);
      showEl(nodes.markCircle, false);
      showEl(nodes.markDot, false);
      showEl(nodes.snapLabel, false);
      showEl(nodes.label, false);
      return;
    }

    const s = P(cur.x, cur.y);
    const kind = st.snap?.kind ?? null;
    const pathD = kind ? markerPathFor(kind, s.x, s.y) : null;
    const vw = svgRef.current?.clientWidth ?? 0;
    const vh = svgRef.current?.clientHeight ?? 0;

    showEl(nodes.markHalo, !!pathD);
    showEl(nodes.markPath, !!pathD);
    if (pathD) {
      nodes.markHalo.setAttribute("d", pathD);
      nodes.markPath.setAttribute("d", pathD);
    }
    const circleKind = kind === "center" || kind === "quadrant";
    showEl(nodes.markCircle, circleKind);
    if (circleKind) setCenter(nodes.markCircle, s);
    showEl(nodes.markDot, !kind || kind === "nearest");
    if (!kind || kind === "nearest") setCenter(nodes.markDot, s);

    if (kind) {
      nodes.snapLabel.textContent = SNAP_LABEL[kind];
      showEl(nodes.snapLabel, true);
      const snapFlip = vw > 0 && s.x + 70 > vw;
      const snapY = s.y - 26 < 0 ? s.y + 14 : s.y - 26;
      nodes.snapLabel.style.transform = snapFlip
        ? `translate3d(${f1(s.x - 14)}px, ${f1(snapY)}px, 0) translateX(-100%)`
        : `translate3d(${f1(s.x + 14)}px, ${f1(snapY)}px, 0)`;
    } else {
      showEl(nodes.snapLabel, false);
    }

    // 光标还停在刚落下的点、而且读数必然是 0 时不显示（只针对单段距离；
    // 连续长度 / 面积的总读数在落点那一刻仍然有意义）
    let nearLast = false;
    if (t === "distance" && last) {
      const lp = P(last.x, last.y);
      nearLast = Math.hypot(s.x - lp.x, s.y - lp.y) < 2;
    }
    const text = liveValue(t, pts, cur, eng);
    if (text && !nearLast) {
      nodes.label.textContent = text;
      showEl(nodes.label, true);
      // 靠右 / 靠下时把读数翻到光标另一侧，避免被画布边缘裁掉
      const flipX = vw > 0 && s.x + 170 > vw;
      const flipY = vh > 0 && s.y + 34 > vh;
      const lx = flipX ? s.x - 14 : s.x + 14;
      const ly = flipY ? s.y - 26 : s.y + 12;
      nodes.label.style.transform = flipX
        ? `translate3d(${f1(lx)}px, ${f1(ly)}px, 0) translateX(-100%)`
        : `translate3d(${f1(lx)}px, ${f1(ly)}px, 0)`;
    } else {
      showEl(nodes.label, false);
    }
  }, []);

  const draw = useCallback(() => {
    const svg = svgRef.current;
    const a = apiRef.current;
    if (!svg || !a?.project) return;

    // 指针的最新位置在这里换算/吸附：pointermove 本身只记坐标
    const pend = pendingRef.current;
    if (pend && toolRef.current) {
      const r = readPoint(pend.x, pend.y);
      if (r) {
        const st = liveRef.current;
        st.cursor = r.cursor;
        st.snap = r.snap;
        st.inside = true;
      }
    }

    let p0: Pt | null;
    let px: Pt | null;
    let py: Pt | null;
    try {
      p0 = a.project(0, 0);
      px = a.project(1, 0);
      py = a.project(0, 1);
    } catch {
      return;
    }
    if (!p0 || !px || !py) return;

    const ax = px.x - p0.x;
    const ay = px.y - p0.y;
    const bx = py.x - p0.x;
    const by = py.y - p0.y;
    const ox = p0.x;
    const oy = p0.y;
    const P = (x: number, y: number): Pt => ({
      x: ox + ax * x + bx * y,
      y: oy + ay * x + by * y,
    });

    for (const rec of annsRef.current) updateAnn(rec, P);
    drawLive(P);
  }, [drawLive, readPoint]);

  const schedule = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      draw();
    });
  }, [draw]);

  /* ---------- 提交一条测量 ---------- */

  const commit = useCallback((kind: MeasureTool, points: Vec2[]) => {
    const eng = engineRef.current;
    if (!eng) return;
    let value: number | null = null;
    let text = "";
    let note: string | undefined;

    try {
      switch (kind) {
        case "distance":
          value = eng.distance(points[0], points[1]);
          text = eng.fmt(value);
          break;
        case "length":
          value = eng.polylineLength(points);
          text = `L ${eng.fmt(value)}`;
          break;
        case "area": {
          const r = eng.polygonArea(points);
          value = r.area;
          text = `A ${eng.fmt(r.area, "area")}`;
          note = `周长 ${eng.fmt(r.perimeter)}`;
          break;
        }
        case "angle":
          value = eng.angleDeg(points[0], points[1], points[2]);
          text = `∠ ${eng.fmt(value, "angle")}`;
          break;
        case "radius": {
          const r = eng.radiusFrom3(points[0], points[1], points[2]);
          if (r == null) {
            text = "三点共线，无法确定半径";
          } else {
            value = r;
            text = `R ${eng.fmt(r)}`;
          }
          break;
        }
        case "coord":
          text = `X ${eng.fmt(points[0].x)}  Y ${eng.fmt(points[0].y)}`;
          break;
      }
    } catch {
      text = "计算失败";
      value = null;
    }

    if (!text) return;
    cbRef.current.onCommit({ kind, points, value, text, note });
  }, []);

  /** 落一个点；两点/三点定值的工具落满后立即收卷 */
  const placePoint = useCallback(
    (clientX: number, clientY: number) => {
      const t = toolRef.current;
      if (!t) return;
      const r = readPoint(clientX, clientY);
      if (!r) return;

      const st = liveRef.current;
      const p = r.cursor;

      // 双击的第二下会落在原处：忽略，交给 dblclick 收尾
      const last = st.points[st.points.length - 1];
      if (last) {
        const perPx = apiRef.current?.wcsPerPixel?.() ?? 0;
        if (perPx > 0 && Math.hypot(p.x - last.x, p.y - last.y) / perPx < DUP_PX) {
          st.cursor = p;
          st.snap = r.snap;
          schedule();
          return;
        }
      }

      st.points.push(p);
      st.cursor = p;
      st.snap = r.snap;
      st.inside = true;

      const pts = st.points;
      if (t === "distance" && pts.length >= 2) {
        commit(t, pts.slice(0, 2));
        pts.length = 0;
      } else if (t === "angle" && pts.length >= 3) {
        commit(t, pts.slice(0, 3));
        pts.length = 0;
      } else if (t === "radius" && pts.length >= 3) {
        commit(t, pts.slice(0, 3));
        pts.length = 0;
      } else if (t === "coord") {
        commit(t, pts.slice(0, 1));
        pts.length = 0;
      }
      schedule();
    },
    [commit, readPoint, schedule]
  );

  /** Enter / 双击：多段工具收尾 */
  const finish = useCallback(() => {
    const t = toolRef.current;
    const st = liveRef.current;
    if (!t || !st.points.length) return false;
    if (t === "length" && st.points.length >= 2) {
      commit(t, st.points.slice());
      st.points.length = 0;
      schedule();
      return true;
    }
    if (t === "area" && st.points.length >= 3) {
      commit(t, st.points.slice());
      st.points.length = 0;
      schedule();
      return true;
    }
    return false;
  }, [commit, schedule]);

  const cancelLive = useCallback(() => {
    const st = liveRef.current;
    st.points.length = 0;
    st.snap = null;
    schedule();
  }, [schedule]);

  // 「清除」：已存的结果由 App 清，正在取的点这里收掉
  useEffect(() => {
    if (!clearNonce) return;
    cancelLive();
    pendingRef.current = null;
    const st = liveRef.current;
    st.cursor = null;
    st.inside = false;
  }, [clearNonce, cancelLive]);

  /* ---------- 建层 ---------- */

  // 预览层（深/浅色切换时重建，同时刷新标签配色）
  useEffect(() => {
    const layer = liveLayerRef.current;
    const labels = labelsRef.current;
    if (!layer || !labels) return;
    const prev = liveNodesRef.current;
    if (prev) {
      prev.label.remove();
      prev.snapLabel.remove();
    }
    liveNodesRef.current = buildLive(inkFor(dark), layer, labels);
    schedule();
    return () => {
      // 卸载 / 重建时把这两个标签摘掉，避免残留在容器里
      const cur = liveNodesRef.current;
      if (cur) {
        cur.label.remove();
        cur.snapLabel.remove();
      }
    };
  }, [dark, schedule]);

  // 已完成的测量：数据变了才重建节点
  useEffect(() => {
    const root = persistRef.current;
    const labels = labelsRef.current;
    if (!root || !labels) return;
    root.replaceChildren();
    for (const rec of annsRef.current) rec.n.label.remove();
    annsRef.current = [];

    const ink = inkFor(dark);
    for (const m of measurements) {
      const nodes = buildAnn(ink, m, labels);
      root.append(nodes.group);
      annsRef.current.push({ m, n: nodes });
    }
    draw();
  }, [measurements, dark, draw]);

  // 悬停列表行：其余标注压暗
  useEffect(() => {
    const wanted = hoverId;
    // 行被删掉后悬停状态可能还指着旧 id：这时按"没有悬停"处理，别把剩下的全压暗
    const exists =
      wanted != null && annsRef.current.some((rec) => rec.m.id === wanted);
    const id = exists ? wanted : null;
    for (const rec of annsRef.current) {
      const dim = id != null && rec.m.id !== id;
      const emphasis = id != null && rec.m.id === id;
      rec.n.group.setAttribute("opacity", dim ? "0.32" : "1");
      rec.n.label.style.opacity = dim ? "0.32" : "1";
      rec.n.main.setAttribute("stroke-width", emphasis ? "2.4" : "1.5");
      rec.n.halo.setAttribute("stroke-width", emphasis ? "6" : "4.5");
    }
  }, [hoverId, measurements]);

  /* ---------- 指针 ---------- */

  const onCanvas = (t: EventTarget | null) =>
    t instanceof Element && !!t.closest("[data-dxf-canvas]");

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!toolRef.current || !engineRef.current) return;
      if (e.button !== 0 || !onCanvas(e.target)) return;
      downRef.current = { x: e.clientX, y: e.clientY, moved: false };
      pendingRef.current = { x: e.clientX, y: e.clientY };
      schedule();
    };

    const onMove = (e: PointerEvent) => {
      if (!toolRef.current) return;
      const down = downRef.current;
      if (down) {
        if (
          !down.moved &&
          Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_SLOP
        ) {
          // 变成拖拽（平移）：这次抬起不落点
          down.moved = true;
        }
      } else if (!onCanvas(e.target)) {
        return;
      }
      pendingRef.current = { x: e.clientX, y: e.clientY };
      schedule();
    };

    const onUp = (e: PointerEvent) => {
      const down = downRef.current;
      if (!down) return;
      downRef.current = null;
      const moved =
        down.moved ||
        Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_SLOP;
      if (moved) {
        schedule();
        return;
      }
      if (!toolRef.current) return;
      if (!onCanvas(e.target)) return;
      placePoint(e.clientX, e.clientY);
    };

    const onDblClick = (e: MouseEvent) => {
      if (!toolRef.current || !onCanvas(e.target)) return;
      if (finish()) e.preventDefault();
    };

    const onOut = (e: PointerEvent) => {
      if (onCanvas(e.relatedTarget)) return;
      pendingRef.current = null;
      const st = liveRef.current;
      st.inside = false;
      st.cursor = null;
      st.snap = null;
      schedule();
    };

    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("dblclick", onDblClick, true);
    window.addEventListener("pointerout", onOut, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("dblclick", onDblClick, true);
      window.removeEventListener("pointerout", onOut, true);
    };
  }, [finish, placePoint, schedule]);

  /* ---------- 键盘 ---------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!toolRef.current) return;
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable)
      ) {
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        cancelLive();
        cbRef.current.onExit();
      } else if (e.key === "Enter") {
        if (finish()) e.preventDefault();
      } else if (e.key === "Backspace") {
        const st = liveRef.current;
        if (st.points.length) {
          e.preventDefault();
          st.points.pop();
          schedule();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancelLive, finish, schedule]);

  /* ---------- 工具切换 / 视图订阅 / 尺寸 ---------- */

  // 换工具：丢掉还没落完的点
  useEffect(() => {
    const st = liveRef.current;
    st.points.length = 0;
    st.snap = null;
    if (!tool) {
      st.cursor = null;
      st.inside = false;
      pendingRef.current = null;
    }
    schedule();
  }, [tool, schedule]);

  // 测量态给画布一个十字光标（不碰相机、不碰图层）
  useEffect(() => {
    const host = document.querySelector<HTMLElement>("[data-dxf-canvas]");
    if (!host) return;
    const canvas = host.querySelector("canvas");
    const on = !!tool;
    host.style.cursor = on ? "crosshair" : "";
    if (canvas) canvas.style.cursor = on ? "crosshair" : "";
    return () => {
      host.style.cursor = "";
      if (canvas) canvas.style.cursor = "";
    };
  }, [tool]);

  useEffect(() => {
    if (!api?.onViewChange) return;
    return api.onViewChange(schedule);
  }, [api, schedule]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => schedule());
    ro.observe(svg);
    return () => ro.disconnect();
  }, [schedule]);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      annsRef.current = [];
    };
  }, []);

  // 引擎 / 图纸换了：已存的测量是 WCS，不用动；只让预览重新算
  useEffect(() => {
    schedule();
  }, [engine, api, schedule]);

  /* ---------- 渲染 ---------- */

  const total = measurements.length;

  return (
    <>
      <svg
        ref={svgRef}
        className="pointer-events-none absolute inset-0 size-full"
        aria-hidden="true"
        data-measure-overlay="1"
        data-measure-count={total}
      >
        <g ref={persistRef} />
        <g ref={liveLayerRef} />
      </svg>

      <div
        ref={labelsRef}
        className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
        aria-hidden="true"
      />

      {total > 0 && (
        <div
          className="pointer-events-auto absolute right-3 top-14 z-20 w-64 animate-in fade-in-0 slide-in-from-top-1 overflow-hidden rounded-2xl bg-card/95 p-4 shadow-lg backdrop-blur duration-150"
          data-measure-results="1"
        >
          <div className="flex items-center gap-1 text-[11px] leading-none text-muted-foreground">
            <span>测量结果</span>
            <span className="opacity-50">·</span>
            <span className="tabular-nums">{total}</span>
            <span className="opacity-50">·</span>
            <span className="min-w-0 truncate">单位 {unitLabel}</span>
          </div>
          {/* 极浅分隔线：只是把表头和列表分开，不抢画布 */}
          <div className="mt-2.5 border-t border-border/40" />
          <ScrollArea className="mt-2 max-h-60 [&_[data-slot=scroll-area-viewport]]:max-h-60">
            <ul className="space-y-2">
              {measurements.map((m) => (
                <li
                  key={m.id}
                  className="group -mx-2 flex items-start gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-muted/50"
                  onMouseEnter={() => setHoverId(m.id)}
                  onMouseLeave={() =>
                    setHoverId((cur) => (cur === m.id ? null : cur))
                  }
                >
                  <span className="mt-0.5 w-7 shrink-0 text-[11px] text-muted-foreground">
                    {MEASURE_LABEL[m.kind]}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className="block truncate text-xs font-medium tabular-nums text-foreground"
                      title={m.text}
                    >
                      {m.text}
                    </span>
                    {m.note && (
                      <span
                        className="block truncate text-[10px] text-muted-foreground"
                        title={m.note}
                      >
                        {m.note}
                      </span>
                    )}
                  </span>
                  <DockTooltip
                    content="删除这条测量"
                    wrapperClassName="-mr-0.5 shrink-0"
                  >
                    <button
                      type="button"
                      aria-label={`删除${MEASURE_LABEL[m.kind]}测量`}
                      className="rounded-full p-0.5 text-muted-foreground/55 opacity-0 transition-all hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                      onClick={() => onRemove(m.id)}
                    >
                      <X className="size-3" />
                    </button>
                  </DockTooltip>
                </li>
              ))}
            </ul>
          </ScrollArea>
        </div>
      )}
    </>
  );
}

/* --------------------------- 预览的实时读数 --------------------------- */

function liveValue(
  t: MeasureTool,
  pts: Vec2[],
  cur: Vec2 | null,
  eng: MeasureEngine | null
): string {
  if (!eng || !cur) return "";
  try {
    switch (t) {
      case "distance":
        return pts.length >= 1 ? eng.fmt(eng.distance(pts[0], cur)) : "";
      case "length":
        return pts.length >= 1
          ? `L ${eng.fmt(eng.polylineLength([...pts, cur]))}`
          : "";
      case "area":
        return pts.length >= 2
          ? `A ${eng.fmt(eng.polygonArea([...pts, cur]).area, "area")}`
          : "";
      case "angle":
        return pts.length >= 2
          ? `∠ ${eng.fmt(eng.angleDeg(pts[0], pts[1], cur), "angle")}`
          : "";
      case "radius": {
        if (pts.length < 2) return "";
        const r = eng.radiusFrom3(pts[0], pts[1], cur);
        return r == null ? "三点共线" : `R ${eng.fmt(r)}`;
      }
      case "coord":
        return `X ${eng.fmt(cur.x)}  Y ${eng.fmt(cur.y)}`;
    }
  } catch {
    return "";
  }
  return "";
}
