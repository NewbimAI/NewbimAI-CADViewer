/**
 * AutoCAD 标准代理图形解码器的 golden 测试。
 *
 * 三条真实 310 数据来自 cadcraft 转出的机柜图（acad-cab.dxf）：
 *   E8A9  IAEC_WALL   → 两条墙线
 *   E8A8  IAEC_TEXT   → “风井”文字（SIMPLEX/GBCBIG）
 *   E897  IAEC_ARROW  → 填充三角 + 两条文字
 * D5FE 来自 acadrust 转出的同一张图：只有属性记录、没有几何，用来锁住
 * “trait-only 不能误判成可解码几何”这条边界。
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeAutoCadProxy,
  probeAutoCadProxy,
  classifyProxyGraphics,
} from "./proxy-autocad.js";

const WALL_HEX =
  "98000000040000000C00000013000000010000003C0000000600000002000000D22C568ACD752F41AADBD2B24CA008C10000" +
  "000000000000D42C568AA59D2F41AEDBD2B24CA008C100000000000000000C00000013000000020000003C00000006000000" +
  "02000000D22C568A95762F4197DBD2B28CA608C10000000000000000E02C568A159C2F419BDBD2B28CA608C1000000000000" +
  "0000";

const TEXT_HEX =
  "DC000000020000000C0000001300000001000000C8000000260000002BF3E76D42722F4185149303A4D708C1000000000000" +
  "000000000000000000000000000000000000000000000000F03F000000000000F03F00000000000000000000000000000000" +
  "CE98954E000000000200000000000000B597D05E427B7F40000000000000F03F0000000000000000000000000000F03F0000" +
  "0000000000000000000000000000000000000000000000000000000000000000000000000000530049004D0050004C004500" +
  "5800000047004200430042004900470000000000";

const FILL_HEX =
  "58030000100000000C00000013000000010000000C0000000E00000007000000C80000002600000088646BFF79CBC140E0D0" +
  "B7CAFE13D140000000000000000000000000000000000000000000000000000000000000F03F000000000000F03F00000000" +
  "00000000000000000000000061575390000000000200000000000000A376256A57027840000000000000F03F000000000000" +
  "0000000000000000F03F0000000000000000000000000000000000000000000000000000000086000000310000004C006900" +
  "5300750000000000530049004D004C0049002E005400540046000000000000000C0000001300000002000000C40000002600" +
  "00007EC4F4D90F54C240E0D0B7CAFE87D040000000000000000000000000000000000000000000000000000000000000F03F" +
  "000000000000F03F000000000000000000000000000000000A4E00000100000000000000A376256A57027840000000000000" +
  "F03F0000000000000000000000000000F03F0000000000000000000000000000000000000000000000000000000086000000" +
  "310000004C0069005300750000000000530049004D004C0049002E005400540046000000000000000C000000130000000300" +
  "0000880000001D000000000000000000F03F0000000000000000000000000000000000000000000000000000000000000000" +
  "000000000000F03F0000000000000000000000000000000000000000000000000000000000000000000000000000F03F0000" +
  "000000000000000000000000000000000000000000000000000000000000000000000000F03F0C0000000E00000008000000" +
  "0C00000012000000000000000C000000140000000100000080000000090000000300000000E57DF2BA80C140E0D0B7CABEF9" +
  "D040000000000000000090E47DF2BA16C240E0D0B7CABEEFD040000000000000000090E47DF2BA16C240E0D0B7CABE03D140" +
  "0000000000000000040000000300000001000000000000000200000040000000010000000100000001000000000000000000" +
  "0000080000001F0000000C00000013000000040000000C00000012000000FF7F00000C00000014000000020000003C000000" +
  "0600000002000000005D7E769038C440E0D0B7CABEF9D040000000000000000000E57DF2BA80C140E0D0B7CABEF9D0400000" +
  "000000000000";

const TRAIT_ONLY_HEX =
  "68000000070000000C00000010000000180000000C00000016000000000000C00C00000012000000FF7F00000C0000001700" +
  "0000FFFFFFFF1000000018000000000000000000F03F10000000190000000000000000000000100000001A00000000000000" +
  "00000000";

// 真实 33 号 LWPOLYLINE 记录 + 合法容器头
const LWPOLYLINE_HEX = "310000000100000029000000210000001a000000902200000000000e03f00ffffffffffdfbf3800000000000e03f000000";

const close = (actual, expected, eps = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} !~= ${expected}`);

test("wall E8A9: two straight polylines with real coordinates", () => {
  const probe = probeAutoCadProxy(WALL_HEX);
  assert.equal(probe.ok, true);
  assert.equal(probe.hasGeometry, true);
  assert.equal(probe.traitOnly, false);

  const result = decodeAutoCadProxy(WALL_HEX);
  assert.ok(result);
  assert.equal(result.primitives.length, 2);
  assert.equal(result.stats.polylines, 2);
  assert.equal(result.stats.traitOnly, false);

  const [a, b] = result.primitives;
  assert.equal(a.type, "polyline");
  assert.equal(b.type, "polyline");
  assert.equal(a.closed, false);
  assert.equal(a.points.length, 2);
  close(a.points[0][0], 1030886.7701887137);
  close(a.points[0][1], -201737.58731624234);
  close(a.points[1][0], 1035986.7701887139);
  close(a.points[1][1], -201737.58731624245);
  close(b.points[0][0], 1030986.7701887137);
  close(b.points[0][1], -201937.58731624178);
  close(b.points[1][0], 1035786.7701887153);
  close(b.points[1][1], -201937.5873162419);
});

test("text E8A8: unicode text2 with Chinese, height and SHX fonts", () => {
  const result = decodeAutoCadProxy(TEXT_HEX);
  assert.ok(result);
  assert.equal(result.primitives.length, 1);
  assert.equal(result.stats.texts, 1);

  const [t] = result.primitives;
  assert.equal(t.type, "text");
  assert.equal(t.text, "风井");
  close(t.x, 1030433.2146602621);
  close(t.y, -203508.50174537688);
  close(t.height, 503.70370370370375);
  close(t.widthFactor, 1);
  close(t.rotation, 0);
  assert.equal(t.font, "SIMPLEX");
  assert.equal(t.bigFont, "GBCBIG");
});

test("fill E897: folded shell becomes a real triangle, texts still decode", () => {
  const result = decodeAutoCadProxy(FILL_HEX);
  assert.ok(result);
  assert.equal(result.stats.fillRecords, 1);
  assert.equal(result.stats.shells, 1);
  assert.equal(result.stats.triangles, 1);

  const triangles = result.primitives.filter((p) => p.type === "triangle");
  assert.equal(triangles.length, 1);
  const [tri] = triangles;
  close(tri.points[0][0], 9261.4605252615);
  close(tri.points[0][1], 17342.981122926692);
  close(tri.points[1][0], 8961.460525261704);
  close(tri.points[1][1], 17382.981122926692);
  close(tri.points[2][0], 9261.4605252615);
  close(tri.points[2][1], 17422.981122926692);

  const texts = result.primitives.filter((p) => p.type === "text");
  assert.equal(texts.length, 2);
  assert.equal(texts[0].text, "坡道");
  assert.equal(texts[1].text, "上");
});

test("opcode 33 LWPOLYLINE: bit-packed vertices are decoded", () => {
  const probe = probeAutoCadProxy(LWPOLYLINE_HEX);
  assert.equal(probe.ok, true);
  assert.deepEqual(probe.opcodes, [33]);

  const result = decodeAutoCadProxy(LWPOLYLINE_HEX);
  assert.ok(result);
  assert.equal(result.stats.lwpolylines, 1);
  assert.equal(result.primitives.length, 1);
  const [p] = result.primitives;
  assert.equal(p.type, "polyline");
  assert.equal(p.closed, false);
  assert.equal(p.points.length, 2);
  close(p.points[0][0], 0.5);
  close(p.points[0][1], -0.5);
  close(p.points[1][0], 0.5);
  close(p.points[1][1], 0.5);
});

test("trait-only proxy graphics: no geometry, no false positives", () => {
  const probe = probeAutoCadProxy(TRAIT_ONLY_HEX);
  assert.equal(probe.ok, true);
  assert.equal(probe.hasGeometry, false);
  assert.equal(probe.traitOnly, true);
  assert.equal(classifyProxyGraphics(TRAIT_ONLY_HEX, { entityType: "ACAD_PROXY_ENTITY" }), "trait-only");

  const result = decodeAutoCadProxy(TRAIT_ONLY_HEX);
  assert.ok(result);
  assert.deepEqual(result.primitives, []);
  assert.deepEqual(result.unsupportedKinds, {});
  assert.equal(result.stats.traitOnly, true);
  assert.equal(result.stats.records, 7);
});

test("classifier: pure legacy subset stays on proxy-graphics.js", () => {
  assert.equal(classifyProxyGraphics(WALL_HEX, { entityType: "IAEC_WALL" }), "legacy");
  assert.equal(classifyProxyGraphics(TEXT_HEX, { entityType: "IAEC_TEXT" }), "legacy");
});

test("classifier: opcode 33 LWPOLYLINE prefers the standard decoder", () => {
  assert.equal(classifyProxyGraphics(LWPOLYLINE_HEX, { entityType: "IAEC_OPENING" }), "autocad");
});

test("classifier: ACAD_PROXY_ENTITY with geometry goes to the standard decoder", () => {
  assert.equal(classifyProxyGraphics(WALL_HEX, { entityType: "ACAD_PROXY_ENTITY" }), "autocad");
});

test("classifier: an opcode outside the legacy subset selects the standard decoder", () => {
  // 3 号 Circle3P：三点圆，旧解码器没有实现
  const payload = Buffer.alloc(72);
  const points = [[1, 0, 0], [0, 1, 0], [-1, 0, 0]];
  points.forEach((p, i) => {
    for (let k = 0; k < 3; k++) payload.writeDoubleLE(p[k], i * 24 + k * 8);
  });
  const record = Buffer.alloc(8);
  record.writeUInt32LE(8 + payload.length, 0);
  record.writeUInt32LE(3, 4);
  const header = Buffer.alloc(8);
  header.writeUInt32LE(8 + record.length + payload.length, 0);
  header.writeUInt32LE(1, 4);
  const hex = Buffer.concat([header, record, payload]).toString("hex");
  assert.equal(classifyProxyGraphics(hex, { entityType: "IAEC_OPENING" }), "autocad");
  const result = decodeAutoCadProxy(hex);
  assert.ok(result);
  assert.equal(result.stats.circles, 1);
});

test("guards: malformed / oversized blobs return null or a reason", () => {
  assert.equal(decodeAutoCadProxy("00"), null);
  assert.equal(decodeAutoCadProxy(WALL_HEX.slice(0, -2)), null);
  const bad = probeAutoCadProxy(WALL_HEX.slice(0, -2));
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "length-mismatch");

  const huge = "00".repeat(9 * 1024 * 1024);
  assert.equal(probeAutoCadProxy(huge).reason, "too-large");
  assert.equal(decodeAutoCadProxy(huge), null);

  const broken = Buffer.from(WALL_HEX, "hex");
  broken.writeUInt32LE(4, 8); // size < 8
  assert.equal(decodeAutoCadProxy(broken), null);
  assert.equal(probeAutoCadProxy(broken).reason, "broken-record");
});
