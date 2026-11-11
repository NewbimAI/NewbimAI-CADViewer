/**
 * 测量内核的**类型契约** + 实现。
 *
 * 坐标一律是**图纸 WCS**（与服务端/比对功能同一套约定）。
 *
 * 几何离散、bulge 圆弧、OCS、INSERT 变换、shoelace 面积、三点半径全部
 * 复用 `shared/geometry`（纯 ESM，无依赖）。本文件只负责：
 *   EntityToPrimitives → 线段 / 吸附候选 / 网格索引 / 单位与格式化。
 */

import { entityToPrimitives } from "../../../../shared/geometry/index.mjs";

import {
  angleDeg as angleDegMath,
  distance as distanceMath,
  polygonArea as polygonAreaMath,
  polylineLength as polylineLengthMath,
  radiusFrom3 as radiusFrom3Math,
} from "./math.ts";

import {
  SNAP_PRIORITY,
  createSnapIndex,
  fitCircularPolyline,
  type CandidateRecord,
  type SegmentRecord,
  type SnapIndex,
} from "./snap.ts";

export type Vec2 = { x: number; y: number };

/** 吸附类型：端点 / 中点 / 圆心 / 象限点 / 交点 / 线上最近点 / 顶点 */
export type SnapKind =
  | "endpoint"
  | "midpoint"
  | "center"
  | "quadrant"
  | "intersection"
  | "nearest"
  | "vertex";

export type SnapHit = { x: number; y: number; kind: SnapKind; dist: number };

/** `$INSUNITS` 映射结果 */
export type UnitInfo = { code: number; label: string; suffix: string };

export type BuildStats = { primitives: number; polylines: number; skipped: number };

export type MeasureEngine = {
  readonly ready: boolean;
  readonly units: UnitInfo;
  readonly primitiveCount: number;
  /** 用 dxf-viewer 的解析结果（GetDxf()）建立可吸附的几何索引 */
  build(dxf: unknown): BuildStats;
  clear(): void;
  /** 在 WCS 容差 tolWcs 内找最近的吸附点 */
  snap(x: number, y: number, tolWcs: number): SnapHit | null;
  /** 命中一条折线（长度测量用），返回其顶点（WCS） */
  pickPolyline(x: number, y: number, tolWcs: number): Vec2[] | null;
  distance(a: Vec2, b: Vec2): number;
  polylineLength(points: Vec2[]): number;
  polygonArea(points: Vec2[]): { area: number; perimeter: number };
  /** ∠ABC，B 为顶点，返回 0..180 度 */
  angleDeg(a: Vec2, b: Vec2, c: Vec2): number;
  radiusFrom3(a: Vec2, b: Vec2, c: Vec2): number | null;
  /** 按单位格式化：长度/面积/角度 */
  fmt(value: number, kind?: "length" | "area" | "angle"): string;
};

/* ------------------------------------------------------------------ */
/* 单位                                                                */
/* ------------------------------------------------------------------ */

const UNIT_TABLE: Record<number, { label: string; suffix: string }> = {
  0: { label: "图纸单位", suffix: "" },
  1: { label: "英寸", suffix: "in" },
  2: { label: "英尺", suffix: "ft" },
  3: { label: "英里", suffix: "mi" },
  4: { label: "毫米", suffix: "mm" },
  5: { label: "厘米", suffix: "cm" },
  6: { label: "米", suffix: "m" },
  7: { label: "千米", suffix: "km" },
  8: { label: "微英寸", suffix: "µin" },
  9: { label: "密尔", suffix: "mil" },
  10: { label: "码", suffix: "yd" },
  11: { label: "埃", suffix: "Å" },
  12: { label: "纳米", suffix: "nm" },
  13: { label: "微米", suffix: "µm" },
  14: { label: "分米", suffix: "dm" },
  15: { label: "十米", suffix: "dam" },
  16: { label: "百米", suffix: "hm" },
  17: { label: "京米", suffix: "Gm" },
  18: { label: "天文单位", suffix: "AU" },
  19: { label: "光年", suffix: "ly" },
  20: { label: "秒差距", suffix: "pc" },
};

function unitInfoOf(code: number): UnitInfo {
  const entry = UNIT_TABLE[code];
  if (entry) return { code, label: entry.label, suffix: entry.suffix };
  // 未知代码：按"图纸单位"显示，但保留原始 code，方便 UI 展示。
  return { code, label: "图纸单位", suffix: "" };
}

function unitCodeFromDocument(doc: unknown): number {
  if (!doc || typeof doc !== "object") return 0;
  const header = (doc as { header?: unknown }).header;
  if (!header || typeof header !== "object") return 0;

  const record = header as Record<string, unknown>;
  const raw = record["$INSUNITS"] ?? record["$insunits"];
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/** 千分位 + 两位小数（不依赖 Intl，输出稳定）。 */
function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  let v = value;
  // 避免出现 "-0.00"
  if (Math.abs(v) < 0.005) v = 0;
  const fixed = v.toFixed(2);
  const negative = fixed.startsWith("-");
  const body = negative ? fixed.slice(1) : fixed;
  const dot = body.indexOf(".");
  const intPart = dot < 0 ? body : body.slice(0, dot);
  const fracPart = dot < 0 ? "00" : body.slice(dot + 1);
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}.${fracPart}`;
}

/* ------------------------------------------------------------------ */
/* 实体 → 线段 / 吸附候选                                              */
/* ------------------------------------------------------------------ */

const MAX_SEGMENTS = 400_000;
/** 几何内核默认 6° 离散；测量显示 2 位小数，用 1° 把弦逼近误差压到 1e-5 量级。 */
const ARC_STEP_DEG = 1;

function finiteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function samePoint(a: Vec2, b: Vec2): boolean {
  const eps =
    1e-9 * (1 + Math.max(Math.abs(a.x), Math.abs(a.y), Math.abs(b.x), Math.abs(b.y)));
  return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;
}

/**
 * 候选点去重：按 1e-9 量化坐标做开放寻址哈希表。
 *
 * 用字符串 key 的 Map 在一个 5 万实体的图上要花 ~800ms，这里用
 * Int32Array 槽位 + 数值哈希，插入/查询都接近 O(1) 且几乎没有分配。
 * 槽位值 = 候选下标 + 1（0 表示空槽）。
 */
class CandidateDedupe {
  private slots: Int32Array;
  private mask: number;
  private used = 0;
  private readonly candidates: CandidateRecord[];

  constructor(candidates: CandidateRecord[]) {
    this.candidates = candidates;
    this.slots = new Int32Array(1 << 16);
    this.mask = (1 << 16) - 1;
  }

  private hash(qx: number, qy: number): number {
    let h = (qx | 0) ^ Math.imul(qy | 0, 0x9e3779b1);
    h ^= h >>> 16;
    h = Math.imul(h, 0x7feb352d);
    h ^= h >>> 15;
    h = Math.imul(h, 0x846ca68b);
    h ^= h >>> 16;
    return h >>> 0;
  }

  find(qx: number, qy: number): number {
    let slot = this.hash(qx, qy) & this.mask;
    const slots = this.slots;
    for (;;) {
      const v = slots[slot];
      if (v === 0) return -1;
      const c = this.candidates[v - 1];
      if (
        Math.round(c.x / 1e-9) === qx &&
        Math.round(c.y / 1e-9) === qy
      ) {
        return v - 1;
      }
      slot = (slot + 1) & this.mask;
    }
  }

  add(qx: number, qy: number, index: number): void {
    if ((this.used + 1) * 10 >= this.slots.length * 7) this.grow();
    this.insert(qx, qy, index);
    this.used++;
  }

  private insert(qx: number, qy: number, index: number): void {
    let slot = this.hash(qx, qy) & this.mask;
    while (this.slots[slot] !== 0) slot = (slot + 1) & this.mask;
    this.slots[slot] = index + 1;
  }

  private grow(): void {
    const next = new Int32Array(this.slots.length * 2);
    const old = this.slots;
    this.slots = next;
    this.mask = next.length - 1;
    for (let i = 0; i < old.length; i++) {
      const v = old[i];
      if (v === 0) continue;
      const c = this.candidates[v - 1];
      this.insert(Math.round(c.x / 1e-9), Math.round(c.y / 1e-9), v - 1);
    }
  }
}

class MeasureEngineImpl implements MeasureEngine {
  private unitsState: UnitInfo;
  private readonly unitOverride: number | undefined;

  private readyFlag = false;
  private primitiveCountState = 0;

  private segments: SegmentRecord[] = [];
  private candidates: CandidateRecord[] = [];
  private polylinePoints: Vec2[][] = [];
  private polylineClosed: boolean[] = [];
  private candidateDedupe = new CandidateDedupe([]);
  private skippedSegments = 0;
  private index: SnapIndex | null = null;

  constructor(opts?: { unitCode?: number }) {
    this.unitOverride =
      opts && typeof opts.unitCode === "number" ? opts.unitCode : undefined;
    this.unitsState = unitInfoOf(this.unitOverride ?? 0);
  }

  get ready(): boolean {
    return this.readyFlag;
  }

  get units(): UnitInfo {
    return this.unitsState;
  }

  get primitiveCount(): number {
    return this.primitiveCountState;
  }

  /* ---------------- 构建 ---------------- */

  build(dxf: unknown): BuildStats {
    this.resetGeometry();

    if (!dxf || typeof dxf !== "object") {
      return this.stats();
    }

    let skipped = 0;
    let capped = false;

    try {
      const doc = dxf as {
        header?: unknown;
        blocks?: unknown;
        entities?: unknown;
      };

      if (this.unitOverride === undefined) {
        this.unitsState = unitInfoOf(unitCodeFromDocument(doc));
      }

      const blocks =
        doc.blocks && typeof doc.blocks === "object" ? doc.blocks : {};
      const entities = Array.isArray(doc.entities) ? doc.entities : [];

      const ctx = {
        blocks,
        warnings: new Set<string>(),
        // dxf-viewer 的解析器把 ARC 的 50/51 组码直接转成弧度（且不写
        // angleLength），ELLIPSE 的 41/42 本来就是弧度，因此统一按弧度。
        angleUnits: "rad" as const,
        arcStepDeg: ARC_STEP_DEG,
        includeHatch: false,
      };

      for (let e = 0; e < entities.length; e++) {
        const entity = entities[e];
        if (!entity || typeof entity !== "object") {
          skipped++;
          continue;
        }
        if ((entity as { inPaperSpace?: unknown }).inPaperSpace) {
          skipped++;
          continue;
        }

        const result = entityToPrimitives(entity, ctx, null);
        const primitives = Array.isArray(result?.primitives)
          ? result.primitives
          : [];

        if (primitives.length === 0) {
          skipped++;
          continue;
        }

        for (let i = 0; i < primitives.length; i++) {
          const prim = primitives[i];
          if (!prim || typeof prim !== "object") continue;

          if (prim.kind === "text") {
            skipped++;
            continue;
          }

          if (prim.kind === "point") {
            this.primitiveCountState++;
            this.addCandidate(prim.x, prim.y, "vertex");
            continue;
          }

          if (prim.kind !== "polyline") continue;

          const closed = prim.closed === true;
          const pts = this.toPoints(prim.points);
          if (pts.length === 0) {
            skipped++;
            continue;
          }

          const outcome = this.addPolyline(pts, closed);
          if (outcome === "capped") {
            capped = true;
            break;
          }
        }

        if (capped) break;
      }
    } catch {
      // 任何意外都不应让测量引擎崩溃：保留已经建好的部分。
    }

    this.readyFlag = true;
    this.index = createSnapIndex(this.segments, this.candidates);

    return {
      primitives: this.primitiveCountState,
      polylines: this.polylinePoints.length,
      skipped: skipped + this.skippedSegments,
    };
  }

  clear(): void {
    this.resetGeometry();
  }

  private resetGeometry(): void {
    this.readyFlag = false;
    this.primitiveCountState = 0;
    this.segments = [];
    this.candidates = [];
    this.polylinePoints = [];
    this.polylineClosed = [];
    this.candidates = [];
    this.candidateDedupe = new CandidateDedupe(this.candidates);
    this.skippedSegments = 0;
    this.index = null;
  }

  private stats(): BuildStats {
    return {
      primitives: this.primitiveCountState,
      polylines: this.polylinePoints.length,
      skipped: this.skippedSegments,
    };
  }

  private toPoints(raw: unknown): Vec2[] {
    const out: Vec2[] = [];
    if (!Array.isArray(raw)) return out;
    for (let i = 0; i < raw.length; i++) {
      const p = raw[i];
      if (Array.isArray(p)) {
        if (finiteNumber(p[0]) && finiteNumber(p[1])) {
          out.push({ x: p[0], y: p[1] });
        }
      } else if (p && typeof p === "object") {
        const q = p as { x?: unknown; y?: unknown };
        if (finiteNumber(q.x) && finiteNumber(q.y)) {
          out.push({ x: q.x, y: q.y });
        }
      }
    }
    return out;
  }

  private addCandidate(x: number, y: number, kind: SnapKind): void {
    if (!finiteNumber(x) || !finiteNumber(y)) return;
    const qx = Math.round(x / 1e-9);
    const qy = Math.round(y / 1e-9);
    const existing = this.candidateDedupe.find(qx, qy);
    if (existing >= 0) {
      const prev = this.candidates[existing];
      if (SNAP_PRIORITY[kind] < SNAP_PRIORITY[prev.kind]) prev.kind = kind;
      return;
    }
    this.candidates.push({ x, y, kind });
    this.candidateDedupe.add(qx, qy, this.candidates.length - 1);
  }

  /**
   * 把一条 WCS 折线加入索引。返回 "capped" 表示触达线段上限，
   * 调用方应停止继续构建。
   */
  private addPolyline(pts: Vec2[], closed: boolean): "ok" | "capped" {
    const n = pts.length;
    const closing = closed && n >= 2 && !samePoint(pts[0], pts[n - 1]);
    const needed = n >= 2 ? (closing ? n : n - 1) : 0;

    if (this.segments.length + needed > MAX_SEGMENTS) {
      this.skippedSegments += needed;
      return "capped";
    }

    const polyIndex = this.polylinePoints.length;
    this.polylinePoints.push(pts);
    this.polylineClosed.push(closed);
    this.primitiveCountState++;

    // 圆 / 圆弧：用圆心 + 真实经过的象限点，代替密集的离散"顶点"。
    const circle = fitCircularPolyline(pts, closed);

    if (circle) {
      this.addCandidate(circle.cx, circle.cy, "center");
      for (let q = 0; q < circle.quadrants.length; q++) {
        const point = circle.quadrants[q];
        this.addCandidate(point.x, point.y, "quadrant");
      }
      if (!closed && n >= 2) {
        this.addCandidate(pts[0].x, pts[0].y, "endpoint");
        this.addCandidate(pts[n - 1].x, pts[n - 1].y, "endpoint");
      }
    } else {
      for (let i = 0; i < n; i++) {
        this.addCandidate(pts[i].x, pts[i].y, "vertex");
      }
      if (!closed && n >= 2) {
        this.addCandidate(pts[0].x, pts[0].y, "endpoint");
        this.addCandidate(pts[n - 1].x, pts[n - 1].y, "endpoint");
      }
    }

    for (let i = 0; i + 1 < n; i++) {
      this.addSegment(pts[i], pts[i + 1], polyIndex);
      // 圆/圆弧的顶点只是离散采样点，其中点没有 CAD 语义（而且会压过
      // 象限点），所以只在真实折线上登记中点。
      if (!circle) {
        this.addCandidate(
          (pts[i].x + pts[i + 1].x) / 2,
          (pts[i].y + pts[i + 1].y) / 2,
          "midpoint"
        );
      }
    }
    if (closing) {
      this.addSegment(pts[n - 1], pts[0], polyIndex);
      if (!circle) {
        this.addCandidate(
          (pts[n - 1].x + pts[0].x) / 2,
          (pts[n - 1].y + pts[0].y) / 2,
          "midpoint"
        );
      }
    }

    return "ok";
  }

  private addSegment(a: Vec2, b: Vec2, poly: number): void {
    if (this.segments.length >= MAX_SEGMENTS) {
      this.skippedSegments++;
      return;
    }
    if (samePoint(a, b)) return;
    this.segments.push({
      ax: a.x,
      ay: a.y,
      bx: b.x,
      by: b.y,
      minX: Math.min(a.x, b.x),
      minY: Math.min(a.y, b.y),
      maxX: Math.max(a.x, b.x),
      maxY: Math.max(a.y, b.y),
      poly,
    });
  }

  /* ---------------- 查询 ---------------- */

  snap(x: number, y: number, tolWcs: number): SnapHit | null {
    return this.index ? this.index.snap(x, y, tolWcs) : null;
  }

  /**
   * 命中折线的 WCS 点。闭口折线在末尾重复首点，这样
   * `polylineLength(points)` 与 `polygonArea(points)` 都直接得到闭合结果。
   */
  pickPolyline(x: number, y: number, tolWcs: number): Vec2[] | null {
    if (!this.index) return null;
    const poly = this.index.pickPolyline(x, y, tolWcs);
    if (poly === null || poly < 0) return null;

    const source = this.polylinePoints[poly];
    const out: Vec2[] = source.map((p) => ({ x: p.x, y: p.y }));
    if (this.polylineClosed[poly] && out.length > 1) {
      const first = out[0];
      const last = out[out.length - 1];
      if (first.x !== last.x || first.y !== last.y) {
        out.push({ x: first.x, y: first.y });
      }
    }
    return out;
  }

  /* ---------------- 数学 ---------------- */

  distance(a: Vec2, b: Vec2): number {
    return distanceMath(a, b);
  }

  polylineLength(points: Vec2[]): number {
    return polylineLengthMath(points);
  }

  polygonArea(points: Vec2[]): { area: number; perimeter: number } {
    return polygonAreaMath(points);
  }

  angleDeg(a: Vec2, b: Vec2, c: Vec2): number {
    return angleDegMath(a, b, c);
  }

  radiusFrom3(a: Vec2, b: Vec2, c: Vec2): number | null {
    return radiusFrom3Math(a, b, c);
  }

  /* ---------------- 格式化 ---------------- */

  fmt(value: number, kind: "length" | "area" | "angle" = "length"): string {
    const number = formatNumber(value);
    if (kind === "angle") return `${number}°`;

    const suffix = this.unitsState.suffix;
    if (!suffix) return number;
    return kind === "area" ? `${number} ${suffix}²` : `${number} ${suffix}`;
  }
}

export function createMeasureEngine(
  dxf: unknown,
  opts?: { unitCode?: number }
): MeasureEngine {
  const engine = new MeasureEngineImpl(opts);
  if (dxf !== undefined && dxf !== null) {
    engine.build(dxf);
  }
  return engine;
}
