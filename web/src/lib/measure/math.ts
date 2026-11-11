/**
 * 测量内核的数学 helpers。
 *
 * 这里只放"纯几何"函数：长度 / 面积 / 角度 / 三点圆 / 点到线段距离 /
 * 线段交点 / 外接圆心。能在 `shared/geometry` 里找到的能力一律复用，
 * 不重复实现（bulge 弧长、shoelace 面积、三点半径都来自几何内核）。
 */

import {
  bulgeToArc,
  polygonArea as kernelPolygonArea,
  radiusFrom3Points,
} from "../../../../shared/geometry/index.mjs";

export type PointLike = { x: number; y: number; bulge?: number };

const DEG = 180 / Math.PI;

/* ------------------------------------------------------------------ */
/* 基础                                                                */
/* ------------------------------------------------------------------ */

/** 两点距离。 */
export function distance(
  a: { x: number; y: number },
  b: { x: number; y: number }
): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * 折线长度。相邻点之间若带 `bulge`（LWPOLYLINE 的圆弧段语义），
 * 用内核的 bulge 弧长；否则用弦长。
 *
 * 闭口折线由调用方在末尾重复首点（pickPolyline 就是这么返回的）。
 */
export function polylineLength(points: readonly PointLike[]): number {
  if (!Array.isArray(points) || points.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (!a || !b) continue;
    const bulge = a.bulge;
    if (typeof bulge === "number" && bulge !== 0) {
      const arc = bulgeToArc(a, b, bulge);
      if (arc) {
        total += arc.length;
        continue;
      }
    }
    total += distance(a, b);
  }
  return total;
}

/**
 * 多边形面积（shoelace，返回绝对值）与周长（按闭合环求和）。
 * 少于 3 个点面积按 0 处理。
 */
export function polygonArea(points: readonly PointLike[]): {
  area: number;
  perimeter: number;
} {
  if (!Array.isArray(points) || points.length === 0) {
    return { area: 0, perimeter: 0 };
  }

  const area = Math.abs(kernelPolygonArea(points as PointLike[]));

  const n = points.length;
  let perimeter = 0;
  if (n >= 2) {
    for (let i = 0; i < n; i++) {
      const a = points[i];
      const b = points[(i + 1) % n];
      if (!a || !b) continue;
      perimeter += distance(a, b);
    }
  }
  return { area, perimeter };
}

/** ∠ABC（B 为顶点），返回 0..180 度。退化时返回 0。 */
export function angleDeg(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number }
): number {
  const x1 = a.x - b.x;
  const y1 = a.y - b.y;
  const x2 = c.x - b.x;
  const y2 = c.y - b.y;
  const la = Math.hypot(x1, y1);
  const lc = Math.hypot(x2, y2);
  if (!(la > 0) || !(lc > 0)) return 0;
  const cross = x1 * y2 - y1 * x2;
  const dot = x1 * x2 + y1 * y2;
  return Math.abs(Math.atan2(cross, dot)) * DEG;
}

/** 三点外接圆半径；共线（或退化）返回 null。复用几何内核。 */
export function radiusFrom3(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number }
): number | null {
  const r = radiusFrom3Points(a, b, c);
  return typeof r === "number" && Number.isFinite(r) ? r : null;
}

/* ------------------------------------------------------------------ */
/* 线段                                                                */
/* ------------------------------------------------------------------ */

/** 点到线段最近点（含端点钳制）。 */
export function closestPointOnSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): { x: number; y: number; distSq: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 0) {
    t = ((px - ax) * dx + (py - ay) * dy) / len2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
  }
  const x = ax + dx * t;
  const y = ay + dy * t;
  const ddx = px - x;
  const ddy = py - y;
  return { x, y, distSq: ddx * ddx + ddy * ddy };
}

/** 点到线段距离的平方。 */
export function pointSegmentDistanceSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  return closestPointOnSegment(px, py, ax, ay, bx, by).distSq;
}

/**
 * 两线段的交点（含端点接触）。平行 / 退化 / 不相交返回 null。
 */
export function segmentIntersection(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number
): { x: number; y: number } | null {
  const rx = bx - ax;
  const ry = by - ay;
  const sx = dx - cx;
  const sy = dy - cy;

  const den = rx * sy - ry * sx;
  const scale = Math.max(
    1,
    Math.abs(rx),
    Math.abs(ry),
    Math.abs(sx),
    Math.abs(sy)
  );
  if (!Number.isFinite(den) || Math.abs(den) <= 1e-12 * scale * scale) {
    return null;
  }

  const qpx = cx - ax;
  const qpy = cy - ay;
  const t = (qpx * sy - qpy * sx) / den;
  const u = (qpx * ry - qpy * rx) / den;
  const eps = 1e-9;
  if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) return null;

  return { x: ax + rx * t, y: ay + ry * t };
}

/* ------------------------------------------------------------------ */
/* 圆                                                                  */
/* ------------------------------------------------------------------ */

/**
 * 三点外接圆心。共线 / 退化返回 null。
 * （半径请用 `radiusFrom3`，它直接复用几何内核。）
 */
export function circumcenter(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number }
): { x: number; y: number; r: number } | null {
  const ax = a.x;
  const ay = a.y;
  const bx = b.x;
  const by = b.y;
  const cx = c.x;
  const cy = c.y;

  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  const scale = Math.max(
    1,
    Math.abs(ax),
    Math.abs(ay),
    Math.abs(bx),
    Math.abs(by),
    Math.abs(cx),
    Math.abs(cy)
  );
  if (!Number.isFinite(d) || Math.abs(d) <= 1e-12 * scale * scale) return null;

  const a2 = ax * ax + ay * ay;
  const b2 = bx * bx + by * by;
  const c2 = cx * cx + cy * cy;

  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
  const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  if (!Number.isFinite(ux) || !Number.isFinite(uy)) return null;

  const r = Math.hypot(ax - ux, ay - uy);
  if (!(r > 0) || !Number.isFinite(r)) return null;
  return { x: ux, y: uy, r };
}
