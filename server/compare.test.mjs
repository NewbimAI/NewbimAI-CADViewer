import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compareEntities } from "./compare.js";
import { clearEntitiesCache, loadEntities } from "./dxf-entities.js";

/**
 * 比对引擎单元测试（纯逻辑，不依赖真实图纸）。
 *
 * 关键语义（与 docs/compare-contract.md §4 一致）：
 *  · 指纹完全相同 → unchanged；指纹相同但属性不同 → modified/properties
 *  · handle 相同且类型相同 → modified；包围盒距离 ≤ tolerance → modified/geometry
 *  · 「位移小于 tolerance」仍然算 modified：tolerance 只用于第 3 轮的**候选配对**，
 *    指纹因为 quantize(1e-6) 已经不同。契约没有「容差内视为未变化」这一档，
 *    所以这里明确断言 modified（change:"geometry"）。
 */

const DEFAULT_OPTS = {
  tolerance: 0.001,
  quantize: 1e-6,
  compareProps: ["color", "layer", "linetype", "lineweight"],
  includeHatch: false,
  maxChanges: 5000,
};

/** dxf-parser 形状的 LINE */
function line(x1, y1, x2, y2, extra = {}) {
  return {
    type: "LINE",
    layer: "0",
    vertices: [
      { x: x1, y: y1, z: 0 },
      { x: x2, y: y2, z: 0 },
    ],
    ...extra,
  };
}

/** dxf-parser 形状的 LWPOLYLINE；顶点 [x, y, bulge?] */
function lwpolyline(vertices, { closed = false, ...extra } = {}) {
  return {
    type: "LWPOLYLINE",
    layer: "0",
    shape: closed,
    vertices: vertices.map(([x, y, bulge]) => ({
      x,
      y,
      ...(bulge ? { bulge } : {}),
    })),
    ...extra,
  };
}

const clone = (list) => JSON.parse(JSON.stringify(list));

test("完全相同的图纸：0 变更，全部 unchanged", () => {
  const a = [line(0, 0, 10, 0, { handle: "1" }), line(0, 10, 10, 10, { handle: "2" })];
  const r = compareEntities(a, clone(a), DEFAULT_OPTS);
  assert.equal(r.changes.length, 0);
  assert.deepEqual(
    [r.summary.added, r.summary.removed, r.summary.modified, r.summary.unchanged],
    [0, 0, 0, 2]
  );
  assert.equal(r.summary.truncated, false);
  assert.equal(r.changeSets.length, 0);
});

test("位移小于 tolerance：按契约判为 modified/geometry（不是 unchanged）", () => {
  const a = [line(0, 0, 10, 0, { handle: "1" })];
  // y 方向移动 0.0005 < tolerance 0.001
  const b = [line(0, 0.0005, 10, 0.0005, { handle: "1" })];
  const r = compareEntities(a, b, DEFAULT_OPTS);
  assert.equal(r.changes.length, 1, "tolerance 只决定候选配对，不把已变化的指纹抹平");
  assert.equal(r.changes[0].kind, "modified");
  assert.equal(r.changes[0].change, "geometry");
  assert.equal(r.summary.unchanged, 0);
  // 移动超过 tolerance 且 handle 不同（handle 相同会命中第 2 轮）→ 一加一删
  const c = [{ ...line(0, 0, 10, 0, { handle: "1" }) }];
  const d = [{ ...line(0, 1, 10, 1, { handle: "2" }) }];
  const r2 = compareEntities(c, d, DEFAULT_OPTS);
  assert.deepEqual([r2.summary.added, r2.summary.removed], [1, 1]);
});

test("新增 / 删除实体", () => {
  const a = [line(0, 0, 10, 0, { handle: "1" }), line(0, 5, 10, 5, { handle: "2" })];
  const b = [line(0, 0, 10, 0, { handle: "1" }), line(0, 9, 10, 9, { handle: "3" })];
  const r = compareEntities(a, b, DEFAULT_OPTS);
  assert.deepEqual([r.summary.added, r.summary.removed], [1, 1]);
  const added = r.changes.find((c) => c.kind === "added");
  const removed = r.changes.find((c) => c.kind === "removed");
  assert.ok(added && added.target.length > 0 && added.base.length === 0);
  assert.ok(removed && removed.base.length > 0 && removed.target.length === 0);
  assert.equal(added.handleBase, null);
  assert.equal(removed.handleTarget, null);
});

test("重复实体按多重集匹配，不合并统计", () => {
  const a = [
    line(0, 0, 10, 0, { handle: "1" }),
    line(0, 0, 10, 0, { handle: "2" }), // 与上一行完全相同
  ];
  const b = [line(0, 0, 10, 0, { handle: "9" })];
  const r = compareEntities(a, b, DEFAULT_OPTS);
  assert.equal(r.summary.unchanged, 1);
  assert.equal(r.summary.removed, 1);
  assert.equal(r.summary.added, 0);
});

test("handle 全部重编号但几何相同：0 modified", () => {
  const a = [line(0, 0, 10, 0, { handle: "A1" }), line(0, 10, 10, 10, { handle: "A2" })];
  const b = [line(0, 0, 10, 0, { handle: "B1" }), line(0, 10, 10, 10, { handle: "B2" })];
  const r = compareEntities(a, b, DEFAULT_OPTS);
  assert.equal(r.summary.modified, 0);
  assert.equal(r.summary.unchanged, 2);
});

test("图层重命名：只有 compareProps 含 layer 时才报属性变更", () => {
  const a = [line(0, 0, 10, 0, { handle: "1", layer: "WALL" })];
  const b = [line(0, 0, 10, 0, { handle: "1", layer: "墙体" })];

  const withLayer = compareEntities(a, b, {
    ...DEFAULT_OPTS,
    compareProps: ["color", "layer", "linetype", "lineweight"],
  });
  assert.equal(withLayer.summary.modified, 1);
  assert.equal(withLayer.changes[0].change, "properties");
  assert.equal(withLayer.summary.unchanged, 0);

  const withoutLayer = compareEntities(a, b, { ...DEFAULT_OPTS, compareProps: ["color"] });
  assert.equal(withoutLayer.summary.modified, 0);
  assert.equal(withoutLayer.summary.unchanged, 1);
});

test("闭合多段线起点不同、顶点相同：unchanged", () => {
  const a = [lwpolyline([[0, 0], [10, 0], [10, 10], [0, 10]], { closed: true, handle: "1" })];
  const b = [lwpolyline([[10, 0], [10, 10], [0, 10], [0, 0]], { closed: true, handle: "1" })];
  const r = compareEntities(a, b, DEFAULT_OPTS);
  assert.equal(r.summary.unchanged, 1);
  assert.equal(r.summary.modified, 0);
});

test("有 bulge 的圆弧段 vs 直线弦：modified", () => {
  const a = [lwpolyline([[0, 0, 0.5], [10, 0]], { handle: "1" })];
  const b = [lwpolyline([[0, 0], [10, 0]], { handle: "2" })];
  const r = compareEntities(a, b, DEFAULT_OPTS);
  assert.equal(r.changes.length, 1);
  assert.equal(r.changes[0].kind, "modified");
  assert.equal(r.changes[0].change, "geometry");
});

test("3 个相邻变更聚成 1 个变更集", () => {
  const a = [];
  const b = [
    line(0, 0, 1, 0, { handle: "1" }),
    line(1.1, 0, 2.1, 0, { handle: "2" }),
    line(2.2, 0, 3.2, 0, { handle: "3" }),
  ];
  const r = compareEntities(a, b, { ...DEFAULT_OPTS, tolerance: 0.1 });
  assert.equal(r.summary.added, 3);
  assert.equal(r.changeSets.length, 1, "padding = 2*tolerance 后相邻框应相交");
  assert.equal(r.changeSets[0].count, 3);
  assert.deepEqual(r.changeSets[0].kinds, { added: 3, removed: 0, modified: 0 });
  assert.ok(r.changes.every((c) => c.setId === 0));
});

test("不支持的实体：notCompared + 聚合告警，不谎报 unchanged", () => {
  const a = [
    line(0, 0, 10, 0, { handle: "1" }),
    { type: "HATCH", layer: "0", handle: "2", vertices: [] },
    { type: "ACAD_TABLE", layer: "0", handle: "3" },
    { type: "DIMENSION", layer: "0", handle: "4" }, // 无 *D 块
  ];
  const b = [
    line(0, 0, 10, 0, { handle: "1" }),
    { type: "HATCH", layer: "0", handle: "2", vertices: [] },
  ];
  const r = compareEntities(a, b, DEFAULT_OPTS);
  assert.equal(r.summary.unchanged, 1);
  assert.equal(r.summary.notCompared, 4); // A:3 + B:1
  assert.equal(r.summary.added + r.summary.removed + r.summary.modified, 0);
  const byType = Object.fromEntries(
    r.warnings.filter((w) => w.code === "unsupported").map((w) => [w.type, w.count])
  );
  assert.deepEqual(byType, { HATCH: 2, ACAD_TABLE: 1, DIMENSION: 1 });
});

test("解析器丢弃的类型（HATCH 等）计入 notCompared", () => {
  const a = [line(0, 0, 10, 0, { handle: "1" })];
  const r = compareEntities(a, clone(a), { ...DEFAULT_OPTS, skippedTypes: { HATCH: 12 } });
  assert.equal(r.summary.unchanged, 1);
  assert.equal(r.summary.notCompared, 12);
  const w = r.warnings.find((x) => x.code === "unsupported" && x.type === "HATCH");
  assert.ok(w);
  assert.equal(w.count, 12);
});

test("块定义变化：block-redefined 警告 + 引用它的 INSERT 判为 modified/block", () => {
  const insert = { type: "INSERT", name: "B1", layer: "0", handle: "1", position: { x: 0, y: 0 } };
  const blocksA = { B1: { name: "B1", entities: [line(0, 0, 1, 0)] } };
  const blocksB = { B1: { name: "B1", entities: [line(0, 0, 2, 0)] } };
  const r = compareEntities([insert], [clone(insert)], {
    ...DEFAULT_OPTS,
    blocksA,
    blocksB,
  });
  assert.equal(r.summary.unchanged, 0);
  assert.equal(r.summary.modified, 1);
  assert.equal(r.changes[0].change, "block");
  const w = r.warnings.find((x) => x.code === "block-redefined");
  assert.deepEqual(w, { code: "block-redefined", name: "B1", count: 2 });
});

test("单条变更的图元点数不超过 maxPointsPerChange", () => {
  const verts = Array.from({ length: 4000 }, (_, i) => [i, i % 2]);
  const a = [lwpolyline(verts, { handle: "1" })];
  const b = [lwpolyline(verts.map(([x, y]) => [x + 1, y]), { handle: "1" })];
  const r = compareEntities(a, b, { ...DEFAULT_OPTS, maxPointsPerChange: 2000 });
  assert.equal(r.changes.length, 1);
  const pts = [...r.changes[0].base, ...r.changes[0].target].reduce(
    (n, p) => n + (p.kind === "polyline" ? p.points.length : 1),
    0
  );
  assert.ok(pts <= 2000, `points=${pts}`);
});

test("maxChanges 截断：只返回上限条数，但 summary 计数完整", () => {
  const b = [];
  for (let i = 0; i < 8; i++) b.push(line(i * 10, 0, i * 10 + 5, 0, { handle: String(i) }));
  const r = compareEntities([], b, { ...DEFAULT_OPTS, maxChanges: 3 });
  assert.equal(r.changes.length, 3);
  assert.equal(r.summary.added, 8);
  assert.equal(r.summary.truncated, true);
  assert.equal(r.warnings.length, 0);
});

test("空间网格在万级实体上保持近线性（不退化 O(n²)）", () => {
  const N = 10000;
  const a = [];
  const b = [];
  for (let i = 0; i < N; i++) {
    a.push(line(i * 2, 0, i * 2 + 1, 0, { handle: `A${i}` }));
    // 同类型、位移小于 tolerance、handle 全不同 → 只能靠第 3 轮空间匹配
    b.push(line(i * 2 + 0.0005, 0, i * 2 + 1.0005, 0, { handle: `B${i}` }));
  }
  const t0 = Date.now();
  const r = compareEntities(a, b, { ...DEFAULT_OPTS, maxChanges: 100 });
  const ms = Date.now() - t0;
  assert.equal(r.summary.modified, N);
  assert.equal(r.summary.added + r.summary.removed, 0);
  assert.ok(ms < 5000, `空间匹配耗时 ${ms}ms，疑似退化为平方复杂度`);
});

test("同一 kind 内按包围盒左上角排序", () => {
  const b = [
    line(0, 30, 5, 30, { handle: "1" }),
    line(0, 10, 5, 10, { handle: "2" }),
    line(0, 20, 5, 20, { handle: "3" }),
  ];
  const r = compareEntities([], b, DEFAULT_OPTS);
  assert.deepEqual(
    r.changes.map((c) => c.bbox[1]),
    [10, 20, 30]
  );
  assert.deepEqual(
    r.changes.map((c) => c.id),
    [0, 1, 2]
  );
});

test("deterministic：同样输入两次输出完全一致", () => {
  const a = [line(0, 0, 10, 0, { handle: "1" }), line(3, 3, 4, 4, { handle: "2" })];
  const b = [line(0, 0, 10, 0, { handle: "1" }), line(3, 3, 4, 4, { handle: "2" }), line(9, 9, 10, 10, { handle: "3" })];
  const r1 = compareEntities(a, b, DEFAULT_OPTS);
  const r2 = compareEntities(clone(a), clone(b), DEFAULT_OPTS);
  assert.deepEqual(r1.changes, r2.changes);
  assert.deepEqual(r1.changeSets, r2.changeSets);
});

test("图层名 \\U+XXXX 转义在变更输出中解码为中文（普通/空值原样）", () => {
  const added = [line(0, 0, 10, 0, { handle: "1", layer: "\\U+5730\\U+5E93" })];
  const r1 = compareEntities([], added, DEFAULT_OPTS);
  assert.equal(r1.changes.length, 1);
  assert.equal(r1.changes[0].layer, "地库");

  const removed = [line(0, 0, 10, 0, { handle: "2", layer: "\\U+4E09\\U+5C42" })];
  const r2 = compareEntities(removed, [], DEFAULT_OPTS);
  assert.equal(r2.changes.length, 1);
  assert.equal(r2.changes[0].layer, "三层");

  const plain = [line(0, 0, 10, 0, { handle: "3", layer: "WALL" })];
  const r3 = compareEntities([], plain, DEFAULT_OPTS);
  assert.equal(r3.changes[0].layer, "WALL");

  const empty = [line(0, 0, 10, 0, { handle: "4", layer: "" })];
  const r4 = compareEntities([], empty, DEFAULT_OPTS);
  assert.equal(r4.changes[0].layer, "");

  const zero = [line(0, 0, 10, 0, { handle: "5", layer: "0" })];
  const r5 = compareEntities([], zero, DEFAULT_OPTS);
  assert.equal(r5.changes[0].layer, "0");
});

test("图层解码只影响输出 layer：输入 raw 不被改写，属性比较仍按原值", () => {
  const escaped = "\\U+5730\\U+5E93";
  const a = [line(0, 0, 10, 0, { handle: "1", layer: escaped })];
  const b = [line(0, 5, 10, 5, { handle: "1", layer: escaped })];
  const r = compareEntities(a, b, DEFAULT_OPTS);
  assert.equal(r.changes.length, 1);
  assert.equal(r.changes[0].kind, "modified");
  assert.equal(r.changes[0].change, "geometry", "两边图层原值一致，不应误报属性变更");
  assert.equal(r.changes[0].layer, "地库");
  assert.equal(a[0].layer, escaped, "解码不应回写输入实体");
});

test("dxf-entities 归一化同样解码图层名，raw 保留 DXF 原值", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cadviewer-layer-"));
  const file = path.join(dir, "layer.dxf");
  const escaped = "\\U+5730\\U+5E93";
  const dxf = [
    "0", "SECTION", "2", "ENTITIES",
    "0", "LINE", "8", escaped,
    "10", "0.0", "20", "0.0", "30", "0.0",
    "11", "10.0", "21", "0.0", "31", "0.0",
    "0", "ENDSEC", "0", "EOF", "",
  ].join("\n");
  fs.writeFileSync(file, dxf, "utf-8");
  try {
    clearEntitiesCache();
    const res = await loadEntities(file);
    assert.equal(res.entities.length, 1);
    assert.equal(res.entities[0].layer, "地库");
    assert.equal(res.entities[0].raw.layer, escaped);
  } finally {
    clearEntitiesCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
