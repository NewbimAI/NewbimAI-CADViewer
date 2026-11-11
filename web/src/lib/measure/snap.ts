/**
 * 测量内核的吸附 / 拾取索引。
 *
 * - 线段索引：均匀网格（cell ≈ 线段包围盒中位数，做上下限钳制），
 *   只把线段放进其包围盒覆盖的单元；超长线段进入 `oversized` 列表，
 *   查询时按包围盒预筛。
 * - 候选点索引：端点 / 顶点 / 圆心 / 中点 / 象限点，另用一张同精度的网格。
 * - 交点只在光标所在 3×3 单元内两两求交，配对数上限 4000，绝不 O(n²)。
 *
 * 所有坐标均为图纸 WCS。
 */

import type { SnapHit, SnapKind } from "./index.ts";
import {
  circumcenter,
  closestPointOnSegment,
  pointSegmentDistanceSq,
  segmentIntersection,
} from "./math.ts";

export type SegmentRecord = {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** 所属折线在引擎里的下标（pickPolyline 用）。 */
  poly: number;
};

export type CandidateRecord = {
  x: number;
  y: number;
  kind: SnapKind;
};

/** 吸附优先级：数字越小越优先。 */
export const SNAP_PRIORITY: Record<SnapKind, number> = {
  endpoint: 0,
  vertex: 1,
  center: 2,
  midpoint: 3,
  quadrant: 4,
  intersection: 5,
  nearest: 6,
};

export type SnapIndex = {
  snap(x: number, y: number, tolWcs: number): SnapHit | null;
  pickPolyline(x: number, y: number, tolWcs: number): number | null;
};

/* ------------------------------------------------------------------ */
/* 网格                                                                */
/* ------------------------------------------------------------------ */

const MAX_GRID_AXIS = 2048;
const MAX_CELLS_PER_SEGMENT = 256;
const MAX_QUERY_CELLS = 4096;
const MAX_INTERSECTION_PAIRS = 4000;

type Grid = {
  cells: Map<number, number[]>;
  oversized: number[];
  rows: number;
  cols: number;
};

type BBox = { minX: number; minY: number; maxX: number; maxY: number };

function clampInt(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

function cellIndexOf(
  v: number,
  min: number,
  cell: number,
  count: number
): number {
  return clampInt(Math.floor((v - min) / cell), 0, count - 1);
}

function medianSegmentSize(segments: SegmentRecord[]): number {
  if (segments.length === 0) return 0;
  const step = Math.max(1, Math.floor(segments.length / 20000));
  const sample: number[] = [];
  for (let i = 0; i < segments.length; i += step) {
    const s = segments[i];
    const size = Math.max(s.maxX - s.minX, s.maxY - s.minY);
    if (size > 0 && Number.isFinite(size)) sample.push(size);
  }
  if (sample.length === 0) return 0;
  sample.sort((a, b) => a - b);
  return sample[sample.length >> 1];
}

function boundsOf(
  segments: SegmentRecord[],
  candidates: CandidateRecord[]
): BBox | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;

  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    any = true;
    if (s.minX < minX) minX = s.minX;
    if (s.minY < minY) minY = s.minY;
    if (s.maxX > maxX) maxX = s.maxX;
    if (s.maxY > maxY) maxY = s.maxY;
  }
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) continue;
    any = true;
    if (c.x < minX) minX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.x > maxX) maxX = c.x;
    if (c.y > maxY) maxY = c.y;
  }

  return any ? { minX, minY, maxX, maxY } : null;
}

function chooseCellSize(segments: SegmentRecord[], bbox: BBox): number {
  const extent = Math.max(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY) || 1;
  const minCell = extent / (MAX_GRID_AXIS - 1);
  const maxCell = extent / 8;
  let median = medianSegmentSize(segments);
  if (!(median > 0) || !Number.isFinite(median)) median = extent / 64;
  return Math.min(maxCell, Math.max(minCell, median));
}

function gridDimensions(bbox: BBox, cell: number): { cols: number; rows: number } {
  return {
    cols: clampInt(Math.floor((bbox.maxX - bbox.minX) / cell) + 1, 1, MAX_GRID_AXIS),
    rows: clampInt(Math.floor((bbox.maxY - bbox.minY) / cell) + 1, 1, MAX_GRID_AXIS),
  };
}

function buildSegmentGrid(
  segments: SegmentRecord[],
  cell: number,
  bbox: BBox
): Grid {
  const { cols, rows } = gridDimensions(bbox, cell);
  const grid: Grid = { cells: new Map(), oversized: [], rows, cols };

  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const ix0 = cellIndexOf(s.minX, bbox.minX, cell, cols);
    const ix1 = cellIndexOf(s.maxX, bbox.minX, cell, cols);
    const iy0 = cellIndexOf(s.minY, bbox.minY, cell, rows);
    const iy1 = cellIndexOf(s.maxY, bbox.minY, cell, rows);
    const count = (ix1 - ix0 + 1) * (iy1 - iy0 + 1);
    if (count > MAX_CELLS_PER_SEGMENT) {
      grid.oversized.push(i);
      continue;
    }
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        const key = ix * rows + iy;
        const bucket = grid.cells.get(key);
        if (bucket) bucket.push(i);
        else grid.cells.set(key, [i]);
      }
    }
  }
  return grid;
}

function buildCandidateGrid(
  candidates: CandidateRecord[],
  cell: number,
  bbox: BBox
): Grid {
  const { cols, rows } = gridDimensions(bbox, cell);
  const grid: Grid = { cells: new Map(), oversized: [], rows, cols };

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const ix = cellIndexOf(c.x, bbox.minX, cell, cols);
    const iy = cellIndexOf(c.y, bbox.minY, cell, rows);
    const key = ix * rows + iy;
    const bucket = grid.cells.get(key);
    if (bucket) bucket.push(i);
    else grid.cells.set(key, [i]);
  }
  return grid;
}

/* ------------------------------------------------------------------ */
/* 圆 / 圆弧识别（从离散折线反推圆心、半径、真实经过的象限点）         */
/* ------------------------------------------------------------------ */

export type CircleFit = {
  cx: number;
  cy: number;
  r: number;
  quadrants: { x: number; y: number }[];
};

function pointOnPolyline(
  px: number,
  py: number,
  points: readonly { x: number; y: number }[],
  closed: boolean
): number {
  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const d = pointSegmentDistanceSq(px, py, a.x, a.y, b.x, b.y);
    if (d < best) best = d;
  }
  if (closed && points.length > 1) {
    const a = points[points.length - 1];
    const b = points[0];
    const d = pointSegmentDistanceSq(px, py, a.x, a.y, b.x, b.y);
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/**
 * 判断一条离散折线是不是圆 / 圆弧（几何内核把 ARC、CIRCLE、bulge 弧
 * 都离散成了折线）。是则返回圆心、半径，以及**确实落在曲线上**的
 * 0/90/180/270° 象限点。
 *
 * 判定很保守：少于 4 个点、所有点不在同一圆上（例如椭圆、圆角矩形）、
 * 或弦长相对半径过大（矩形/正多边形）都返回 null，避免引入假的圆心吸附。
 */
export function fitCircularPolyline(
  points: readonly { x: number; y: number }[],
  closed: boolean
): CircleFit | null {
  const n = points.length;
  if (n < 4) return null;

  const i1 = Math.floor(n / 3);
  const i2 = Math.floor((2 * n) / 3);
  if (i1 <= 0 || i2 <= i1 || i2 >= n) return null;

  const fit = circumcenter(points[0], points[i1], points[i2]);
  if (!fit) return null;

  const { x: cx, y: cy, r } = fit;
  const scale = Math.max(1, Math.abs(cx), Math.abs(cy), r);
  const radialTol = Math.max(1e-6 * r, 1e-9 * scale);

  for (let i = 0; i < n; i++) {
    const p = points[i];
    const d = Math.hypot(p.x - cx, p.y - cy);
    if (Math.abs(d - r) > radialTol) return null;
  }

  // 排除"顶点都落在外接圆上"的多边形（矩形/正多边形）：真实圆弧离散后
  // 弦长相对半径很小（1° 步长时约 0.0175·r），而 4 点矩形约 1.4·r。
  const maxChord = 0.1 * r;
  for (let i = 1; i < n; i++) {
    if (
      Math.hypot(
        points[i].x - points[i - 1].x,
        points[i].y - points[i - 1].y
      ) > maxChord
    ) {
      return null;
    }
  }
  if (closed && n > 1) {
    if (
      Math.hypot(
        points[n - 1].x - points[0].x,
        points[n - 1].y - points[0].y
      ) > maxChord
    ) {
      return null;
    }
  }

  // 离散折线在 1° 步长下与真实圆弧的最大偏差约为 r·(1-cos0.5°)≈3.8e-5·r，
  // 取 5e-4·r 作为"象限点确实落在曲线上"的容差。
  const onCurveTol = Math.max(5e-4 * r, 1e-9 * scale);
  const quadrants: { x: number; y: number }[] = [];
  const dirs = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ];
  for (let i = 0; i < dirs.length; i++) {
    const qx = cx + r * dirs[i][0];
    const qy = cy + r * dirs[i][1];
    if (pointOnPolyline(qx, qy, points, closed) <= onCurveTol) {
      quadrants.push({ x: qx, y: qy });
    }
  }

  return { cx, cy, r, quadrants };
}

/* ------------------------------------------------------------------ */
/* 索引实现                                                            */
/* ------------------------------------------------------------------ */

class SnapIndexImpl implements SnapIndex {
  private readonly segments: SegmentRecord[];
  private readonly candidates: CandidateRecord[];
  private readonly cell: number;
  private readonly bbox: BBox;
  private readonly segGrid: Grid;
  private readonly candGrid: Grid;
  private readonly segStamp: Int32Array;
  private readonly candStamp: Int32Array;
  private generation = 0;

  constructor(segments: SegmentRecord[], candidates: CandidateRecord[]) {
    this.segments = segments;
    this.candidates = candidates;

    const bbox = boundsOf(segments, candidates) ?? {
      minX: 0,
      minY: 0,
      maxX: 0,
      maxY: 0,
    };
    this.bbox = bbox;
    this.cell = chooseCellSize(segments, bbox);
    this.segGrid = buildSegmentGrid(segments, this.cell, bbox);
    this.candGrid = buildCandidateGrid(candidates, this.cell, bbox);
    this.segStamp = new Int32Array(segments.length);
    this.candStamp = new Int32Array(candidates.length);
  }

  /* ---------------- 查询辅助 ---------------- */

  private nextGeneration(): number {
    this.generation++;
    if (this.generation >= 0x7fffffff) {
      this.segStamp.fill(0);
      this.candStamp.fill(0);
      this.generation = 1;
    }
    return this.generation;
  }

  private rangeOutside(x0: number, y0: number, x1: number, y1: number): boolean {
    const b = this.bbox;
    return x1 < b.minX || x0 > b.maxX || y1 < b.minY || y0 > b.maxY;
  }

  private collectSegments(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    out: number[]
  ): void {
    if (this.segments.length === 0) return;
    if (x0 > x1) {
      const t = x0;
      x0 = x1;
      x1 = t;
    }
    if (y0 > y1) {
      const t = y0;
      y0 = y1;
      y1 = t;
    }
    if (this.rangeOutside(x0, y0, x1, y1)) return;

    const gen = this.nextGeneration();
    const stamp = this.segStamp;
    const grid = this.segGrid;
    const b = this.bbox;
    const cell = this.cell;

    const ix0 = cellIndexOf(x0, b.minX, cell, grid.cols);
    const ix1 = cellIndexOf(x1, b.minX, cell, grid.cols);
    const iy0 = cellIndexOf(y0, b.minY, cell, grid.rows);
    const iy1 = cellIndexOf(y1, b.minY, cell, grid.rows);

    const span = (ix1 - ix0 + 1) * (iy1 - iy0 + 1);
    if (span > MAX_QUERY_CELLS) {
      for (let i = 0; i < this.segments.length; i++) {
        if (stamp[i] === gen) continue;
        stamp[i] = gen;
        out.push(i);
      }
    } else {
      for (let ix = ix0; ix <= ix1; ix++) {
        for (let iy = iy0; iy <= iy1; iy++) {
          const bucket = grid.cells.get(ix * grid.rows + iy);
          if (!bucket) continue;
          for (let k = 0; k < bucket.length; k++) {
            const i = bucket[k];
            if (stamp[i] === gen) continue;
            stamp[i] = gen;
            out.push(i);
          }
        }
      }
    }

    // 超长线段：数量通常很少，按包围盒预筛后并入。
    for (let k = 0; k < grid.oversized.length; k++) {
      const i = grid.oversized[k];
      const s = this.segments[i];
      if (s.maxX < x0 || s.minX > x1 || s.maxY < y0 || s.minY > y1) {
        continue;
      }
      if (stamp[i] === gen) continue;
      stamp[i] = gen;
      out.push(i);
    }
  }

  private collectCandidates(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    out: number[]
  ): void {
    if (this.candidates.length === 0) return;
    if (x0 > x1) {
      const t = x0;
      x0 = x1;
      x1 = t;
    }
    if (y0 > y1) {
      const t = y0;
      y0 = y1;
      y1 = t;
    }
    if (this.rangeOutside(x0, y0, x1, y1)) return;

    const gen = this.nextGeneration();
    const stamp = this.candStamp;
    const grid = this.candGrid;
    const b = this.bbox;
    const cell = this.cell;

    const ix0 = cellIndexOf(x0, b.minX, cell, grid.cols);
    const ix1 = cellIndexOf(x1, b.minX, cell, grid.cols);
    const iy0 = cellIndexOf(y0, b.minY, cell, grid.rows);
    const iy1 = cellIndexOf(y1, b.minY, cell, grid.rows);

    const span = (ix1 - ix0 + 1) * (iy1 - iy0 + 1);
    if (span > MAX_QUERY_CELLS) {
      for (let i = 0; i < this.candidates.length; i++) {
        if (stamp[i] === gen) continue;
        stamp[i] = gen;
        out.push(i);
      }
      return;
    }

    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        const bucket = grid.cells.get(ix * grid.rows + iy);
        if (!bucket) continue;
        for (let k = 0; k < bucket.length; k++) {
          const i = bucket[k];
          if (stamp[i] === gen) continue;
          stamp[i] = gen;
          out.push(i);
        }
      }
    }
  }

  private cellBounds(
    ix0: number,
    iy0: number,
    ix1: number,
    iy1: number
  ): { x0: number; y0: number; x1: number; y1: number } {
    const b = this.bbox;
    const cell = this.cell;
    return {
      x0: b.minX + ix0 * cell,
      y0: b.minY + iy0 * cell,
      x1: b.minX + (ix1 + 1) * cell,
      y1: b.minY + (iy1 + 1) * cell,
    };
  }

  /* ---------------- 公共 API ---------------- */

  snap(x: number, y: number, tolWcs: number): SnapHit | null {
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(tolWcs) ||
      tolWcs <= 0
    ) {
      return null;
    }

    const tol2 = tolWcs * tolWcs;
    const best = {
      kind: null as SnapKind | null,
      x: 0,
      y: 0,
      distSq: Infinity,
    };

    const consider = (px: number, py: number, kind: SnapKind, d2: number) => {
      if (!(d2 <= tol2)) return;
      if (best.kind === null) {
        best.kind = kind;
        best.x = px;
        best.y = py;
        best.distSq = d2;
        return;
      }
      const p = SNAP_PRIORITY[kind];
      const bp = SNAP_PRIORITY[best.kind];
      if (p < bp || (p === bp && d2 < best.distSq)) {
        best.kind = kind;
        best.x = px;
        best.y = py;
        best.distSq = d2;
      }
    };

    // 1) 预建候选点（端点/顶点/圆心/中点/象限点）
    const candIdx: number[] = [];
    this.collectCandidates(x - tolWcs, y - tolWcs, x + tolWcs, y + tolWcs, candIdx);
    for (let i = 0; i < candIdx.length; i++) {
      const c = this.candidates[candIdx[i]];
      const dx = c.x - x;
      const dy = c.y - y;
      consider(c.x, c.y, c.kind, dx * dx + dy * dy);
    }

    // 端点 / 顶点已经是最高两级优先级，无需再算交点和最近点。
    if (best.kind !== null && SNAP_PRIORITY[best.kind] <= 1) {
      return this.hit(best);
    }

    // 2) 交点：仅在光标所在 3×3 单元内
    if (
      best.kind === null ||
      SNAP_PRIORITY[best.kind] > SNAP_PRIORITY.intersection
    ) {
      const b = this.bbox;
      const ix = cellIndexOf(x, b.minX, this.cell, this.segGrid.cols);
      const iy = cellIndexOf(y, b.minY, this.cell, this.segGrid.rows);
      const ix0 = Math.max(0, ix - 1);
      const iy0 = Math.max(0, iy - 1);
      const ix1 = Math.min(this.segGrid.cols - 1, ix + 1);
      const iy1 = Math.min(this.segGrid.rows - 1, iy + 1);
      const bounds = this.cellBounds(ix0, iy0, ix1, iy1);

      const segIdx: number[] = [];
      this.collectSegments(bounds.x0, bounds.y0, bounds.x1, bounds.y1, segIdx);

      let pairs = 0;
      let stopped = false;
      for (let i = 0; i < segIdx.length && !stopped; i++) {
        const si = this.segments[segIdx[i]];
        for (let j = i + 1; j < segIdx.length; j++) {
          if (++pairs > MAX_INTERSECTION_PAIRS) {
            stopped = true;
            break;
          }
          const sj = this.segments[segIdx[j]];
          const p = segmentIntersection(
            si.ax, si.ay, si.bx, si.by,
            sj.ax, sj.ay, sj.bx, sj.by
          );
          if (!p) continue;
          const dx = p.x - x;
          const dy = p.y - y;
          consider(p.x, p.y, "intersection", dx * dx + dy * dy);
        }
      }
    }

    if (best.kind !== null) return this.hit(best);

    // 3) 线上最近点（最低优先级，只有前面都没命中才算）
    const segIdx: number[] = [];
    this.collectSegments(x - tolWcs, y - tolWcs, x + tolWcs, y + tolWcs, segIdx);
    for (let i = 0; i < segIdx.length; i++) {
      const s = this.segments[segIdx[i]];
      const p = closestPointOnSegment(x, y, s.ax, s.ay, s.bx, s.by);
      consider(p.x, p.y, "nearest", p.distSq);
    }

    return best.kind === null ? null : this.hit(best);
  }

  pickPolyline(x: number, y: number, tolWcs: number): number | null {
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(tolWcs) ||
      tolWcs <= 0
    ) {
      return null;
    }

    const tol2 = tolWcs * tolWcs;
    const segIdx: number[] = [];
    this.collectSegments(x - tolWcs, y - tolWcs, x + tolWcs, y + tolWcs, segIdx);

    let bestPoly = -1;
    let bestDistSq = Infinity;
    for (let i = 0; i < segIdx.length; i++) {
      const s = this.segments[segIdx[i]];
      const p = closestPointOnSegment(x, y, s.ax, s.ay, s.bx, s.by);
      if (p.distSq <= tol2 && p.distSq < bestDistSq) {
        bestDistSq = p.distSq;
        bestPoly = s.poly;
      }
    }
    return bestPoly < 0 ? null : bestPoly;
  }

  private hit(best: {
    kind: SnapKind | null;
    x: number;
    y: number;
    distSq: number;
  }): SnapHit {
    return {
      x: best.x,
      y: best.y,
      kind: best.kind as SnapKind,
      dist: Math.sqrt(best.distSq),
    };
  }
}

export function createSnapIndex(
  segments: SegmentRecord[],
  candidates: CandidateRecord[]
): SnapIndex {
  return new SnapIndexImpl(segments, candidates);
}
