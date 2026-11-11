/**
 * `310` 自定义实体代理图形解码的回归测试（v45 / v46）。
 *
 * 样例 hex 全部取自真实图纸：
 *   · IAEC_WALL / IAEC_TEXT 来自 `acad-cab.dxf`（机柜图，handle E8A9 / E8A8）；
 *   · mesh 墙来自 `acad-s005.dxf`（施工005，4 顶点 + 2 个三角形）。
 * v46：代理文字传入 SHX 上下文时直接出单线笔画，缺字形时回退 TEXT。
 * 运行：node --test server/proxy-graphics.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  decodeProxyGraphics,
  convertProxyGraphicsEntities,
} from "./proxy-graphics.js";
import { createShxContext } from "./shx-text.js";

/* ── 真实样例 ── */

/** IAEC_WALL handle E8A9 / 层 WALL：两段 2 点折线（房间墙的两条边） */
const WALL_HEX =
  "98000000040000000C00000013000000010000003C0000000600000002000000D22C" +
  "568ACD752F41AADBD2B24CA008C10000000000000000D42C568AA59D2F41AEDBD2B2" +
  "4CA008C100000000000000000C00000013000000020000003C000000060000000200" +
  "0000D22C568A95762F4197DBD2B28CA608C10000000000000000E02C568A159C2F41" +
  "9BDBD2B28CA608C10000000000000000";

/** IAEC_TEXT handle E8A8 / 层 PUB_TEXT：文字「风井」，字高 503.7037 */
const TEXT_HEX =
  "DC000000020000000C0000001300000001000000C8000000260000002BF3E76D4272" +
  "2F4185149303A4D708C1000000000000000000000000000000000000000000000000" +
  "000000000000F03F000000000000F03F00000000000000000000000000000000CE98" +
  "954E000000000200000000000000B597D05E427B7F40000000000000F03F00000000" +
  "00000000000000000000F03F00000000000000000000000000000000000000000000" +
  "000000000000000000000000000000000000530049004D0050004C00450058000000" +
  "47004200430042004900470000000000";

/** IAEC_WALL（施工005）：4 顶点矩形墙 + 面表 [3,0,1,2][3,2,1,3] → 2 个三角形 */
const MESH_HEX =
  "F8020000160000000C0000001300000001000000880000001D000000000000000000" +
  "F03F0000000000000000000000000000000000000000000000000000000000000000" +
  "000000000000F03F0000000000000000000000000000000000000000000000000000" +
  "000000000000000000000000F03F0000000000000000000000000000000000000000" +
  "000000000000000000000000000000000000F03F0C0000000E000000FB0000000C00" +
  "0000100000002D0000000C00000012000000000000000C0000001400000001000000" +
  "100000001A000000030000001C000000B400000009000000040000008076B8C2001D" +
  "D040005E738AFFD3B24000000000000000008076B8C2001DD040005E738AFF0BB740" +
  "00000000000000008076B8C2805BD040005E738AFFD3B24000000000000000008076" +
  "B8C2805BD040005E738AFF0BB7400000000000000000080000000300000000000000" +
  "01000000020000000300000002000000010000000300000040000000010000000000" +
  "0000010000000000000001000000010000000000000000000000080000001F000000" +
  "0C00000013000000020000000C0000000E000000040000000C000000100000002200" +
  "00000C00000012000000FF7F00000C0000001400000002000000100000001A000000" +
  "030000000F0000003C00000006000000020000008076B8C2805BD040005E738AFF0B" +
  "B74000000000000000008076B8C2805BD040005E738AFFD3B2400000000000000000" +
  "0C00000013000000030000003C00000006000000020000008076B8C2001DD040005E" +
  "738AFF0BB74000000000000000008076B8C2001DD040005E738AFFD3B24000000000" +
  "000000000C00000013000000040000003C00000006000000020000008076B8C2805B" +
  "D040005E738AFF0BB74000000000000000008076B8C2001DD040005E738AFF0BB740" +
  "00000000000000000C00000013000000050000003C00000006000000020000008076" +
  "B8C2805BD040005E738AFFD3B24000000000000000008076B8C2001DD040005E738A" +
  "FFD3B2400000000000000000";

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));

test("golden: IAEC_WALL → 两条 2 点折线（坐标逐位对照）", () => {
  const r = decodeProxyGraphics(WALL_HEX);
  assert.ok(r, "必须能解码");
  assert.equal(r.primitives.length, 2);
  assert.deepEqual(r.primitives.map((p) => p.type), ["polyline", "polyline"]);

  const [a, b] = r.primitives;
  assert.equal(a.points.length, 2);
  assert.ok(near(a.points[0][0], 1030886.7701887528));
  assert.ok(near(a.points[0][1], -201737.5873162421));
  assert.ok(near(a.points[1][0], 1035986.7701887528));
  assert.ok(near(a.points[1][1], -201737.5873162421));

  assert.ok(near(b.points[0][0], 1030986.7701887528));
  assert.ok(near(b.points[0][1], -201937.5873162421));
  assert.ok(near(b.points[1][0], 1035786.7701887528));
  assert.ok(near(b.points[1][1], -201937.5873162421));
  assert.equal(a.closed, false);
});

test("golden: IAEC_TEXT → 文字/位置/字高/宽度因子", () => {
  const r = decodeProxyGraphics(TEXT_HEX);
  assert.ok(r);
  assert.equal(r.primitives.length, 1);
  const t = r.primitives[0];
  assert.equal(t.type, "text");
  assert.equal(t.text, "风井");
  assert.ok(near(t.x, 1030433.214660262));
  assert.ok(near(t.y, -203508.50174537688));
  assert.ok(near(t.height, 503.70370370370375));
  assert.ok(near(t.widthFactor, 1));
  assert.equal(t.rotation, 0);
  // kind38 尾部的字体名（供单线笔画选字体）
  assert.equal(t.font, "SIMPLEX");
  assert.equal(t.bigFont, "GBCBIG");
});

test("golden: mesh 墙 → 4 顶点面表切成 2 个三角形", () => {
  const r = decodeProxyGraphics(MESH_HEX);
  assert.ok(r);
  const tris = r.primitives.filter((p) => p.type === "triangle");
  assert.equal(tris.length, 2);
  assert.equal(r.stats.triangles, 2);
  // 矩形四角 x≈16500.01 / 16750.01，y≈4820 / 5900
  const xs = tris.flatMap((t) => t.points.map((p) => p[0]));
  const ys = tris.flatMap((t) => t.points.map((p) => p[1]));
  assert.ok(Math.min(...xs) < 16501 && Math.max(...xs) > 16749);
  assert.ok(Math.min(...ys) < 4821 && Math.max(...ys) > 5899);
  // 同一实体里的墙边折线也必须保留
  assert.ok(r.primitives.filter((p) => p.type === "polyline").length >= 4);
});

test("变换矩阵：kind29 后的局部坐标先乘矩阵（平移/缩放）", () => {
  const rec = (kind, payload) => {
    const buf = Buffer.alloc(8 + payload.length);
    buf.writeUInt32LE(8 + payload.length, 0);
    buf.writeUInt32LE(kind, 4);
    payload.copy(buf, 8);
    return buf;
  };
  const dbl = (arr) => {
    const b = Buffer.alloc(arr.length * 8);
    arr.forEach((v, i) => b.writeDoubleLE(v, i * 8));
    return b;
  };
  const begin19 = rec(19, Buffer.alloc(4));
  begin19.writeUInt32LE(1, 8);
  const matrix = rec(29, dbl([2, 0, 0, 100, 0, 3, 0, 200, 0, 0, 1, 0, 0, 0, 0, 1]));
  const poly = rec(6, Buffer.concat([Buffer.from([2, 0, 0, 0]), dbl([0, 0, 0, 1, 2, 0])]));
  const end = rec(31, Buffer.alloc(0));
  const body = Buffer.concat([begin19, matrix, poly, end]);
  const total = Buffer.alloc(8);
  total.writeUInt32LE(8 + body.length, 0);
  total.writeUInt32LE(1, 4);
  const r = decodeProxyGraphics(Buffer.concat([total, body]).toString("hex"));
  assert.ok(r);
  assert.equal(r.primitives.length, 1);
  assert.deepEqual(r.primitives[0].points[0], [100, 200]);
  assert.deepEqual(r.primitives[0].points[1], [102, 206]);
});

/* ── 实体替换 ── */

/** ENTITIES + BLOCKS 的最小 DXF；块 B 里放一条合法 IAEC_WALL（handle E8A9） */
function miniDxf(entityRows) {
  return [
    "0", "SECTION", "2", "ENTITIES",
    ...entityRows,
    "0", "ENDSEC",
    "0", "SECTION", "2", "BLOCKS",
    "0", "BLOCK", "5", "B1", "8", "0", "2", "B", "70", "0",
    "10", "0", "20", "0", "30", "0", "3", "B", "1", "",
    "0", "IAEC_WALL", "5", "E8A9", "8", "WALL", "62", "5",
    "160", "152", "310", WALL_HEX.slice(0, 100), "310", WALL_HEX.slice(100),
    "100", "IcDbEntity", "79", "0", "100", "IcDbWall",
    "0", "ENDBLK", "5", "B2", "8", "0",
    "0", "ENDSEC", "0", "EOF", "",
  ].join("\n");
}

const splitEntities = (text, type) => {
  const out = [];
  let cur = null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const c = lines[i].trim();
    const v = lines[i + 1].trim();
    if (c === "0") {
      if (cur && cur.type === type) out.push(cur.pairs);
      cur = { type: v, pairs: [] };
    } else if (cur) cur.pairs.push([c, v]);
  }
  if (cur && cur.type === type) out.push(cur.pairs);
  return out;
};

test("替换：保留 handle/图层/颜色，自定义实体 → 标准实体", () => {
  const src = miniDxf([
    "0", "IAEC_TEXT", "5", "E8A8", "8", "PUB_TEXT", "62", "1",
    "310", TEXT_HEX,
    "100", "IcDbEntity", "100", "IcDbText", "1", "风井",
  ]);
  const res = convertProxyGraphicsEntities(src, 0x9000);
  assert.equal(res.converted, 2, "ENTITIES 一条 + BLOCKS 一条");
  assert.equal(res.unsupported, 0);
  assert.doesNotMatch(res.text, /\nIAEC_TEXT\r?\n/);
  assert.doesNotMatch(res.text, /\nIAEC_WALL\r?\n/);

  const texts = splitEntities(res.text, "TEXT");
  assert.equal(texts.length, 1);
  assert.equal(texts[0].find(([c]) => c === "5")?.[1], "E8A8", "原 handle 必须保留");
  assert.ok(texts[0].some(([c, v]) => c === "8" && v === "PUB_TEXT"));
  assert.ok(texts[0].some(([c, v]) => c === "62" && v === "1"));
  assert.ok(texts[0].some(([c, v]) => c === "1" && v === "风井"));

  const polys = splitEntities(res.text, "LWPOLYLINE");
  assert.equal(polys.length, 2, "块内墙 = 两条 2 点折线");
  assert.ok(polys.every((p) => p.some(([c, v]) => c === "8" && v === "WALL")));
  assert.ok(polys.every((p) => p.some(([c, v]) => c === "62" && v === "5")));
  assert.equal(polys[0].find(([c]) => c === "5")?.[1], "E8A9", "第一条保留原 handle");
  assert.equal(polys[1].find(([c]) => c === "5")?.[1], "9000", "追加实体从 startHandle 起");
});

/* ── v46：代理文字 → 单线笔画 ── */

/** 单线字体桩：每个字符一条 2×4 的矩形折线（字体单位，units=1 → 按字高缩放） */
const STUB_GLYPH = {
  polylines: [
    [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 4 },
      { x: 0, y: 4 },
      { x: 0, y: 0 },
    ],
  ],
  lastPoint: { x: 3, y: 0 },
  bbox: { minX: 0, minY: 0, maxX: 2, maxY: 4 },
};

/** 只含一条真实 IAEC_TEXT（风井 / handle E8A8）的最小 DXF（复用 miniDxf 的块墙） */
const textDxf = () =>
  miniDxf([
    "0", "IAEC_TEXT", "5", "E8A8", "8", "PUB_TEXT", "62", "1",
    "310", TEXT_HEX,
    "100", "IcDbEntity", "100", "IcDbText", "1", "风井",
  ]);

/** 注入字形的 SHX 上下文（不碰文件系统） */
const stubShxCtx = (resolveShape) =>
  createShxContext({
    styleTable: { PROXYFONT: { font: "SIMPLEX", bigFont: "GBCBIG", widthFactor: 0.7 } },
    resolveShape,
    textStroke: "auto",
  });

/** 从 splitEntities 的 pairs 里取 (10,20) 顶点 */
function pairsToPoints(pairs) {
  const out = [];
  let x = null;
  for (const [c, v] of pairs) {
    if (c === "10") x = Number(v);
    else if (c === "20" && x !== null) {
      out.push([x, Number(v)]);
      x = null;
    }
  }
  return out;
}

test("v46：有 SHX 上下文时代理文字 → 单线笔画（handle/图层/颜色/位置/字高保留）", async () => {
  const ctx = await stubShxCtx(() => STUB_GLYPH);
  const res = convertProxyGraphicsEntities(textDxf(), 0x9000, { shxCtx: ctx });

  assert.equal(res.textsStroked, 1);
  assert.equal(res.textsKept, 0);
  assert.equal(res.strokePolylines, 2, "风 / 井 各一条折线");
  assert.equal(splitEntities(res.text, "TEXT").length, 0, "不应再留 TEXT");

  const polys = splitEntities(res.text, "LWPOLYLINE").filter((p) =>
    p.some(([c, v]) => c === "8" && v === "PUB_TEXT")
  );
  assert.equal(polys.length, 2);
  assert.equal(polys[0].find(([c]) => c === "5")?.[1], "E8A8", "第一条保留原 handle");
  assert.equal(polys[1].find(([c]) => c === "5")?.[1], "9000", "后续笔画从 startHandle 起");
  assert.ok(polys.every((p) => p.some(([c, v]) => c === "62" && v === "1")));

  // 第一个顶点 = TEXT 插入点；字形 2×4 单位 × 字高 503.7037
  const a = pairsToPoints(polys[0]);
  assert.ok(near(a[0][0], 1030433.214660262));
  assert.ok(near(a[0][1], -203508.501745377));
  const xs = a.map((p) => p[0]);
  const ys = a.map((p) => p[1]);
  assert.ok(near(Math.max(...xs) - Math.min(...xs), 2 * 503.70370370370375));
  assert.ok(near(Math.max(...ys) - Math.min(...ys), 4 * 503.70370370370375));
  // 第二个字前进 3 个字体单位（lastPoint.x），与 renderShxText 的字距一致
  const b = pairsToPoints(polys[1]);
  assert.ok(near(b[0][0] - a[0][0], 3 * 503.70370370370375));
});

test("v46：缺字形时保留原 TEXT（宁可回退 TTF，也不能把字吃掉）", async () => {
  // 只提供「风」(U+98CE) 的字形，「井」缺失 → 整条不转
  const ctx = await stubShxCtx((style, code) => (code === 0x98ce ? STUB_GLYPH : null));
  const res = convertProxyGraphicsEntities(textDxf(), 0x9000, { shxCtx: ctx });

  assert.equal(res.textsStroked, 0);
  assert.equal(res.textsKept, 1);
  const texts = splitEntities(res.text, "TEXT");
  assert.equal(texts.length, 1);
  assert.ok(texts[0].some(([c, v]) => c === "1" && v === "风井"));
  assert.equal(
    splitEntities(res.text, "LWPOLYLINE").filter((p) =>
      p.some(([c, v]) => c === "8" && v === "PUB_TEXT")
    ).length,
    0
  );
});


test("解不出来/格式不符的实体原样保留（ACAD_PROXY_ENTITY 的 310 不是这个格式）", () => {
  const src = miniDxf([
    "0", "ACAD_PROXY_ENTITY", "5", "F001", "8", "PROXY", "310", "DEADBEEF00",
    "0", "MYSTERY", "5", "F002", "8", "M", "310", "00000000",
  ]);
  const res = convertProxyGraphicsEntities(src, 0x9000);
  assert.equal(res.converted, 1, "只替换 BLOCKS 里那条合法 IAEC_WALL");
  assert.equal(res.unsupported, 2);
  assert.match(res.text, /\nACAD_PROXY_ENTITY\r?\n/);
  assert.match(res.text, /\nMYSTERY\r?\n/);
  assert.match(res.text, /\nDEADBEEF00\r?\n/);
});

test("坏记录（长度越界）不会产出半截几何，也不会崩溃", () => {
  const bad = "20000000" + "13000000" + "01000000"; // total=32，实际只有 12 字节
  assert.equal(decodeProxyGraphics(bad), null);
  const res = convertProxyGraphicsEntities(miniDxf([
    "0", "IAEC_WALL", "5", "F003", "8", "W", "310", bad,
  ]), 0x9000);
  // 块里那条合法的墙仍然替换；坏的那条保持原样
  assert.equal(res.converted, 1);
  assert.equal(res.unsupported, 1);
  assert.match(res.text, /\nIAEC_WALL\r?\n5\r?\nF003\r?\n/);
});
