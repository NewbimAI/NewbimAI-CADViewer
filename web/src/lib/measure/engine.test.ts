/**
 * 测量内核测试（node:test，Node 26 原生剥离 TS 类型）。
 *
 *   node --test web/src/lib/measure/engine.test.ts
 *
 * 所有合成文档都按 **dxf-viewer** 的解析结果形状构造：
 *   LINE       { vertices: [p, p] }
 *   LWPOLYLINE { vertices: [{x, y, bulge?}], shape: boolean }
 *   ARC        { center, radius, startAngle, endAngle }   // 角度已是弧度
 *   CIRCLE     { center, radius }
 *   INSERT     { name, position, xScale, yScale, rotation }
 *   TEXT       { startPoint, textHeight, text }
 *   blocks     { NAME: { position, entities } }
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createMeasureEngine } from "./index.ts";

type P = { x: number; y: number };
type Doc = {
  header: Record<string, unknown>;
  tables: Record<string, unknown>;
  blocks: Record<string, unknown>;
  entities: Record<string, unknown>[];
};

function doc(
  entities: Record<string, unknown>[],
  unit = 4,
  blocks: Record<string, unknown> = {}
): Doc {
  return {
    header: { $INSUNITS: unit },
    tables: { layer: { layers: { "0": { name: "0" } } } },
    blocks,
    entities,
  };
}

const line = (x1: number, y1: number, x2: number, y2: number) => ({
  type: "LINE",
  vertices: [
    { x: x1, y: y1 },
    { x: x2, y: y2 },
  ],
});

const lwpolyline = (vertices: { x: number; y: number; bulge?: number }[], closed = false) => ({
  type: "LWPOLYLINE",
  vertices,
  shape: closed,
});

const circle = (x: number, y: number, r: number) => ({
  type: "CIRCLE",
  center: { x, y },
  radius: r,
});

const arc = (x: number, y: number, r: number, startDeg: number, endDeg: number) => ({
  type: "ARC",
  center: { x, y },
  radius: r,
  // dxf-viewer 已经把 ARC 的 50/51 组码转成弧度。
  startAngle: (startDeg * Math.PI) / 180,
  endAngle: (endDeg * Math.PI) / 180,
});

const text = (s: string) => ({
  type: "TEXT",
  startPoint: { x: 0, y: 0 },
  textHeight: 2.5,
  text: s,
});

function close(actual: number, expected: number, tol: number, msg?: string) {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${msg ?? "value"}: expected ${expected}, got ${actual} (tol ${tol})`
  );
}

function nearPoint(actual: P | { x: number; y: number } | null, x: number, y: number, tol: number) {
  assert.ok(actual, "expected a hit");
  close(actual!.x, x, tol, "x");
  close(actual!.y, y, tol, "y");
}

/* ------------------------------------------------------------------ */
/* 基础数学                                                            */
/* ------------------------------------------------------------------ */

test("distance / angleDeg / radiusFrom3", () => {
  const engine = createMeasureEngine(doc([]));

  assert.equal(engine.distance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);

  close(engine.angleDeg({ x: 0, y: 1 }, { x: 0, y: 0 }, { x: 1, y: 0 }), 90, 1e-12);
  close(engine.angleDeg({ x: 1, y: 1 }, { x: 0, y: 0 }, { x: 1, y: 0 }), 45, 1e-12);
  close(engine.angleDeg({ x: -1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }), 180, 1e-12);
  // 退化输入不产生 NaN
  close(engine.angleDeg({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }), 0, 1e-12);

  close(engine.radiusFrom3({ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 })!, 1, 1e-12);
  assert.equal(engine.radiusFrom3({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }), null);
});

/* ------------------------------------------------------------------ */
/* 单位与格式化                                                        */
/* ------------------------------------------------------------------ */

test("units: $INSUNITS 4 / 6 / 0 and fmt", () => {
  const mm = createMeasureEngine(doc([], 4));
  assert.equal(mm.units.code, 4);
  assert.equal(mm.units.label, "毫米");
  assert.equal(mm.units.suffix, "mm");
  assert.equal(mm.fmt(1234.56), "1,234.56 mm");
  assert.equal(mm.fmt(1234.56, "length"), "1,234.56 mm");
  assert.equal(mm.fmt(1234.56, "area"), "1,234.56 mm²");
  assert.equal(mm.fmt(45, "angle"), "45.00°");
  assert.equal(mm.fmt(0.001), "0.00 mm");

  const m = createMeasureEngine(doc([], 6));
  assert.equal(m.units.label, "米");
  assert.equal(m.units.suffix, "m");
  assert.equal(m.fmt(2.5), "2.50 m");

  const unitless = createMeasureEngine(doc([], 0));
  assert.equal(unitless.units.label, "图纸单位");
  assert.equal(unitless.units.suffix, "");
  assert.equal(unitless.fmt(1234.56), "1,234.56");
  assert.equal(unitless.fmt(1234.56, "area"), "1,234.56");
});

test("units: opts.unitCode overrides the header", () => {
  const engine = createMeasureEngine(doc([], 6), { unitCode: 4 });
  assert.equal(engine.units.code, 4);
  assert.equal(engine.units.suffix, "mm");
});

/* ------------------------------------------------------------------ */
/* LINE 吸附优先级                                                     */
/* ------------------------------------------------------------------ */

test("LINE: endpoint beats midpoint inside the tolerance", () => {
  const engine = createMeasureEngine(doc([line(0, 0, 1, 0)]));
  const hit = engine.snap(0.9, 0.1, 1.5);
  assert.ok(hit);
  assert.equal(hit!.kind, "endpoint");
  nearPoint(hit, 1, 0, 1e-9);
  close(hit!.dist, Math.hypot(0.1, 0.1), 1e-9);
});

test("LINE: midpoint when no endpoint is in range", () => {
  const engine = createMeasureEngine(doc([line(0, 0, 100, 0)]));
  const hit = engine.snap(50, 0.2, 1);
  assert.ok(hit);
  assert.equal(hit!.kind, "midpoint");
  nearPoint(hit, 50, 0, 1e-9);
  close(hit!.dist, 0.2, 1e-9);
});

test("LINE: nearest-on-segment when no vertex/midpoint is in range", () => {
  const engine = createMeasureEngine(doc([line(0, 0, 100, 0)]));
  const hit = engine.snap(30, 0.05, 0.2);
  assert.ok(hit);
  assert.equal(hit!.kind, "nearest");
  nearPoint(hit, 30, 0, 1e-9);
  close(hit!.dist, 0.05, 1e-9);
});

test("snap() returns null beyond tolerance", () => {
  const engine = createMeasureEngine(doc([line(0, 0, 100, 0)]));
  assert.equal(engine.snap(30, 0.5, 0.2), null);
  assert.equal(engine.snap(500, 500, 1), null);
  assert.equal(engine.snap(30, 0, 0), null);
  assert.equal(engine.snap(30, 0, Number.NaN), null);
});

test("snap() returns null before build / after clear", () => {
  const engine = createMeasureEngine(undefined);
  assert.equal(engine.ready, false);
  assert.equal(engine.snap(0, 0, 1), null);

  engine.build(doc([line(0, 0, 10, 0)]));
  assert.equal(engine.ready, true);
  assert.ok(engine.snap(0, 0, 0.01));

  engine.clear();
  assert.equal(engine.ready, false);
  assert.equal(engine.primitiveCount, 0);
  assert.equal(engine.snap(0, 0, 0.01), null);
});

/* ------------------------------------------------------------------ */
/* 圆弧 / 圆                                                           */
/* ------------------------------------------------------------------ */

test("CIRCLE: center and quadrant snapping", () => {
  const engine = createMeasureEngine(doc([circle(100, 0, 5)]));
  assert.equal(engine.primitiveCount, 1);

  const center = engine.snap(100.05, 0.05, 0.5);
  assert.ok(center);
  assert.equal(center!.kind, "center");
  nearPoint(center, 100, 0, 1e-9);

  // 0° 象限点 (105, 0)
  const quadrant = engine.snap(105.1, 0.1, 1);
  assert.ok(quadrant);
  assert.equal(quadrant!.kind, "quadrant");
  nearPoint(quadrant, 105, 0, 1e-9);

  // 90° 象限点 (100, 5)
  const q90 = engine.snap(99.95, 5.05, 0.5);
  assert.ok(q90);
  assert.equal(q90!.kind, "quadrant");
  nearPoint(q90, 100, 5, 1e-9);
});

test("ARC: center, quadrant and both endpoints", () => {
  // 30°..120° 的四分之一多圆弧，半径 10
  const engine = createMeasureEngine(doc([arc(0, 0, 10, 30, 120)]));

  const center = engine.snap(0.1, 0.1, 1);
  assert.ok(center);
  assert.equal(center!.kind, "center");
  nearPoint(center, 0, 0, 1e-9);

  const q = engine.snap(0.05, 10.05, 0.5);
  assert.ok(q);
  assert.equal(q!.kind, "quadrant");
  nearPoint(q, 0, 10, 1e-9);

  const start = { x: 10 * Math.cos(Math.PI / 6), y: 10 * Math.sin(Math.PI / 6) };
  const s = engine.snap(start.x + 0.05, start.y + 0.05, 0.5);
  assert.ok(s);
  assert.equal(s!.kind, "endpoint");
  nearPoint(s, start.x, start.y, 1e-9);

  const end = { x: 10 * Math.cos((2 * Math.PI) / 3), y: 10 * Math.sin((2 * Math.PI) / 3) };
  const e = engine.snap(end.x - 0.05, end.y + 0.05, 0.5);
  assert.ok(e);
  assert.equal(e!.kind, "endpoint");
  nearPoint(e, end.x, end.y, 1e-9);

  // 只有一个真实通过的象限点（90°）；180° / 270° 不能凭空出现
  assert.equal(engine.snap(-10.02, 0, 0.2), null);
  assert.equal(engine.snap(0, -10.02, 0.2), null);
});

/* ------------------------------------------------------------------ */
/* 交点                                                                */
/* ------------------------------------------------------------------ */

test("intersection snapping of two crossing lines", () => {
  const engine = createMeasureEngine(
    doc([line(0, 0, 10, 0), line(2, -3, 2, 4)])
  );

  const hit = engine.snap(2.05, 0.02, 0.2);
  assert.ok(hit);
  assert.equal(hit!.kind, "intersection");
  nearPoint(hit, 2, 0, 1e-9);
  close(hit!.dist, Math.hypot(0.05, 0.02), 1e-9);
});

/* ------------------------------------------------------------------ */
/* 折线长度 / 面积                                                     */
/* ------------------------------------------------------------------ */

test("LWPOLYLINE with bulge: length and area match the closed form", () => {
  // 一条 2 顶点闭合折线：线段 0->1 是 bulge=1 的半圆（半径 1），
  // 回程 1->0 是直径弦。半圆面积 π/2，总长 π + 2。
  const engine = createMeasureEngine(
    doc([lwpolyline([{ x: 0, y: 0, bulge: 1 }, { x: 2, y: 0 }], true)])
  );

  const points = engine.pickPolyline(1, -1, 0.1);
  assert.ok(points, "semicircle should be pickable");
  assert.ok(points!.length > 100);

  // 闭合折线返回时末点重复首点，直接喂给 length/area 即可。
  nearPoint(points![points!.length - 1], 0, 0, 1e-9);

  close(engine.polylineLength(points!), Math.PI + 2, 1e-3, "length");
  const { area, perimeter } = engine.polygonArea(points!);
  close(area, Math.PI / 2, 1e-3, "area");
  close(perimeter, Math.PI + 2, 1e-3, "perimeter");
});

test("closed rectangle: pickPolyline length / area / perimeter", () => {
  const engine = createMeasureEngine(
    doc([
      lwpolyline(
        [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 4 },
          { x: 0, y: 4 },
        ],
        true
      ),
    ])
  );

  const points = engine.pickPolyline(5, 0.05, 0.2);
  assert.ok(points);
  assert.equal(points!.length, 5); // 4 个顶点 + 重复首点
  close(engine.polylineLength(points!), 28, 1e-9);
  const { area, perimeter } = engine.polygonArea(points!);
  close(area, 40, 1e-9);
  close(perimeter, 28, 1e-9);

  assert.equal(engine.pickPolyline(50, 50, 1), null);
});

/* ------------------------------------------------------------------ */
/* INSERT 变换                                                         */
/* ------------------------------------------------------------------ */

test("INSERT: nested geometry snaps at world coordinates", () => {
  const blocks = {
    LEAF: {
      position: { x: 0, y: 0, z: 0 },
      entities: [line(0, 0, 1, 0)],
    },
    DOOR: {
      position: { x: 0, y: 0, z: 0 },
      entities: [{ type: "INSERT", name: "LEAF", position: { x: 0, y: 10, z: 0 } }],
    },
  };

  const engine = createMeasureEngine(
    doc(
      [
        {
          type: "INSERT",
          name: "DOOR",
          position: { x: 50, y: 60, z: 0 },
          xScale: 1,
          yScale: 1,
          rotation: 0,
        },
      ],
      4,
      blocks
    )
  );

  // 内层块偏移 (0,10) 与外层插入点 (50,60) 复合 => (50,70)-(51,70)
  const hit = engine.snap(50.02, 70.03, 0.2);
  assert.ok(hit);
  assert.equal(hit!.kind, "endpoint");
  nearPoint(hit, 50, 70, 1e-9);

  const mid = engine.snap(50.5, 70.02, 0.2);
  assert.ok(mid);
  assert.equal(mid!.kind, "midpoint");
  nearPoint(mid, 50.5, 70, 1e-9);
});

test("INSERT: rotation + scale are composed", () => {
  const blocks = {
    UNIT: {
      position: { x: 0, y: 0, z: 0 },
      entities: [line(0, 0, 1, 0)],
    },
  };

  const engine = createMeasureEngine(
    doc(
      [
        {
          type: "INSERT",
          name: "UNIT",
          position: { x: 100, y: 200, z: 0 },
          xScale: 2,
          yScale: 2,
          rotation: 90,
        },
      ],
      4,
      blocks
    )
  );

  // (1,0) -> 缩放 2 -> 旋转 90° -> (0,2) -> 平移 (100,200)
  nearPoint(engine.snap(100.05, 202.05, 0.5), 100, 202, 1e-9);
  nearPoint(engine.snap(100.05, 200.05, 0.5), 100, 200, 1e-9);
  nearPoint(engine.snap(100.2, 201.2, 0.5), 100, 201, 1e-9);
});

/* ------------------------------------------------------------------ */
/* build 统计 / 线段上限                                               */
/* ------------------------------------------------------------------ */

test("build stats: text is skipped, geometry is counted", () => {
  const engine = createMeasureEngine(doc([]));
  const stats = engine.build(
    doc([line(0, 0, 10, 0), circle(50, 50, 5), text("hello")])
  );
  assert.equal(stats.primitives, 2);
  assert.equal(stats.polylines, 2);
  assert.equal(stats.skipped, 1);
  assert.equal(engine.primitiveCount, 2);
  assert.equal(engine.ready, true);
});

test("build stats: text inside a block INSERT also counts as skipped", () => {
  const blocks = {
    LABEL: {
      position: { x: 0, y: 0, z: 0 },
      entities: [text("in-block"), line(0, 0, 1, 0)],
    },
  };
  const engine = createMeasureEngine(doc([]));
  const stats = engine.build(
    doc([{ type: "INSERT", name: "LABEL", position: { x: 0, y: 0, z: 0 } }], 4, blocks)
  );
  assert.equal(stats.primitives, 1);
  assert.equal(stats.polylines, 1);
  assert.equal(stats.skipped, 1);
});

test("segment cap: geometry beyond 400k segments is skipped", () => {
  const N = 400_001; // 400_000 segments
  const vertices: P[] = [];
  for (let i = 0; i < N; i++) vertices.push({ x: i, y: 0 });
  const big = { type: "LWPOLYLINE", vertices, shape: false };
  const extra = line(0, 1, 1, 1);

  const engine = createMeasureEngine(doc([]));
  const stats = engine.build(doc([big, extra]));

  assert.equal(stats.polylines, 1);
  assert.equal(stats.primitives, 1);
  assert.ok(stats.skipped >= 1, `expected skipped >= 1, got ${stats.skipped}`);
  assert.equal(engine.ready, true);
  // 已建索引的部分仍然可用
  assert.ok(engine.snap(0, 0, 0.01));
  // 超出上限的实体没有进入索引
  assert.equal(engine.snap(0, 1, 0.1), null);
});
