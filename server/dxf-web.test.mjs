/**
 * dxf-web.js 的 SHX 文字转换测试（v18）：不需要真实 .shx 文件，用注入字形的上下文。
 *
 * 覆盖：
 *   · 顶层 MTEXT 的内联码清理 + 整段替换；
 *   · 尺寸标注预渲染块（*D）内的 TEXT/MTEXT 原地转 LWPOLYLINE（坐标不改）；
 *   · 没有字形时原文一字不动（v17 兼容保证）。
 *
 * 运行：node --test server/dxf-web.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import DxfParser from "dxf-parser";

import {
  convertShxTexts,
  buildTableEntities,
  buildBlockTextEntities,
  quadsForPolyline,
  strokeWidthFor,
  STROKE_SOLID_LIMIT,
  bakeBlockColours,
  layerAciTable,
  layerNames,
  parseFocus,
  FOCUS_MUTED_COLOR,
  buildWebDxf,
  hiddenLayerTable,
  filterHiddenLayers,
  convertLeaders,
  convertMultiLeaders,
  convertMLines,
  parseMLinePairs,
  parseSpace,
  parseLayouts,
  listSpaces,
  filterModelSpace,
  filterFlatTexts,
  extractSpatialFilters,
  injectSpatialFilterXdata,
  clipFlattenedTexts,
  shxTextIsComplete,
  resolveTextStrokeMode,
  filterStrayEntities,
  countEntitiesInBox,
  resolveStrayFilter,
  strayLimitBox,
  STRAY_FILTER_FACTOR,
  STRAY_ABS_LIMIT,
  buildExportDxf,
  buildExportDxfSafe,
  DXF_WEB_VERSION,
} from "./dxf-web.js";
import { flattenTexts } from "./block-text.js";
import { createShxContext } from "./shx-text.js";
import {
  ClipSegmentToPolygons,
  ClipTriangleByPolygons,
} from "../web/vendor/dxf-viewer/src/Clipping.js";

/** 单位正方形字形：1×1，字宽 1 */
function unitSquare() {
  return {
    polylines: [
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ],
    ],
    lastPoint: { x: 1, y: 0 },
    bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
  };
}

const STYLE = { font: "fake.shx", height: 0, widthFactor: 1, oblique: 0 };

test("v47：文字笔画默认 always（全部单线骨架），环境变量/options 仍可覆盖", () => {
  // 用户硬要求：默认不能再回到 auto（v36 的混排回退）
  assert.equal(resolveTextStrokeMode({}, {}), "always");
  assert.equal(resolveTextStrokeMode({}, { CADVIEWER_TEXT_STROKE: "auto" }), "auto");
  assert.equal(resolveTextStrokeMode({}, { CADVIEWER_TEXT_STROKE: "never" }), "never");
  // options 优先于环境变量
  assert.equal(
    resolveTextStrokeMode({ textStroke: "Always" }, { CADVIEWER_TEXT_STROKE: "auto" }),
    "always"
  );
});

function ctxFor(resolveShape) {
  return createShxContext({
    root: process.cwd(),
    styleTable: { F: STYLE },
    resolveShape,
  });
}

/**
 * 最小可解析 DXF：
 *   ENTITIES: 1 条 MTEXT（顶层，带字体/对齐码）+ 1 个 DIMENSION 指向 *D1
 *   BLOCKS:   *D1 里 1 条 MTEXT + 1 条 TEXT
 */
function fixture() {
  return [
    "0", "SECTION", "2", "ENTITIES",
    "0", "MTEXT",
    "5", "10",
    "100", "AcDbEntity",
    "8", "0",
    "100", "AcDbMText",
    "10", "100",
    "20", "50",
    "40", "10",
    "71", "1",
    "7", "F",
    "1", "{\\fArial|b0;\\A1;25}",
    "0", "DIMENSION",
    "5", "11",
    "8", "0",
    "2", "*D1",
    "0", "ENDSEC",
    "0", "SECTION", "2", "BLOCKS",
    "0", "BLOCK",
    "5", "20",
    "8", "0",
    "2", "*D1",
    "70", "0",
    "10", "0", "20", "0", "30", "0",
    "3", "*D1",
    "1", "",
    "0", "MTEXT",
    "5", "21",
    "100", "AcDbEntity",
    "8", "0",
    "100", "AcDbMText",
    "10", "100",
    "20", "50",
    "40", "10",
    "71", "1",
    "7", "F",
    "62", "1",
    "1", "\\A1;25",
    "0", "TEXT",
    "5", "22",
    "100", "AcDbEntity",
    "8", "0",
    "100", "AcDbText",
    "10", "0",
    "20", "0",
    "40", "10",
    "7", "F",
    "1", "AB",
    "0", "ENDBLK",
    "5", "23",
    "8", "0",
    "0", "ENDSEC",
    "0", "EOF",
    "",
  ].join("\n");
}

const normalizeEol = (s) => s.replace(/\r\n/g, "\n");

/** 取出某个 *D 块里所有 LWPOLYLINE 的 bbox（块坐标） */
function dimBlockPolylineBBox(text, blockName) {
  const lines = normalizeEol(text).split("\n");
  let inBlocks = false;
  let inBlock = false;
  let name = null;
  const polys = [];
  let pts = null;
  for (let i = 0; i < lines.length; i++) {
    const c = lines[i].trim();
    const v = lines[i + 1]?.trim();
    if (c === "0" && v === "SECTION") {
      inBlocks = lines[i + 3]?.trim() === "BLOCKS";
      i += 3;
      continue;
    }
    if (c === "0" && v === "ENDSEC") {
      inBlocks = false;
      continue;
    }
    if (!inBlocks) continue;
    if (c === "0" && v === "BLOCK") {
      inBlock = true;
      name = null;
      continue;
    }
    if (c === "0" && v === "ENDBLK") {
      inBlock = false;
      name = null;
      continue;
    }
    if (inBlock && !name && c === "2") {
      name = v;
      continue;
    }
    if (!inBlock || name !== blockName) continue;
    if (c === "0" && v === "LWPOLYLINE") {
      pts = [];
      polys.push(pts);
      continue;
    }
    // 10/x 之后紧跟 20/y（中间隔一行 "20"）
    if (c === "10" && pts) {
      const x = Number(lines[i + 1]);
      const y = Number(lines[i + 3]);
      if (Number.isFinite(x) && Number.isFinite(y)) pts.push([x, y]);
    }
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const poly of polys) {
    for (const [x, y] of poly) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  return { minX, minY, maxX, maxY, count: polys.length };
}

test("顶层 MTEXT 与 *D 标注块文字都转成 LWPOLYLINE", async () => {
  const ctx = await ctxFor(() => unitSquare());
  const src = fixture();
  const res = convertShxTexts(src, ctx, 0x100, new Set(["0"]));

  assert.equal(res.texts, 1, "顶层 MTEXT 计入 texts");
  assert.equal(res.mtext, 1);
  assert.equal(res.dimTexts, 2, "块内 MTEXT + TEXT 共 2 条");
  assert.equal(res.dimMtext, 1);
  assert.equal(res.dimPolylines, 4, "两条两字符文字各 2 条折线");
  assert.equal(res.polylines, 6);
  assert.equal(res.missing, 0);

  const out = normalizeEol(res.text);
  // 顶层与块内的 MTEXT/TEXT 都应被替换（只剩组码值里的 AcDbMText 字样）
  assert.doesNotMatch(out, /^MTEXT$/m);
  assert.doesNotMatch(out, /^TEXT$/m);
  // DIMENSION 实体保留
  assert.match(out, /^DIMENSION$/m);
  // 块结构完整
  assert.match(out, /^BLOCK$/m);
  assert.match(out, /^ENDBLK$/m);
  assert.equal((out.match(/^LWPOLYLINE$/gm) || []).length, 6);
});

test("*D 块内折线用块坐标（与所替换 TEXT 的 10/20 相同），图层/颜色保留", async () => {
  const ctx = await ctxFor(() => unitSquare());
  const res = convertShxTexts(fixture(), ctx, 0x100, new Set(["0"]));
  const out = normalizeEol(res.text);

  // fixture 的块内 TEXT 在 (0,0)、字高 10；MTEXT 在 (100,50)、顶部附着。
  // 取块内所有 10/20 顶点，确认 (0..10, 0..10) 与 (100..120, 40..50) 两片都在。
  const bbox = dimBlockPolylineBBox(res.text, "*D1");
  assert.ok(Number.isFinite(bbox.minX), "应能在 *D1 里找到折线");
  assert.ok(bbox.minX <= 0 && bbox.maxX >= 120, `x 范围 ${bbox.minX}..${bbox.maxX}`);
  assert.ok(bbox.minY <= 0 && bbox.maxY >= 50, `y 范围 ${bbox.minY}..${bbox.maxY}`);

  // 图层 8 每条都写；颜色：源实体有 62 就照搬，没有（BYLAYER）就不写，交给块/图层解析
  const lw = out.split(/^LWPOLYLINE$/m).slice(1);
  assert.equal(lw.length, 6);
  for (const body of lw) assert.match(body, /^8$/m);
  assert.match(lw[0], /^62$/m, "顶层 MTEXT 沿用默认 7 号色");
  assert.match(lw[2], /^62$/m, "块内 MTEXT 显式 62=1 要保留");
  assert.doesNotMatch(lw[4], /^62$/m, "块内没有 62 的 TEXT 不应被强塞颜色");
});

test("*D 标注块文字按组码 50 旋转：rot=90 的标注数字输出竖排笔画（不是横排）", async () => {
  /* 实测 f98307048d9d 的 `2200`：DIMENSION 有预渲染块（*D105…），块内 MTEXT 组码 50=90；
   * dxf-viewer 对带块的 DIMENSION 只整块渲染（DxfScene.js `_DecomposeDimension`），
   * 标注数字的朝向完全由我们注入的笔画决定 —— 这里锁死"组码 50 必须作用到笔画上"。 */
  const dimFixture = (rot) =>
    [
      "0", "SECTION", "2", "ENTITIES",
      "0", "DIMENSION", "5", "11", "8", "0", "2", "*D1",
      "0", "ENDSEC",
      "0", "SECTION", "2", "BLOCKS",
      "0", "BLOCK", "5", "20", "8", "0", "2", "*D1", "70", "0",
      "10", "0", "20", "0", "30", "0", "3", "*D1", "1", "",
      "0", "MTEXT", "5", "21", "8", "0",
      "10", "100", "20", "50", "40", "10", "50", String(rot), "71", "5", "7", "F",
      "1", "\\A1;88",
      "0", "ENDBLK", "5", "23", "8", "0",
      "0", "ENDSEC", "0", "EOF", "",
    ].join("\n");

  const ctx = await ctxFor(() => unitSquare());
  const flat = convertShxTexts(dimFixture(0), ctx, 0x100, new Set(["0"]));
  const b0 = dimBlockPolylineBBox(flat.text, "*D1");
  assert.ok(b0.maxX - b0.minX > b0.maxY - b0.minY, `rot=0 应为横排：${JSON.stringify(b0)}`);

  const vert = convertShxTexts(dimFixture(90), ctx, 0x100, new Set(["0"]));
  const b90 = dimBlockPolylineBBox(vert.text, "*D1");
  assert.ok(b90.maxY - b90.minY > b90.maxX - b90.minX, `rot=90 应为竖排：${JSON.stringify(b90)}`);
  // 两个字符 = 20 高（advance 沿 +Y），字高 10 沿 X
  assert.ok(Math.abs(b90.maxY - b90.minY - 20) < 1e-9, `高 ${b90.maxY - b90.minY}`);
  assert.ok(Math.abs(b90.maxX - b90.minX - 10) < 1e-9, `宽 ${b90.maxX - b90.minX}`);
});

test("没有字形时原文一字不动（v17 兼容）", async () => {
  const ctx = await ctxFor(() => null);
  assert.equal(ctx.hasAnyShx, true, "样式仍是 SHX，只是取不到字形");
  const src = fixture();
  const res = convertShxTexts(src, ctx, 0x100, new Set(["0"]));
  assert.equal(res.text, src);
  assert.equal(res.texts, 0);
  assert.equal(res.mtext, 0);
  assert.equal(res.dimTexts, 0);
  assert.equal(res.dimPolylines, 0);
  assert.equal(res.used, 0);
});

test("非 SHX 样式（auto 模式）不转换顶层 MTEXT", async () => {
  const ctx = await createShxContext({
    root: process.cwd(),
    styleTable: { F: { font: "arial.ttf" } },
    resolveShape: () => unitSquare(),
    textStroke: "auto",
  });
  assert.equal(ctx.hasAnyShx, false);
  const src = fixture();
  const res = convertShxTexts(src, ctx, 0x100, new Set(["0"]));
  assert.equal(res.text, src);
});

test("图纸空间 TEXT 转成笔画后保留 67=1（不污染模型空间）", async () => {
  const src = [
    "0", "SECTION", "2", "ENTITIES",
    "0", "TEXT",
    "5", "10",
    "100", "AcDbEntity",
    "8", "0",
    "67", "1",
    "100", "AcDbText",
    "10", "0",
    "20", "0",
    "40", "10",
    "7", "F",
    "1", "AB",
    "0", "ENDSEC",
    "0", "EOF",
    "",
  ].join("\n");
  const ctx = await ctxFor(() => unitSquare());
  const res = convertShxTexts(src, ctx, 0x100, new Set(["0"]));
  assert.equal(res.texts, 1);
  const out = normalizeEol(res.text);
  assert.equal((out.match(/^LWPOLYLINE$/gm) || []).length, 2);
  assert.equal((out.match(/^67$/gm) || []).length, 2, "每条折线都要带 67");
  assert.doesNotMatch(out, /^TEXT$/m);
});

/* ─────────────────── v21：注入文字也必须走笔画转换 ─────────────────── */

/** 注册 STANDARD 的上下文（表格单元格没有组码 7，必须能落到 STANDARD） */
function ctxStandard(resolveShape) {
  return createShxContext({
    root: process.cwd(),
    styleTable: { STANDARD: STYLE },
    resolveShape,
  });
}

function flatItem(over = {}) {
  return {
    x: 0,
    y: 0,
    ax: null,
    ay: null,
    h: 10,
    rot: 0,
    wf: 1,
    halign: 0,
    valign: 0,
    mtext: false,
    wrapWidth: 0,
    text: "AB",
    layer: "0",
    aci: 7,
    style: "STANDARD",
    ...over,
  };
}

/** 从 builder 产出的 LWPOLYLINE 实体文本里取顶点 */
function lwPoints(entity) {
  const lines = entity.split(/\r?\n/);
  const pts = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "10") continue;
    const x = Number(lines[i + 1]);
    const y = Number(lines[i + 3]);
    if (Number.isFinite(x) && Number.isFinite(y)) pts.push([x, y]);
  }
  return pts;
}

function bboxOfEntities(entities) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const e of entities) {
    if (!/^0\r?\nLWPOLYLINE/.test(e)) continue;
    for (const [x, y] of lwPoints(e)) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

test("表格单元格：有笔画上下文时输出 LWPOLYLINE，无上下文时逐字节回退 TEXT", async () => {
  const table = {
    ins: [0, 0],
    dir: [1, 0],
    rows: 1,
    cols: 1,
    rowH: [100],
    colW: [200],
    cells: [{ h: 40, text: "AB" }],
    layer: "0",
    aci: 7,
  };
  const ctx = await ctxStandard(() => unitSquare());

  const stats = { strokes: 0, fallback: 0, mtextWrapped: 0 };
  const withCtx = buildTableEntities([table], new Set(["0"]), 0x100, null, ctx, stats);
  const joined = normalizeEol(withCtx.entities.join("\r\n"));
  assert.equal(stats.strokes, 1, "一个单元格文字 = 1 条注入文字");
  assert.equal(stats.fallback, 0);
  assert.equal((joined.match(/^LWPOLYLINE$/gm) || []).length, 6, "4 条网格 + 2 条笔画");
  assert.doesNotMatch(joined, /^TEXT$/m, "有字体时不应再注入 TEXT");

  const fallbackStats = { strokes: 0, fallback: 0, mtextWrapped: 0 };
  const noCtx = buildTableEntities([table], new Set(["0"]), 0x100, null, null, fallbackStats);
  const fallback = normalizeEol(noCtx.entities.join("\r\n"));
  assert.equal(fallbackStats.strokes, 0);
  assert.equal(fallbackStats.fallback, 1);
  assert.equal((fallback.match(/^LWPOLYLINE$/gm) || []).length, 4, "只有网格");
  assert.equal((fallback.match(/^TEXT$/gm) || []).length, 1);

  /* 无字体时表格注入的 TEXT 必须与 v20 的组码/顺序完全一致 */
  assert.deepEqual(noCtx.entities.slice(-34), [
    "0", "TEXT",
    "5", "104",
    "100", "AcDbEntity",
    "8", "0",
    "62", "7",
    "100", "AcDbText",
    "10", "100",
    "20", "-50",
    "30", "0.0",
    "40", "40",
    "1", "AB",
    "50", "0",
    "72", "1",
    "73", "2",
    "11", "100",
    "21", "-50",
    "31", "0.0",
  ]);
});

test("块内注入文字：无样式名的落 STANDARD 并转成笔画；未知样式不硬转", async () => {
  const ctx = await ctxStandard(() => unitSquare());
  for (const style of [undefined, ""]) {
    const stats = { strokes: 0, fallback: 0, mtextWrapped: 0 };
    const out = buildBlockTextEntities(
      [flatItem({ style })],
      new Set(["0"]),
      0x200,
      null,
      ctx,
      null,
      stats
    );
    assert.equal(stats.strokes, 1, `style=${String(style)} 应转换`);
    assert.equal(stats.fallback, 0);
    assert.equal(out.length, 2, "AB 两个字 = 2 条折线");
    assert.ok(out.every((e) => /^0\r?\nLWPOLYLINE/.test(e)));
    assert.ok(!out.some((e) => /^0\r?\nTEXT/m.test(e)));
  }

  /* 明确写了样式名但当前上下文没有（auto 模式下的 TTF 样式）→ 必须保留 TEXT，
   * 不能借 STANDARD 把 TTF 文字也转成笔画。 */
  const stats = { strokes: 0, fallback: 0, mtextWrapped: 0 };
  const out = buildBlockTextEntities(
    [flatItem({ style: "NO_SUCH_STYLE" })],
    new Set(["0"]),
    0x200,
    null,
    ctx,
    null,
    stats
  );
  assert.equal(stats.strokes, 0);
  assert.equal(stats.fallback, 1);
  assert.match(out[0], /^0\r?\nTEXT/);
});

test("块内注入文字：无字体时 TEXT 逐字节保持 v20 的产出", () => {
  const out = buildBlockTextEntities([flatItem()], new Set(["0"]), 0x200, null, null);
  assert.deepEqual(out, [
    [
      "0", "TEXT",
      "5", "200",
      "100", "AcDbEntity",
      "8", "0",
      "62", "7",
      "100", "AcDbText",
      "10", "0",
      "20", "0",
      "30", "0.0",
      "40", "10",
      "1", "AB",
    ].join("\r\n"),
  ]);
});

/** 含一个 4 字 MTEXT 的块 + INSERT，用于验证折行宽度真的影响排版 */
function wrapFixture() {
  return [
    "0", "SECTION", "2", "BLOCKS",
    "0", "BLOCK",
    "8", "0",
    "2", "*B",
    "70", "0",
    "10", "0", "20", "0", "30", "0",
    "3", "*B", "1", "",
    "0", "MTEXT",
    "5", "10",
    "8", "0",
    "10", "0",
    "20", "0",
    "40", "225",
    "41", "248",
    "71", "1",
    "7", "BZHZ",
    "1", "{\\W1;数据机架}",
    "0", "ENDBLK",
    "5", "12",
    "8", "0",
    "0", "ENDSEC",
    "0", "SECTION", "2", "ENTITIES",
    "0", "INSERT",
    "5", "13",
    "8", "0",
    "2", "*B",
    "10", "0",
    "20", "0",
    "41", "1",
    "42", "1",
    "50", "0",
    "0", "ENDSEC",
    "0", "EOF",
    "",
  ].join("\n");
}

test("MTEXT 折行宽度穿透展平与注入：h=225 / width=248 的 4 字标签折成「数据」「机架」两行", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cadviewer-wrap-"));
  const file = path.join(dir, "wrap.dxf");
  fs.writeFileSync(file, wrapFixture(), "utf8");

  try {
    const { items } = flattenTexts(file);
    const mt = items.find((it) => it.mtext);
    assert.ok(mt, "应能展平到 MTEXT");
    assert.equal(mt.text, "数据机架");
    assert.equal(mt.wrapWidth, 248, "组码 41 必须带出为 wrapWidth");

    const ctx = await createShxContext({
      root: process.cwd(),
      styleTable: { BZHZ: STYLE },
      resolveShape: () => unitSquare(),
    });
    const stats = { strokes: 0, fallback: 0, mtextWrapped: 0 };
    const out = buildBlockTextEntities([mt], new Set(["0"]), 0x300, null, ctx, null, stats);

    assert.equal(stats.strokes, 1);
    assert.equal(stats.mtextWrapped, 1, "宽度应触发折行");
    assert.equal(out.length, 4, "4 个汉字 = 4 条折线（2 行 × 2 字）");
    const box = bboxOfEntities(out);
    // 中文保护：每行至少 2 字 → 「数据」/「机架」，宽 450、高 = 225 + 1.6×225
    assert.ok(Math.abs(box.width - 450) < 1e-6, `width=${box.width}`);
    assert.ok(Math.abs(box.height - 585) < 1e-6, `height=${box.height}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ═════════════════ v25：CJK 笔画加粗成填充 SOLID（粗度靠面，不靠线宽）═════════════════
 * dxf-viewer 不实现变宽折线，所以加粗只能发 SOLID 填充面。这里覆盖：
 *   · 线段 → 四边形的角点顺序（SOLID 的 1,2,4,3）与线宽；
 *   · 按 cjk 标记选择 SOLID / LWPOLYLINE；
 *   · 线宽 option/env 覆盖；
 *   · SOLID 总数上限（全文件口径）与细线回退；
 *   · auto 模式逐字节不变（SHA 对比）。
 */

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));

const triArea = (a, b, c) =>
  Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;

function ctxAlways(resolveShape) {
  return createShxContext({
    root: process.cwd(),
    styleTable: { F: STYLE },
    resolveShape,
    textStroke: "always",
  });
}

/** 单条顶层 TEXT 的最小 DXF（图层 L、颜色 5） */
function singleText(text, over = {}) {
  const rows = [
    "0", "SECTION", "2", "ENTITIES",
    "0", "TEXT",
    "5", "10",
    "100", "AcDbEntity",
    "8", over.layer ?? "L",
  ];
  if (over.paperSpace) rows.push("67", "1");
  rows.push(
    "62", String(over.aci ?? 5),
    "100", "AcDbText",
    "10", String(over.x ?? 0),
    "20", String(over.y ?? 0),
    "40", String(over.h ?? 10),
    "7", "F",
    "1", text,
    "0", "ENDSEC",
    "0", "EOF",
    "",
  );
  return rows.join("\n");
}

/** 把 DXF 文本按实体切开，返回指定类型的 [code, value] 组码对数组 */
function splitEntities(text, type) {
  const lines = normalizeEol(text).split("\n");
  const out = [];
  let cur = null;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i].trim();
    const value = lines[i + 1] ?? "";
    if (code === "0") {
      if (cur && cur.type === type) out.push(cur.pairs);
      cur = { type: value.trim(), pairs: [] };
    } else if (cur) {
      cur.pairs.push([code, value.trim()]);
    }
  }
  if (cur && cur.type === type) out.push(cur.pairs);
  return out;
}

/** 一个 SOLID 实体的 10/11/12/13 角点（按组码顺序） */
function solidCorners(pairs) {
  const map = new Map(pairs);
  return ["10", "11", "12", "13"].map((c) => {
    const yCode = String(Number(c) + 10);
    return [Number(map.get(c)), Number(map.get(yCode))];
  });
}

test("quadsForPolyline：水平/斜线段的角点顺序与宽度（SOLID 1,2,4,3）", () => {
  // 水平段 (0,0)→(10,0)，线宽 2 → 法向 ±(0,1)
  const [hq] = quadsForPolyline([[0, 0], [10, 0]], 2);
  assert.deepEqual(hq, [
    [0, 1],   // 10 = A = p0+n
    [0, -1],  // 11 = B = p0-n
    [10, 1],  // 12 = D = p1+n（第 3、4 点互换）
    [10, -1], // 13 = C = p1-n
  ]);
  // 周长顺序是 0,1,3,2；面积 = 长 10 × 宽 2
  assert.ok(near(triArea(hq[0], hq[1], hq[3]) + triArea(hq[0], hq[3], hq[2]), 20));
  // dxf-viewer 的 _DecomposeFace 用 (0,1,2)+(1,3,2) 两个三角 → 面积和也必须是整条
  assert.ok(near(triArea(hq[0], hq[1], hq[2]) + triArea(hq[1], hq[3], hq[2]), 20));

  // 斜段 (0,0)→(3,4)，长度 5，线宽 2 → 单位法向 (-0.8, 0.6)
  const [dq] = quadsForPolyline([[0, 0], [3, 4]], 2);
  const nx = -0.8;
  const ny = 0.6;
  const expect = [
    [nx, ny],
    [-nx, -ny],
    [3 + nx, 4 + ny],
    [3 - nx, 4 - ny],
  ];
  for (let i = 0; i < 4; i++) {
    assert.ok(near(dq[i][0], expect[i][0]), `q${i}.x=${dq[i][0]}`);
    assert.ok(near(dq[i][1], expect[i][1]), `q${i}.y=${dq[i][1]}`);
  }
  // 宽度 = 2（A→B 的距离），面积 = 5 × 2
  assert.ok(near(Math.hypot(dq[0][0] - dq[1][0], dq[0][1] - dq[1][1]), 2));
  assert.ok(near(triArea(dq[0], dq[1], dq[2]) + triArea(dq[1], dq[3], dq[2]), 10));

  // 退化段（零长度）不产四边形
  assert.equal(quadsForPolyline([[1, 1], [1, 1]], 1).length, 0);
  // 线宽 <= 0 不产四边形
  assert.equal(quadsForPolyline([[0, 0], [1, 0]], 0).length, 0);
});

test("汉字笔画输出 SOLID（每段一个），拉丁仍为 LWPOLYLINE；图层/颜色保留", async () => {
  const ctx = await ctxAlways(() => unitSquare());
  const res = convertShxTexts(singleText("A中"), ctx, 0x100, new Set(["L"]), { thick: true, strokeWidth: 1 });

  assert.equal(res.texts, 1);
  const out = normalizeEol(res.text);
  assert.doesNotMatch(out, /^TEXT$/m);
  assert.equal((out.match(/^LWPOLYLINE$/gm) || []).length, 1, "A 保持一条细折线");
  assert.equal((out.match(/^SOLID$/gm) || []).length, 3, "中的 4 个顶点 = 3 段 = 3 个 SOLID");
  assert.equal(res.thickStrokeSolids, 3);
  assert.equal(res.thickStrokeFallback, 0);

  // 中 从笔位 10 起：首段 (10,0)→(20,0)，线宽 1
  const s = splitEntities(res.text, "SOLID")[0];
  assert.deepEqual(solidCorners(s), [
    [10, 0.5],
    [10, -0.5],
    [20, 0.5],
    [20, -0.5],
  ]);
  assert.ok(s.some(([c, v]) => c === "8" && v === "L"), "图层必须保留");
  assert.ok(s.some(([c, v]) => c === "62" && v === "5"), "颜色必须保留");
});

test("图纸空间汉字的 SOLID 同样带 67=1", async () => {
  const ctx = await ctxAlways(() => unitSquare());
  const res = convertShxTexts(singleText("中", { paperSpace: true }), ctx, 0x100, new Set(["L"]), {
    thick: true,
    strokeWidth: 1,
  });
  const solids = splitEntities(res.text, "SOLID");
  assert.equal(solids.length, 3);
  assert.ok(
    solids.every((pairs) => pairs.some(([c, v]) => c === "67" && v === "1")),
    "每条 SOLID 都要保留 67=1"
  );
});

test("线宽：绝对覆盖 / 环境变量倍数 / 图幅下限", () => {
  assert.ok(near(strokeWidthFor(10, { strokeWidth: 3 }), 3), "strokeWidth 是绝对图纸单位");
  assert.ok(near(strokeWidthFor(10, { strokeWidthMult: 0.1 }), 1));
  // 默认系数 0.055
  assert.ok(near(strokeWidthFor(10, { strokeWidthMult: 0.055 }), 0.55));
  // 图幅下限：0.001 × 0.055 = 5.5e-5，小于 1e-6 × 1e6 = 1
  assert.ok(near(strokeWidthFor(0.001, { strokeWidthMult: 0.055, drawingSize: 1e6 }), 1));

  const old = process.env.CADVIEWER_STROKE_WIDTH;
  process.env.CADVIEWER_STROKE_WIDTH = "0.2";
  try {
    assert.ok(near(strokeWidthFor(10, {}), 2), "env 是 h 的倍数");
    assert.ok(near(strokeWidthFor(10, { strokeWidth: 4 }), 4), "绝对线宽优先");
  } finally {
    if (old === undefined) delete process.env.CADVIEWER_STROKE_WIDTH;
    else process.env.CADVIEWER_STROKE_WIDTH = old;
  }
});

test("CADVIEWER_STROKE_WIDTH 环境变量端到端影响四边形宽度", async () => {
  const ctx = await ctxAlways(() => unitSquare());
  const old = process.env.CADVIEWER_STROKE_WIDTH;
  process.env.CADVIEWER_STROKE_WIDTH = "0.2";
  try {
    const res = convertShxTexts(singleText("中", { h: 10 }), ctx, 0x100, new Set(["L"]), { thick: true });
    const q = solidCorners(splitEntities(res.text, "SOLID")[0]);
    // h=10 × 0.2 = 2
    assert.ok(near(Math.hypot(q[0][0] - q[1][0], q[0][1] - q[1][1]), 2), "env 倍数必须真正作用到几何");
  } finally {
    if (old === undefined) delete process.env.CADVIEWER_STROKE_WIDTH;
    else process.env.CADVIEWER_STROKE_WIDTH = old;
  }
});

test("SOLID 上限：超出后整条折线退回细线并计入 thickStrokeFallback", async () => {
  const ctx = await ctxAlways(() => unitSquare());
  const state = { solids: 0, fallback: 0 };
  // 两个汉字各 3 段；上限 4 → 第一个 3 个 SOLID，第二个退回细线
  const res = convertShxTexts(singleText("中中"), ctx, 0x100, new Set(["L"]), {
    thick: true,
    strokeWidth: 1,
    maxSolids: 4,
    state,
  });

  const out = normalizeEol(res.text);
  assert.equal((out.match(/^SOLID$/gm) || []).length, 3);
  assert.equal((out.match(/^LWPOLYLINE$/gm) || []).length, 1, "剩余笔画保留可见的细线");
  assert.equal(res.thickStrokeSolids, 3);
  assert.equal(res.thickStrokeFallback, 1);
  assert.equal(state.solids, 3);
  assert.equal(state.fallback, 1);
});

test("SOLID 上限是全文件口径：正文与表格注入共用一个 state", async () => {
  const ctx = await ctxAlways(() => unitSquare());
  const state = { solids: 0, fallback: 0 };
  const shared = { thick: true, strokeWidth: 1, maxSolids: 4, state };

  const res = convertShxTexts(singleText("中"), ctx, 0x100, new Set(["L"]), shared);
  assert.equal(res.thickStrokeSolids, 3, "正文先占满 3 个");

  const table = {
    ins: [0, 0],
    dir: [1, 0],
    rows: 1,
    cols: 1,
    rowH: [100],
    colW: [200],
    cells: [{ h: 10, text: "中" }],
    layer: "L",
    aci: 7,
  };
  const stats = { strokes: 0, fallback: 0, mtextWrapped: 0 };
  const part = buildTableEntities([table], new Set(["L"]), 0x200, null, ctx, stats, shared);
  const joined = normalizeEol(part.entities.join("\r\n"));
  assert.equal((joined.match(/^SOLID$/gm) || []).length, 0, "表格只剩 1 个额度，3 段放不下");
  assert.equal(part.thickStrokeSolids, 0);
  assert.equal(part.thickStrokeFallback, 1);
  assert.equal(state.solids, 3);
  assert.equal(state.fallback, 1);
});

test("STROKE_SOLID_LIMIT 默认 400k", () => {
  assert.equal(STROKE_SOLID_LIMIT, 400000);
});

/** auto 模式 SHA 基准用的固定 DXF（含拉丁+汉字、MTEXT、标注块） */
function autoGoldenFixture() {
  return [
    "0", "SECTION", "2", "ENTITIES",
    "0", "TEXT",
    "5", "10",
    "100", "AcDbEntity",
    "8", "0",
    "100", "AcDbText",
    "10", "0",
    "20", "0",
    "40", "10",
    "7", "F",
    "1", "A\u4e2d",
    "0", "MTEXT",
    "5", "11",
    "100", "AcDbEntity",
    "8", "0",
    "100", "AcDbMText",
    "10", "100",
    "20", "50",
    "40", "10",
    "71", "1",
    "7", "F",
    "1", "{\\fArial|b0;\\A1;25}",
    "0", "DIMENSION",
    "5", "12",
    "8", "0",
    "2", "*D1",
    "0", "ENDSEC",
    "0", "SECTION", "2", "BLOCKS",
    "0", "BLOCK",
    "5", "20",
    "8", "0",
    "2", "*D1",
    "70", "0",
    "10", "0", "20", "0", "30", "0",
    "3", "*D1",
    "1", "",
    "0", "TEXT",
    "5", "22",
    "100", "AcDbEntity",
    "8", "0",
    "100", "AcDbText",
    "10", "0",
    "20", "0",
    "40", "10",
    "7", "F",
    "1", "\u4e2d",
    "0", "ENDBLK",
    "5", "23",
    "8", "0",
    "0", "ENDSEC",
    "0", "EOF",
    "",
  ].join("\n");
}

test("auto 模式不触发加粗：固定 fixture 的 SHA 与改动前一致", async () => {
  // fixture 里没有「汉字 + rot≈90°」的标签，因此这条 SHA 基准在取消正立堆叠特判后
  // 仍然有效；它锁的是「auto 模式加粗路径不改变任何输出字节」。
  const ctx = await createShxContext({
    root: process.cwd(),
    styleTable: { F: STYLE },
    resolveShape: () => unitSquare(),
    textStroke: "auto",
  });
  assert.equal(ctx.strokeAll, false);

  const conv = convertShxTexts(autoGoldenFixture(), ctx, 0x100, new Set(["0"]));

  const table = {
    ins: [0, 0],
    dir: [1, 0],
    rows: 1,
    cols: 1,
    rowH: [100],
    colW: [200],
    cells: [{ h: 40, text: "\u4e2dA" }],
    layer: "0",
    aci: 7,
  };
  const stats = { strokes: 0, fallback: 0, mtextWrapped: 0 };
  const tbl = buildTableEntities([table], new Set(["0"]), 0x200, null, ctx, stats);

  const flat = {
    x: 0,
    y: 0,
    ax: null,
    ay: null,
    h: 10,
    rot: 0,
    wf: 1,
    halign: 0,
    valign: 0,
    mtext: false,
    wrapWidth: 0,
    text: "\u4e2dA",
    layer: "0",
    aci: 7,
    style: "F",
  };
  const blk = buildBlockTextEntities([flat], new Set(["0"]), 0x300, null, ctx, null, stats);

  const payload = [conv.text, tbl.entities.join("\r\n"), blk.join("\r\n")].join("\n@@\n");
  assert.equal(
    crypto.createHash("sha256").update(payload, "utf8").digest("hex"),
    "c56fd2351d7bab1a190cf9bd1a548bef80035a1a821aa9b1c2c3101b165feba5",
    "auto 模式（不加粗）必须逐字节保持改动前输出"
  );
  assert.equal(Buffer.byteLength(payload, "utf8"), 1827);
  assert.equal((payload.match(/^SOLID$/gm) || []).length, 0, "auto 模式绝不发 SOLID");

  // 对照：同一份文件在单线体模式下必须真的加粗（差异来自模式，不是功能缺失）
  const ctxAlwaysText = await createShxContext({
    root: process.cwd(),
    styleTable: { F: STYLE },
    resolveShape: () => unitSquare(),
    textStroke: "always",
  });
  const conv2 = convertShxTexts(autoGoldenFixture(), ctxAlwaysText, 0x100, new Set(["0"]), { thick: true });
  const solids = (conv2.text.match(/^SOLID$/gm) || []).length;
  assert.ok(solids > 0, `always 模式应产出 SOLID，实际 ${solids}`);
  assert.equal(conv2.thickStrokeFallback, 0);
});

/* ═══════════════════════ v31：块内颜色烘焙 ═══════════════════════
 *
 * 背景（实测 7a75a89eebe1 / 施工005-车库消防.dwg）：
 *   · 939 个 $equip$00002649 消防设备插在 EQUIP-消防（ACI 3 绿）上，块内实体全在 0 层 BYLAYER，
 *     dxf-viewer 的实例化路径把 0 层解析成 7 号白 → 整片设备画成白色；
 *   · A$C29980DFE（7356 个实体、跨 A-WALL/建筑… 十几层）被摊平后，
 *     dxf-viewer 的 _FlattenBatch 把**每个** BYLAYER 实体都涂成 INSERT 图层色 → 整块单色。
 * 这两条都是 dxf-viewer 内部解析路径，服务端唯一安全的补偿是把应得的颜色写成显式 62。
 */

/** 只带 LAYER 表的最小 DXF 外壳（ACI：0=7, EQ=3, WALL=4 且为负数=图层关闭） */
function layersOnly() {
  return [
    "0", "SECTION", "2", "TABLES",
    "0", "TABLE", "2", "LAYER",
    "0", "LAYER", "2", "0", "70", "0", "62", "7",
    "0", "LAYER", "2", "EQ", "70", "0", "62", "3",
    "0", "LAYER", "2", "WALL", "70", "0", "62", "-4",
    "0", "ENDTAB",
    "0", "ENDSEC",
  ];
}

function blocksDoc({ refs, blocks }) {
  const out = layersOnly();
  out.push("0", "SECTION", "2", "ENTITIES");
  for (const r of refs) {
    out.push("0", "INSERT", "5", "A1", "8", r.layer, "2", r.name, "10", "0", "20", "0");
  }
  out.push("0", "ENDSEC", "0", "SECTION", "2", "BLOCKS");
  for (const b of blocks) {
    out.push("0", "BLOCK", "5", "B1", "8", "0", "2", b.name, "70", "0", "10", "0", "20", "0", "30", "0");
    for (const e of b.entities) out.push(...e);
    out.push("0", "ENDBLK", "5", "B2", "8", "0");
  }
  out.push("0", "ENDSEC", "0", "EOF", "");
  return out.join("\n");
}

/** BLOCKS 段里的实体（BLOCK/ENDBLK 除外），按文件顺序：{ type, colour } */
function blockEntities(text) {
  const lines = normalizeEol(text).split("\n");
  const out = [];
  let inBlocks = false;
  let cur = null;
  // 严格按「码/值」两行一组走：坐标值本身可能就是 "0"，逐行走会把值当码
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const c = lines[i].trim();
    const v = lines[i + 1].trim();
    if (c === "0") {
      if (cur) out.push(cur);
      cur = null;
      if (v === "SECTION") {
        inBlocks = lines[i + 3]?.trim() === "BLOCKS";
        continue;
      }
      if (v === "ENDSEC") {
        inBlocks = false;
        continue;
      }
      if (!inBlocks) continue;
      if (v === "BLOCK" || v === "ENDBLK") continue;
      cur = { type: v, colour: null };
      continue;
    }
    if (cur && c === "62") cur.colour = v;
  }
  if (cur) out.push(cur);
  return out;
}

const line = (layer, extra = []) => ["0", "LINE", "5", "E1", "8", layer, ...extra, "10", "0", "20", "0", "11", "1", "21", "0"];

test("v31 块内 0 层 BYLAYER：按 INSERT 图层烘焙（消防设备不再变白）", () => {
  const src = blocksDoc({
    refs: [{ name: "DEV", layer: "EQ" }],
    blocks: [{ name: "DEV", entities: [line("0")] }],
  });
  const res = bakeBlockColours(src);
  assert.equal(res.baked, 1);
  assert.equal(res.layerZeroBaked, 1);
  assert.equal(blockEntities(res.text)[0].colour, "3", "0 层应继承 INSERT 的 EQ 层 = ACI 3");
  assert.equal((normalizeEol(res.text).match(/^LINE$/gm) || []).length, 1);
});

test("v31 块内自有图层 BYLAYER：无论 INSERT 在哪层都烘焙成自己图层的颜色", () => {
  const src = blocksDoc({
    refs: [{ name: "B", layer: "EQ" }],
    blocks: [{ name: "B", entities: [line("WALL")] }],
  });
  const res = bakeBlockColours(src);
  assert.equal(res.baked, 1);
  assert.equal(res.layerZeroBaked, 0);
  assert.equal(blockEntities(res.text)[0].colour, "4", "关闭图层(-4)也要按 |ACI| 烘焙");
});

test("v31 62=256 改写成显式 ACI；62=0(BYBLOCK) 与显式 62 一律不动", () => {
  const src = blocksDoc({
    refs: [{ name: "B", layer: "EQ" }],
    blocks: [{
      name: "B",
      entities: [line("WALL", ["62", "256"]), line("0", ["62", "0"]), line("EQ", ["62", "1"])],
    }],
  });
  const res = bakeBlockColours(src);
  const got = blockEntities(res.text);
  assert.equal(got[0].colour, "4", "256 → WALL 的 4");
  assert.equal(got[1].colour, "0", "BYBLOCK 保持原位，交给 INSERT 解析");
  assert.equal(got[2].colour, "1", "显式颜色不动");
  assert.equal(res.baked, 1);
  assert.equal(res.byBlock, 1);
  assert.equal(res.explicit, 1);
});

test("v31 同一个块插在不同图层：0 层实体保持 BYLAYER（无法安全烘焙），自有图层照常烘焙", () => {
  const src = blocksDoc({
    refs: [{ name: "B", layer: "EQ" }, { name: "B", layer: "WALL" }],
    blocks: [{ name: "B", entities: [line("0"), line("WALL")] }],
  });
  const res = bakeBlockColours(src);
  const got = blockEntities(res.text);
  assert.equal(got[0].colour, null, "歧义块 0 层不加颜色");
  assert.equal(got[1].colour, "4", "自有图层的颜色与实例无关，仍然烘焙");
  assert.equal(res.ambiguous, 1);
  assert.equal(res.baked, 1);
});

test("v31 顶层插在 0 层：子实体保持 0 层语义，不烘焙", () => {
  const src = blocksDoc({
    refs: [{ name: "B", layer: "0" }],
    blocks: [{ name: "B", entities: [line("0")] }],
  });
  const res = bakeBlockColours(src);
  assert.equal(blockEntities(res.text)[0].colour, null);
  assert.equal(res.baked, 0);
  assert.equal(res.layerZeroSkipped, 1);
});

test("v31 嵌套块：0 层沿 INSERT 链继承到最外层图层", () => {
  const src = blocksDoc({
    refs: [{ name: "OUT", layer: "EQ" }],
    blocks: [
      { name: "OUT", entities: [["0", "INSERT", "5", "E9", "8", "0", "2", "IN", "10", "0", "20", "0"]] },
      { name: "IN", entities: [line("0")] },
    ],
  });
  const res = bakeBlockColours(src);
  const got = blockEntities(res.text);
  assert.equal(got[0].type, "INSERT");
  assert.equal(got[0].colour, null, "嵌套 INSERT 自身不是颜色载体");
  assert.equal(got[1].colour, "3", "IN 的 0 层应继承 OUT 的 EQ");
  assert.equal(res.layerZeroBaked, 1);
});

test("v31 顶层实体完全不受影响（只处理 BLOCKS 段）", () => {
  const src = [
    ...layersOnly(),
    "0", "SECTION", "2", "ENTITIES",
    "0", "LINE", "5", "E1", "8", "EQ", "10", "0", "20", "0", "11", "1", "21", "0",
    "0", "ENDSEC", "0", "EOF", "",
  ].join("\n");
  const res = bakeBlockColours(src);
  assert.equal(res.baked, 0);
  assert.equal(res.text, src, "没有可烘焙实体时逐字节不变");
});

test("v31 带 420 真彩色的块内实体不写 ACI（避免覆盖真彩色）", () => {
  const src = blocksDoc({
    refs: [{ name: "B", layer: "EQ" }],
    blocks: [{ name: "B", entities: [line("WALL", ["420", "65280"]), line("WALL")] }],
  });
  const res = bakeBlockColours(src);
  const got = blockEntities(res.text);
  assert.equal(got[0].colour, null, "420 实体不加 62");
  assert.equal(got[1].colour, "4");
  assert.equal(res.baked, 1);
});

/* ───────────────────────── v32：focus=mute:all（对比模式实体级灰显）───────────────────────── */

/* ───────────────────────── v32：隐藏图层 / LEADER / MULTILEADER / MLINE ───────────────────────── */

test("v32 parseFocus：mute:all 合法，mute 只接受 all，layer/block 行为不变", () => {
  assert.deepEqual(parseFocus("mute:all"), { kind: "mute", name: "all", spec: "mute:all" });
  assert.equal(parseFocus("mute:some"), null);
  assert.equal(parseFocus("mute:"), null);
  assert.deepEqual(parseFocus("layer:EQ"), { kind: "layer", name: "EQ", spec: "layer:EQ" });
  assert.deepEqual(parseFocus("block:B"), { kind: "block", name: "B", spec: "block:B" });
  assert.equal(parseFocus("nope:all"), null);
});

/** 图层 EQ(3) / WALL(4)，顶层两条线 + 一个块实例；块内有 LINE(EQ) 和 TEXT(WALL) */
function focusDoc() {
  return [
    "0", "SECTION", "2", "TABLES",
    "0", "TABLE", "2", "LAYER",
    "0", "LAYER", "2", "EQ", "70", "0", "62", "3",
    "0", "LAYER", "2", "WALL", "70", "0", "62", "4",
    "0", "ENDTAB", "0", "ENDSEC",
    "0", "SECTION", "2", "ENTITIES",
    ...vline("EQ", 0, 0, 1),
    "0", "LINE", "5", "E2", "8", "WALL", "62", "1", "10", "0", "20", "0", "11", "1", "21", "0",
    "0", "INSERT", "5", "E3", "8", "WALL", "2", "B", "10", "10", "20", "10",
    "0", "ENDSEC",
    "0", "SECTION", "2", "BLOCKS",
    "0", "BLOCK", "5", "B1", "8", "0", "2", "B", "70", "0", "10", "0", "20", "0", "30", "0",
    "0", "LINE", "5", "E4", "8", "EQ", "10", "0", "20", "0", "11", "1", "21", "0",
    "0", "TEXT", "5", "E5", "8", "WALL", "10", "0", "20", "0", "40", "2", "1", "BLKTXT",
    "0", "ENDBLK", "5", "B2", "8", "0",
    "0", "ENDSEC", "0", "EOF", "",
  ].join("\n");
}

/** 整份文件里 ENTITIES+BLOCKS 段的实体：{ type, layer, colour }（BLOCK/ENDBLK 不计） */
function entColours(text) {
  const lines = normalizeEol(text).split("\n");
  const out = [];
  let sec = null;
  let pendingSec = false;
  let cur = null;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const c = lines[i].trim();
    const v = lines[i + 1].trim();
    if (c === "0") {
      if (cur) out.push(cur);
      cur = null;
      if (v === "SECTION") {
        pendingSec = true;
        continue;
      }
      if (v === "ENDSEC") {
        sec = null;
        continue;
      }
      if (sec === "ENTITIES" || sec === "BLOCKS") cur = { type: v, layer: null, colour: null };
      continue;
    }
    if (pendingSec && c === "2") {
      sec = v;
      pendingSec = false;
      continue;
    }
    if (!cur) continue;
    if (c === "8") cur.layer = v;
    else if (c === "62") cur.colour = v;
  }
  if (cur) out.push(cur);
  return out.filter((e) => e.type !== "BLOCK" && e.type !== "ENDBLK" && e.type !== "SEQEND");
}

test("v32 focus=mute:all：所有实体（含注入文字/块内实体）都改成 ACI 8，kept=0", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cadviewer-mute-"));
  const file = path.join(dir, "mute.dxf");
  fs.writeFileSync(file, focusDoc(), "utf8");
  const out = path.join(dir, "web.dxf");
  const stats = await buildWebDxf(file, out, parseFocus("mute:all"), { shxText: false });
  assert.equal(stats.focusKept, 0, "mute:all 不做任何保留");
  assert.ok(stats.focusMuted >= 5);
  const ents = entColours(fs.readFileSync(out, "utf8"));
  const unmuted = ents.filter((e) => e.colour !== String(FOCUS_MUTED_COLOR));
  assert.deepEqual(unmuted, [], "没有实体逃过灰显");
  assert.ok(ents.some((e) => e.type === "TEXT" && e.colour === "8"), "注入的块内文字也是 8");
  assert.ok(ents.some((e) => e.type === "LWPOLYLINE" || e.type === "LINE"));
});

test("v32 focus=layer：保持不变（目标层不灰、其余灰）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cadviewer-layerfocus-"));
  const file = path.join(dir, "f.dxf");
  fs.writeFileSync(file, focusDoc(), "utf8");
  const out = path.join(dir, "web.dxf");
  const stats = await buildWebDxf(file, out, parseFocus("layer:WALL"), { shxText: false });
  assert.ok(stats.focusKept > 0, "目标层仍有保留");
  const ents = entColours(fs.readFileSync(out, "utf8"));
  const eqLine = ents.find((e) => e.type === "LINE" && e.layer === "EQ");
  assert.equal(eqLine.colour, "8", "非目标层的线灰显");
  const wallLine = ents.find((e) => e.type === "LINE" && e.layer === "WALL");
  assert.equal(wallLine.colour, "1", "目标层的显式色不动");
  const txt = ents.find((e) => e.type === "TEXT");
  assert.notEqual(txt.colour, "8", "目标层上的块内文字不被灰显");
});

/** LAYER 表 + ENTITIES；`layers` 每项 [name, 62, 70] */
function layersDoc(layers, entities) {
  const out = [
    "0", "SECTION", "2", "TABLES",
    "0", "TABLE", "2", "LAYER",
  ];
  for (const [name, color, flags] of layers) {
    out.push("0", "LAYER", "2", name, "70", String(flags ?? 0), "62", String(color));
  }
  out.push(
    "0", "ENDTAB",
    "0", "ENDSEC",
    "0", "SECTION", "2", "ENTITIES",
    ...entities,
    "0", "ENDSEC",
    "0", "EOF",
    ""
  );
  return out.join("\n");
}

const vline = (layer, x, y, t) => [
  "0", "LINE", "5", "E" + t, "8", layer,
  "10", String(x), "20", String(y), "11", String(x + 1), "21", String(y),
];

test("v33 关闭图层（62 为负）整段删除；冻结层保留；锁定（70=4）不删", () => {
  const src = layersDoc(
    [
      ["NORMAL", 7, 0],
      ["OFFLAY", -3, 0],
      ["FROZEN", 5, 1],
      ["LOCKED", 2, 4],
    ],
    [
      ...vline("NORMAL", 0, 0, 1),
      ...vline("OFFLAY", 10, 10, 2),
      ...vline("OFFLAY", 20, 20, 3),
      ...vline("FROZEN", 30, 30, 4),
      ...vline("LOCKED", 40, 40, 5),
      ...vline("0", 50, 50, 6),
    ]
  );
  const hidden = hiddenLayerTable(src);
  // 冻结层保留：fork 的 dxf-viewer 以 visible:false 载入，面板里还能打开
  assert.deepEqual([...hidden.keys()].sort(), ["OFFLAY"]);
  assert.equal(hidden.get("OFFLAY").reason, "off");

  const res = filterHiddenLayers(src, hidden);
  assert.equal(res.skipped, 2);
  assert.equal(res.off, 2);
  assert.equal(res.frozen, 0);
  assert.equal(res.layers.find((l) => l.name === "OFFLAY").entities, 2);
  const text = normalizeEol(res.text);
  assert.equal((text.match(/^LINE$/gm) || []).length, 4, "NORMAL / FROZEN / LOCKED / 0 四条都保留");
  assert.ok(!/\n10\n10\r?\n20\n10/.test(text), "OFFLAY 的实体（10,10）已删除");
  assert.ok(/\n10\n30\r?\n20\n30/.test(text), "FROZEN 的实体（30,30）必须保留");
});

test("v32 锁定层不会被当成关闭层（meta.json 的 off 只在 DXF 缺 62 时兜底）", () => {
  const src = layersDoc([["LOCKED", 9, 4]], [...vline("LOCKED", 0, 0, 1)]);
  assert.equal(hiddenLayerTable(src).size, 0);
  // 扫描器把 bit4 误判成 off 的历史数据：DXF 有 62 → 不采信 meta
  const meta = [{ name: "LOCKED", off: true, frozen: false }];
  assert.equal(hiddenLayerTable(src, meta).size, 0);
  // DXF 完全没写 62 时才采信 meta
  const srcNo62 = ["0", "SECTION", "2", "TABLES", "0", "LAYER", "2", "ZZZ", "70", "0",
    "0", "ENDTAB", "0", "ENDSEC", "0", "EOF", ""].join("\n");
  const got = hiddenLayerTable(srcNo62, [{ name: "ZZZ", off: true, frozen: false }]);
  assert.equal(got.get("ZZZ")?.reason, "off");
});

test("v32 layerNames：CLASSES 里的 1/TABLESTYLE 不能被当成 TABLES 段（否则注入实体全掉 0 层）", () => {
  const src = [
    "0", "SECTION", "2", "CLASSES",
    "0", "CLASS", "1", "TABLESTYLE", "2", "AcDbTableStyle",
    "0", "ENDSEC",
    "0", "SECTION", "2", "TABLES",
    "0", "TABLE", "2", "LAYER",
    "0", "LAYER", "2", "EQ", "70", "0", "62", "3",
    "0", "LAYER", "2", "MYLAYER", "70", "0", "62", "1",
    "0", "ENDTAB", "0", "ENDSEC", "0", "EOF", "",
  ].join("\n");
  const names = layerNames(src);
  assert.ok(names.has("MYLAYER"), "真实图层必须能读到");
  assert.ok(names.has("EQ"));
  assert.ok(!names.has("AcDbTableStyle"));
});

test("v32 buildWebDxf：skippedOffLayerEntities + 警告；关闭层文字也不再注入", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cadviewer-off-"));
  const file = path.join(dir, "off.dxf");
  const src = layersDoc(
    [["NORMAL", 7, 0], ["OFFLAY", -3, 0]],
    [
      ...vline("OFFLAY", 0, 0, 1),
      "0", "TEXT", "5", "E9", "8", "OFFLAY", "10", "0", "20", "0", "40", "10", "1", "HIDDEN",
      "0", "TEXT", "5", "EA", "8", "NORMAL", "10", "0", "20", "0", "40", "10", "1", "SHOWN",
    ]
  );
  fs.writeFileSync(file, src, "utf8");
  const out = path.join(dir, "web.dxf");
  const stats = await buildWebDxf(file, out, null, { shxText: false });
  assert.equal(stats.skippedOffLayerEntities, 2, "OFFLAY 上 1 LINE + 1 TEXT");
  assert.equal(stats.skippedFrozenLayerEntities, 0);
  const warn = stats.warnings.find((w) => w.code === "off-layer-filtered");
  assert.equal(warn.layer, "OFFLAY");
  assert.equal(warn.entities, 2);
  const text = fs.readFileSync(out, "utf8");
  assert.ok(!/\nHIDDEN\r?\n/.test(text), "关闭图层上的 TEXT 不保留");
  assert.ok(/\nSHOWN\r?\n/.test(text));
});

/** 测试辅助：只解析 ENTITIES 段的实体，返回 {type, get(code), all(code)} */
function parseEnts(text) {
  const lines = normalizeEol(text).split("\n");
  const out = [];
  let inEnt = false;
  let pendingSec = false;
  let cur = null;
  const make = (type) => ({
    type,
    pairs: [],
    get(code) {
      const p = this.pairs.find(([c]) => c === code);
      return p ? p[1] : null;
    },
    all(code) {
      return this.pairs.filter(([c]) => c === code).map(([, v]) => v);
    },
  });
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const c = lines[i].trim();
    const v = lines[i + 1].trim();
    if (c === "0") {
      if (cur) out.push(cur);
      cur = null;
      if (v === "ENDSEC") {
        inEnt = false;
        continue;
      }
      if (v === "SECTION") {
        pendingSec = true;
        continue;
      }
      if (inEnt) cur = make(v);
      continue;
    }
    if (pendingSec && c === "2") {
      inEnt = v === "ENTITIES";
      pendingSec = false;
      continue;
    }
    if (cur) cur.pairs.push([c, v]);
  }
  if (cur) out.push(cur);
  return out;
}

/** DIMSTYLE 表 + ENTITIES（箭头大小用 41 DIMASZ × 40 DIMSCALE） */
function leaderDoc(entities) {
  return [
    "0", "SECTION", "2", "TABLES",
    "0", "TABLE", "2", "LAYER",
    "0", "LAYER", "2", "LEAD", "70", "0", "62", "3",
    "0", "ENDTAB",
    "0", "TABLE", "2", "DIMSTYLE",
    "0", "DIMSTYLE", "2", "STANDARD", "70", "0", "40", "10", "41", "2", "140", "3.5",
    "0", "ENDTAB",
    "0", "ENDSEC",
    "0", "SECTION", "2", "ENTITIES",
    ...entities,
    "0", "ENDSEC", "0", "EOF", "",
  ].join("\n");
}

test("v32 LEADER：顶点 → LWPOLYLINE，首点箭头 → SOLID（尺寸 41×40）", () => {
  const src = leaderDoc([
    "0", "LEADER", "5", "L1", "8", "LEAD", "3", "STANDARD",
    "71", "1", "72", "0", "76", "3",
    "10", "100", "20", "0", "30", "0",
    "10", "50", "20", "50", "30", "0",
    "10", "0", "20", "50", "30", "0",
  ]);
  const res = convertLeaders(src, 0x100, { cbox: null });
  assert.equal(res.leadersConverted, 1);
  assert.equal(res.leaderArrows, 1);
  assert.equal(res.leaderFallbacks, 0);
  assert.equal(res.leaderAnnotations, 0, "没有 304/341 时不复制注释");
  const ents = parseEnts(res.text);
  assert.deepEqual(ents.map((e) => e.type), ["LWPOLYLINE", "SOLID"]);
  const poly = ents[0];
  assert.equal(poly.get("8"), "LEAD", "图层照搬");
  assert.equal(poly.get("62"), "3", "颜色 = 图层 ACI");
  const pts = poly.all("10").map((x, i) => [x, poly.all("20")[i]]);
  assert.deepEqual(pts, [["100", "0"], ["50", "50"], ["0", "50"]], "顶点顺序与原 LEADER 一致");
  // 箭头尖端在首顶点，底边朝第二顶点方向，长度 ≈ DIMASZ×DIMSCALE = 2×10
  const arrow = ents[1];
  const tip = [Number(arrow.get("10")), Number(arrow.get("20"))];
  const b1 = [Number(arrow.get("11")), Number(arrow.get("21"))];
  const b2 = [Number(arrow.get("12")), Number(arrow.get("22"))];
  const mid = [(b1[0] + b2[0]) / 2, (b1[1] + b2[1]) / 2];
  assert.ok(Math.abs(tip[0] - 100) < 1e-6 && Math.abs(tip[1]) < 1e-6, "尖端 = 首顶点");
  const bl = Math.hypot(mid[0] - tip[0], mid[1] - tip[1]);
  assert.ok(Math.abs(bl - 20) < 1e-6, `箭头长度 20，实际 ${bl}`);
  // 底边中点应朝第二顶点（50,50）方向：x/y 都减小
  assert.ok(mid[0] < tip[0] && mid[1] > tip[1], "箭头指向首顶点外侧");
  assert.equal(arrow.get("62"), "3");
});

test("v32 MULTILEADER：常见形态（直线引线 + 一段文字）", () => {
  const src = leaderDoc([
    "0", "MULTILEADER", "5", "M1", "8", "LEAD",
    "270", "2",
    "300", "CONTEXT_DATA{",
    "40", "1", "10", "500", "20", "500", "30", "0", "41", "12", "140", "5",
    "300", "LEADER{",
    "290", "1", "304", "kPolyline",
    "300", "LEADER_LINE{",
    "10", "10", "20", "20", "30", "0",
    "10", "60", "20", "20", "30", "0",
    "10", "60", "20", "60", "30", "0",
    "301", "}",
    "302", "}",
    "304", "\\P{\\fSimSun|b0;引线注记}",
    "301", "}",
  ]);
  const res = convertMultiLeaders(src, 0x100, { cbox: null });
  assert.equal(res.multileadersConverted, 1);
  assert.equal(res.multileaderTexts, 1);
  const t = normalizeEol(res.text);
  assert.equal((t.match(/^LWPOLYLINE$/gm) || []).length, 1);
  assert.equal((t.match(/^TEXT$/gm) || []).length, 1);
  assert.ok(t.includes("\n引线注记\n"), "304 文字已清洗内联码");
  assert.ok(!t.includes("MULTILEADER"));
  // 引线顶点 10/20 → 60/20 → 60/60
  assert.ok(t.includes("10\n10\n20\n20"), "首顶点保留");
});

test("v32 MULTILEADER：解析不到顶点时保留原实体并计入 leaderFallbacks", () => {
  const src = leaderDoc([
    "0", "MULTILEADER", "5", "M2", "8", "LEAD", "270", "2", "304", "只有文字没有引线",
  ]);
  const res = convertMultiLeaders(src, 0x100, { cbox: null });
  assert.equal(res.multileadersConverted, 0);
  assert.equal(res.leaderFallbacks, 1);
  assert.equal(res.text, src, "降级时不改文件");
});

test("v32 MLINE：两个元素 → 两条偏移 LWPOLYLINE（比例 40 参与）", () => {
  const src = leaderDoc([
    "0", "MLINE", "5", "ML1", "8", "LEAD",
    "40", "2", "70", "1", "71", "1", "72", "2", "73", "2",
    "10", "0", "20", "0", "30", "0", "210", "0", "220", "0", "230", "1",
    "11", "0", "21", "0", "31", "0", "12", "1", "22", "0", "32", "0", "13", "1", "23", "0", "33", "0",
    "74", "2", "41", "50", "41", "0", "75", "0",
    "74", "2", "41", "-50", "41", "0", "75", "0",
    "11", "100", "21", "0", "31", "0", "12", "1", "22", "0", "32", "0", "13", "1", "23", "0", "33", "0",
    "74", "2", "41", "50", "41", "0", "75", "0",
    "74", "2", "41", "-50", "41", "0", "75", "0",
  ]);
  const parsed = parseMLinePairs(
    collectPairsForTest(src)
  );
  assert.equal(parsed.elements, 2);
  assert.equal(parsed.scale, 2);
  assert.equal(parsed.vertices.length, 2);
  const res = convertMLines(src, 0x100, { cbox: null });
  assert.equal(res.mlinesConverted, 1);
  assert.equal(res.mlineElements, 2);
  assert.equal(res.mlineFallbacks, 0);
  const t = normalizeEol(res.text);
  const polys = t.split("\n0\nLWPOLYLINE\n5\n").length - 1;
  assert.equal(polys, 2, "两个元素 = 两条 LWPOLYLINE");
  // 偏移 50×比例 2 = 100，方向 (1,0) → y = ±100
  assert.ok(/\n10\n0\r?\n20\n100\r?\n10\n100\r?\n20\n100/.test(t), "第一条元素线 y=100");
  assert.ok(/\n10\n0\r?\n20\n-100\r?\n10\n100\r?\n20\n-100/.test(t), "第二条元素线 y=-100");
  assert.ok(!t.includes("MLINE"));
});

/** 测试辅助：从整份 DXF 文本里取出 MLINE 实体的组码对（与 dxf-web 内部同构） */
function collectPairsForTest(text) {
  const lines = normalizeEol(text).split("\n");
  const out = [];
  let inMline = false;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const c = lines[i].trim();
    const v = lines[i + 1];
    if (c === "0") {
      inMline = v.trim() === "MLINE";
      continue;
    }
    if (inMline) out.push({ c: Number(c), v });
  }
  return out;
}

test("v32 MLINE：元素参数缺失时退回中心线并计入 mlineFallbacks", () => {
  const src = leaderDoc([
    "0", "MLINE", "5", "ML2", "8", "LEAD", "40", "1", "72", "2", "73", "0",
    "11", "0", "21", "0", "31", "0",
    "11", "10", "21", "10", "31", "0",
  ]);
  const res = convertMLines(src, 0x100, { cbox: null });
  assert.equal(res.mlineFallbacks, 1);
  assert.equal(res.mlineElements, 0);
  const t = normalizeEol(res.text);
  assert.equal((t.match(/^LWPOLYLINE$/gm) || []).length, 1, "中心线仍然画出来");
});


/* ─────────────────── v34：模型 / 布局空间 ───────────────────
 * 用最小 DXF 复刻实测文件的结构（LAYOUT 组码 2 是打印机名、AcDbLayout 的 330 才是
 * BLOCK_RECORD 句柄），并放一个真正会裁剪视口的模型线。
 */
function spacesDoc() {
  return [
    "0", "SECTION", "2", "TABLES",
      "0", "TABLE", "2", "BLOCK_RECORD",
        "0", "BLOCK_RECORD", "5", "10", "2", "*Model_Space",
        "0", "BLOCK_RECORD", "5", "11", "2", "*Paper_Space",
        "0", "BLOCK_RECORD", "5", "12", "2", "*Paper_Space0",
      "0", "ENDTAB",
      "0", "TABLE", "2", "LAYER",
        "0", "LAYER", "2", "0", "70", "0", "62", "7",
        "0", "LAYER", "2", "MODEL", "70", "0", "62", "3",
        "0", "LAYER", "2", "PAPER", "70", "0", "62", "1",
      "0", "ENDTAB",
    "0", "ENDSEC",
    "0", "SECTION", "2", "BLOCKS",
      "0", "BLOCK", "5", "20", "8", "0", "330", "10", "2", "*Model_Space", "70", "0",
        "10", "0", "20", "0", "3", "*Model_Space", "1", "",
      "0", "ENDBLK", "5", "21", "8", "0",
      "0", "BLOCK", "5", "22", "8", "0", "330", "11", "67", "1", "2", "*Paper_Space", "70", "0",
        "10", "0", "20", "0", "3", "*Paper_Space", "1", "",
      "0", "ENDBLK", "5", "23", "8", "0", "67", "1",
      "0", "BLOCK", "5", "24", "8", "0", "330", "12", "67", "1", "2", "*Paper_Space0", "70", "0",
        "10", "0", "20", "0", "3", "*Paper_Space0", "1", "",
      "0", "ENDBLK", "5", "25", "8", "0", "67", "1",
      "0", "BLOCK", "5", "26", "8", "0", "2", "FRAME", "70", "0",
        "10", "0", "20", "0", "3", "FRAME", "1", "",
        "0", "LWPOLYLINE", "5", "27", "8", "PAPER", "90", "4", "70", "1",
          "10", "0", "20", "0", "10", "10", "20", "0", "10", "10", "20", "10", "10", "0", "20", "10",
      "0", "ENDBLK", "5", "28", "8", "0",
    "0", "ENDSEC",
    "0", "SECTION", "2", "ENTITIES",
      // 模型空间
      "0", "LINE", "5", "30", "8", "MODEL", "10", "0", "20", "0", "11", "10", "21", "10",
      "0", "TEXT", "5", "31", "8", "MODEL", "10", "2", "20", "2", "40", "1", "1", "MODELTEXT",
      // 跨越视口边界（-5..15，视口只覆盖 0..10）
      "0", "LINE", "5", "32", "8", "MODEL", "10", "-5", "20", "5", "11", "15", "21", "5",
      // 平面图（*Paper_Space）：图框 / 视口 / 图纸文字
      "0", "INSERT", "5", "40", "8", "PAPER", "67", "1", "330", "11", "2", "FRAME",
        "10", "0", "20", "0", "41", "1", "42", "1", "50", "0",
      "0", "VIEWPORT", "5", "41", "67", "1", "330", "11", "8", "PAPER",
        "10", "5", "20", "5", "40", "10", "41", "10", "68", "2",
        "12", "5", "22", "5", "45", "10",
      "0", "TEXT", "5", "42", "67", "1", "330", "11", "8", "PAPER",
        "10", "1", "20", "9", "40", "0.5", "1", "PAPERTEXT",
      // 第二个布局（*Paper_Space0）
      "0", "LINE", "5", "43", "67", "1", "330", "12", "8", "PAPER",
        "10", "100", "20", "100", "11", "110", "21", "110",
      "0", "TEXT", "5", "44", "67", "1", "330", "12", "8", "PAPER",
        "10", "100", "20", "110", "40", "0.5", "1", "PAPER2TEXT",
    "0", "ENDSEC",
    "0", "SECTION", "2", "OBJECTS",
      "0", "LAYOUT", "5", "50", "330", "AA", "100", "AcDbPlotSettings",
        "1", "", "2", "none_device", "4", "A4",
        "100", "AcDbLayout", "1", "Model", "70", "1", "71", "0",
        "10", "0", "20", "0", "11", "12", "21", "9", "330", "10",
      "0", "LAYOUT", "5", "51", "330", "AA", "100", "AcDbPlotSettings",
        "1", "", "2", "pdfFactory Pro.pc3", "4", "A4",
        "100", "AcDbLayout", "1", "\\U+5E73\\U+9762\\U+56FE", "70", "1", "71", "1",
        "10", "0", "20", "0", "11", "12", "21", "9", "330", "11",
      "0", "LAYOUT", "5", "52", "330", "AA", "100", "AcDbPlotSettings",
        "1", "", "2", "none_device", "4", "A4",
        "100", "AcDbLayout", "1", "ELEV", "70", "1", "71", "2",
        "10", "0", "20", "0", "11", "12", "21", "9", "330", "12",
    "0", "ENDSEC",
    "0", "EOF", "",
  ].join("\n");
}

test("v34 parseSpace：model / layout:<名>；非法串返回 null", () => {
  assert.deepEqual(parseSpace("model"), { kind: "model", spec: "model", name: "模型" });
  assert.deepEqual(parseSpace("layout:平面图"), {
    kind: "layout",
    spec: "layout:平面图",
    name: "平面图",
  });
  assert.equal(parseSpace("layout:"), null);
  assert.equal(parseSpace("paper:平面图"), null);
  assert.equal(parseSpace(""), null);
  assert.equal(parseSpace(null), null);
});

test("v34 parseLayouts/listSpaces：布局名取 AcDbLayout 的组码 1，块名由 330→BLOCK_RECORD 解析", () => {
  const src = spacesDoc();
  const layouts = parseLayouts(src);
  assert.deepEqual(
    layouts.map((l) => l.name),
    ["Model", "平面图", "ELEV"],
    "组码 2（none_device / pdfFactory Pro.pc3）不能被当成布局名"
  );
  assert.deepEqual(
    layouts.map((l) => l.blockName),
    ["*Model_Space", "*Paper_Space", "*Paper_Space0"]
  );
  assert.deepEqual(
    listSpaces(src).map((s) => s.id),
    ["model", "layout:平面图", "layout:ELEV"],
    "Model 布局不进页签"
  );
});

test("v34 filterModelSpace：删 67=1 实体并保留块结构", () => {
  const res = filterModelSpace(spacesDoc());
  const t = normalizeEol(res.text);
  assert.ok(res.removed >= 4);
  assert.ok(t.includes("\nMODELTEXT\n"), "模型文字保留");
  assert.ok(!t.includes("PAPERTEXT"), "图纸空间文字删除");
  assert.ok(!t.includes("PAPER2TEXT"));
  assert.ok(!/\nVIEWPORT\n/.test(t), "VIEWPORT 一并删除");
  assert.ok(t.includes("\nBLOCK\n"), "BLOCK 结构记录必须保留");
  assert.ok(t.includes("\n*Paper_Space0\n"), "块定义本身保留（可能是其它布局的宿主）");
});

test("v34 space=model：产物不含图纸空间实体/文字", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cadviewer-space-model-"));
  const file = path.join(dir, "s.dxf");
  fs.writeFileSync(file, spacesDoc(), "utf8");
  const out = path.join(dir, "web.dxf");
  const stats = await buildWebDxf(file, out, null, { shxText: false, space: parseSpace("model") });
  assert.equal(stats.space, "model");
  assert.equal(stats.spaceFallback, false);
  assert.ok(stats.spaceRemoved >= 4);
  const t = normalizeEol(fs.readFileSync(out, "utf8"));
  assert.ok(t.includes("MODELTEXT"), "模型文字仍在");
  assert.ok(!t.includes("PAPERTEXT"), "图纸空间文字不能注入模型场景");
  assert.ok(!t.includes("PAPER2TEXT"));
  assert.ok(!/\nVIEWPORT\n/.test(t));
});

test("v34 space=layout:平面图：只留该布局纸张实体并注入视口内容", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cadviewer-space-layout-"));
  const file = path.join(dir, "s.dxf");
  fs.writeFileSync(file, spacesDoc(), "utf8");
  const out = path.join(dir, "web.dxf");
  const stats = await buildWebDxf(file, out, null, {
    shxText: false,
    space: parseSpace("layout:平面图"),
  });
  assert.equal(stats.space, "layout:平面图");
  assert.equal(stats.viewports, 1);
  assert.ok(stats.copied >= 1, "完全落在视口内的模型几何原样拷贝");
  assert.ok(stats.copied + stats.paperTexts >= 2, "文字另行转成纸张空间 TEXT（v57）");
  assert.ok(stats.clipped >= 1, "跨视口边界的模型线被裁剪");
  const t = normalizeEol(fs.readFileSync(out, "utf8"));
  assert.ok(t.includes("PAPERTEXT"), "本布局的图纸文字保留");
  assert.ok(!t.includes("PAPER2TEXT"), "其它布局的图纸实体不能串进来");
  assert.ok(t.includes("\n*CV_VP_41\n"), "为视口生成了注入块");
  assert.ok(/\nINSERT\n[\s\S]*?\n\*CV_VP_41\n/.test(t), "图纸空间里有引用该块的 INSERT");
  assert.ok(t.includes("MODELTEXT"), "视口内的模型文字也应出现");
  // 视口 INSERT 必须带 67=1（否则会被当成模型空间内容）
  assert.ok(/\n\*CV_VP_41\n[\s\S]{0,400}\n67\n1\n/.test(t));

  /* v57：视口内的文字改成**纸张空间的顶层 TEXT**（67=1），不再塞进 `*CV_VP_*` 块 ——
   * dxf-viewer 的 Merge 有单条 INSERT 65 536 顶点上限，中文标签一多整条视口 INSERT
   * 会被丢弃（实测施工005 19 万顶点）。文字按 paper = C + k·(model − V) 变换。 */
  assert.ok(stats.paperTexts >= 1, "视口内文字应转成纸张空间 TEXT");
  const paperTextRec = t.split("\n\n").find((chunk) => chunk.includes("\nMODELTEXT\n"));
  assert.ok(paperTextRec, "模型文字记录存在");
  assert.ok(/\n67\n1\n/.test(paperTextRec), "模型文字已改成图纸空间实体（67=1）");
  assert.ok(/\n10\n2\n20\n2\n/.test(paperTextRec), "视口 1:1（k=1, C=V）时文字坐标不变");

  /* 产物必须能被真实解析器完整读出：拷贝实体时漏掉 "0 组码" 会把实体粘到上一条尾部，
   * 类型计数是最直接的回归检查（曾经踩过）。 */
  const parsed = new DxfParser().parseSync(fs.readFileSync(out, "utf8"));
  const types = {};
  for (const e of parsed.entities) types[e.type] = (types[e.type] || 0) + 1;
  assert.ok(types.INSERT >= 2, "图纸里的 FRAME INSERT + 视口注入 INSERT 都要能被解析");
  assert.ok(types.TEXT >= 1, "图纸文字 PAPERTEXT");
  const cvBlock = parsed.blocks["*CV_VP_41"];
  assert.ok(cvBlock, "视口注入块必须能被解析器读到");
  const cvTypes = {};
  for (const e of cvBlock.entities || []) cvTypes[e.type] = (cvTypes[e.type] || 0) + 1;
  assert.ok(cvTypes.LINE >= 1, "视口内原样拷贝的模型 LINE");
  assert.ok(!cvTypes.TEXT, "文字改为纸张空间 TEXT，不再进视口块（v57）");
  assert.ok(cvTypes.LWPOLYLINE >= 1, "跨边界模型线裁剪后的 LWPOLYLINE");
});

test("v34 未知布局名回落模型空间（不崩、不输出纸张内容）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cadviewer-space-fallback-"));
  const file = path.join(dir, "s.dxf");
  fs.writeFileSync(file, spacesDoc(), "utf8");
  const out = path.join(dir, "web.dxf");
  const stats = await buildWebDxf(file, out, null, {
    shxText: false,
    space: parseSpace("layout:不存在"),
  });
  assert.equal(stats.space, "model");
  assert.equal(stats.spaceFallback, true);
  const t = normalizeEol(fs.readFileSync(out, "utf8"));
  assert.ok(t.includes("MODELTEXT"));
  assert.ok(!t.includes("PAPERTEXT"));
});

/* v35：contentBox 只统计顶层锚点，图面内容全在块里时它会小得多；文字过滤不能只信它。
 * 实测 机柜图纸.dwg：下方两张图里的 3,694 条文字被当成垃圾丢弃（房间名/标注/轴号全没）。
 * 这里用合成数据复现同构场景：一半文字在 contentBox 内，一半在 contentBox 外（但成簇）。 */
test("块内文字：contentBox 之外但落在文字自身分布里的不被丢弃（v35）", () => {
  const cbox = {
    minX: 0, minY: 0, maxX: 1000, maxY: 1000, width: 1000, height: 1000,
  };
  const items = [];
  for (let i = 0; i < 50; i++) {
    items.push({
      text: "A" + i, x: 100 + i, y: 100 + i, h: 10, layer: "L",
      raw: { x: 100 + i, y: 100 + i, h: 10 },
    });
  }
  // 图纸下方另一张图：y = -5000，离 contentBox 有 4000 多远（远超外扩 100%）
  for (let i = 0; i < 50; i++) {
    items.push({
      text: "B" + i, x: 100 + i, y: -5000 - i, h: 10, layer: "L",
      raw: { x: 100 + i, y: -5000 - i, h: 10 },
    });
  }
  const stats = {};
  const kept = filterFlatTexts(items, cbox, stats);
  assert.equal(stats.dropped, 0, "两组文字都在文字自身分布里，不应丢弃");
  assert.equal(kept.length, 100);
  assert.equal(kept.filter((t) => t.text.startsWith("B")).length, 50);
});

/* v50：DXF 直开时源文件在 data/uploads/，同目录没有 meta.json；contentBox 必须由
 * 主进程（rec.stats.contentBox）经 worker 传进来，否则 filterFlatTexts 直接跳过。 */
test("DXF 直开：options.contentBox 生效，越界变换文字退回 raw 候选（v50）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cadviewer-cbox-"));
  const file = path.join(dir, "cbox.dxf");
  const out = path.join(dir, "web.dxf");
  fs.writeFileSync(
    file,
    [
      "0", "SECTION", "2", "BLOCKS",
      "0", "BLOCK", "8", "0", "2", "B", "70", "0",
      "10", "0", "20", "0", "30", "0", "3", "B", "1", "",
      "0", "TEXT", "8", "0", "10", "10", "20", "10", "30", "0",
      "40", "10", "1", "BLOCKTXT",
      "0", "ENDBLK", "8", "0",
      "0", "ENDSEC",
      "0", "SECTION", "2", "ENTITIES",
      "0", "INSERT", "5", "I1", "8", "0", "2", "B",
      "10", "2000000", "20", "2000000", "30", "0", "41", "100", "42", "100", "43", "1",
      "0", "ENDSEC", "0", "EOF", "",
    ].join("\n"),
    "utf8"
  );
  const cbox = { minX: 0, minY: 0, maxX: 1000, maxY: 1000, width: 1000, height: 1000 };
  try {
    // 不传 contentBox 且源文件旁没有 meta.json：过滤跳过（旧行为）
    const plain = await buildWebDxf(file, path.join(dir, "plain.dxf"), null, { shxText: false });
    assert.equal(plain.flatRaw, 0, "没有参照系时 filterFlatTexts 不参与（raw 恒 0）");
    // 传入 contentBox：变换后位置 (2,001,000) 明显越界 → 退回 raw (10,10)
    const stats = await buildWebDxf(file, out, null, { shxText: false, contentBox: cbox });
    assert.equal(stats.flatRaw, 1, "越界文字应退回 raw 候选");
    assert.equal(stats.blockTexts, 1, "raw 候选仍会注入，不是丢弃");
    const text = fs.readFileSync(out, "utf8");
    assert.ok(text.includes("BLOCKTXT"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("块内文字：真正飞到天外的坐标仍然丢弃（v35 不放松垃圾判定）", () => {
  const cbox = {
    minX: 0, minY: 0, maxX: 1000, maxY: 1000, width: 1000, height: 1000,
  };
  const items = [];
  for (let i = 0; i < 50; i++) {
    items.push({
      text: "A" + i, x: 100 + i, y: 100 + i, h: 10, layer: "L",
      raw: { x: 100 + i, y: 100 + i, h: 10 },
    });
  }
  items.push({
    text: "JUNK", x: 0, y: -1e9, h: 10, layer: "L",
    raw: { x: 0, y: -1e9, h: 10 },
  });
  const stats = {};
  const kept = filterFlatTexts(items, cbox, stats);
  assert.equal(stats.dropped, 1, "1e9 级别的越界坐标仍应丢弃");
  assert.equal(kept.some((t) => t.text === "JUNK"), false);
});

/* v37/v38：XCLIP（SPATIAL_FILTER）解析。实测 施工005 有 3 个过滤器，但 72=0（裁剪未启用），
 * 套用边界会把图纸裁成一条带；所以解析结果必须为空、XDATA 一个都不注。 */
function xclipDxf(enabled) {
  return [
    "0", "SECTION", "2", "OBJECTS",
      "0", "DICTIONARY", "5", "D1", "330", "I1", "3", "ACAD_FILTER", "360", "F1",
      "0", "SPATIAL_FILTER", "5", "F1", "330", "D1", "70", "2",
        "10", "100", "20", "200", "10", "300", "20", "400",
        "71", String(enabled), "72", "0", "73", "0",
    "0", "ENDSEC",
    "0", "SECTION", "2", "ENTITIES",
      "0", "INSERT", "5", "I1", "8", "L", "2", "B", "10", "0", "20", "0",
      "0", "LINE", "5", "L1", "8", "L", "10", "0", "20", "0", "11", "1", "21", "1",
    "0", "ENDSEC",
    "0", "EOF",
  ].join("\r\n");
}

test("XCLIP：71=1 时把 70=2 展开成 4 角并注入 POLY 多边形", () => {
  const s = xclipDxf(1);
  const filters = extractSpatialFilters(s);
  assert.equal(filters.size, 1);
  assert.deepEqual(filters.get("I1"), {
    points: [[100, 200], [300, 200], [300, 400], [100, 400]],
    minX: 100, minY: 200, maxX: 300, maxY: 400,
  });
  const injected = injectSpatialFilterXdata(s, filters);
  assert.equal(injected.injected, 1);
  assert.match(injected.text, /CADVIEWER_XCLIP/);
  assert.match(injected.text, /1000\r?\nPOLY/);
  assert.match(injected.text, /1010\r?\n100/);
});

/* M2≠I：p_block = M1 · M2⁻¹ · p_boundary。M1=translate(10,20)，
 * M2=绕原点逆时针 90°，所以对角点 (0,0)/(100,50) 先转 -90° 再平移。 */
function xclipMatrixDxf() {
  const m1 = [1, 0, 0, 10, 0, 1, 0, 20, 0, 0, 1, 0];
  const m2 = [0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];
  const m = [...m1, ...m2].flatMap((v) => ["40", String(v)]);
  return [
    "0", "SECTION", "2", "OBJECTS",
      "0", "DICTIONARY", "5", "D1", "330", "I1", "3", "ACAD_FILTER", "360", "F1",
      "0", "SPATIAL_FILTER", "5", "F1", "330", "D1", "70", "2",
        "10", "0", "20", "0", "10", "100", "20", "50",
        "71", "1", "72", "0", "73", "0",
        ...m,
    "0", "ENDSEC",
    "0", "SECTION", "2", "ENTITIES",
      "0", "INSERT", "5", "I1", "8", "L", "2", "B", "10", "0", "20", "0",
    "0", "ENDSEC",
    "0", "EOF",
  ].join("\r\n");
}

test("XCLIP：M2≠I 时按 M1·M2⁻¹ 变换边界（不是直接 bbox）", () => {
  const filters = extractSpatialFilters(xclipMatrixDxf());
  assert.equal(filters.size, 1);
  assert.deepEqual(filters.get("I1").points, [
    [10, 20],
    [10, -80],
    [60, -80],
    [60, 20],
  ]);
});

test("XCLIP：71=0（XCLIP off）时不得注入，块整块显示", () => {
  const s = xclipDxf(0);
  const filters = extractSpatialFilters(s);
  assert.equal(filters.size, 0);
  const injected = injectSpatialFilterXdata(s, filters);
  assert.equal(injected.injected, 0);
  assert.equal(injected.text.includes("CADVIEWER_XCLIP"), false);
});

test("嵌套裁剪栈：多个裁剪多边形按顺序求交（凹边界会切成多段）", () => {
  const outer = [[0, 0], [100, 0], [100, 100], [0, 100]];
  const inner = [[40, 0], [60, 0], [60, 100], [40, 100]];
  const pieces = ClipSegmentToPolygons(-10, 50, 110, 50, [outer, inner]);
  assert.deepEqual(pieces, [[40, 50, 60, 50]]);

  /* U 形边界：y=70 处只应保留 x∈[0,40] 与 x∈[60,100]。 */
  const concave = [
    [0, 0], [100, 0], [100, 100], [60, 100],
    [60, 40], [40, 40], [40, 100], [0, 100],
  ];
  const split = ClipSegmentToPolygons(-10, 70, 110, 70, [concave]);
  assert.deepEqual(split, [[0, 70, 40, 70], [60, 70, 100, 70]]);

  const triangles = ClipTriangleByPolygons(
    [[-10, 40], [110, 40], [50, 120]],
    [outer, inner]
  );
  const minX = Math.min(...triangles.flat().map((p) => p[0]));
  const maxX = Math.max(...triangles.flat().map((p) => p[0]));
  assert.ok(triangles.length > 0, "三角形应保留视口内部分");
  assert.ok(minX >= 40 - 1e-6 && maxX <= 60 + 1e-6, "三角形必须落在两层裁剪的交集内");
});

test("展平文字：带 XCLIP 的 INSERT 的块内文字/ATTRIB 副本按块坐标多边形过滤", () => {
  const filters = new Map([
    ["I1", { points: [[0, 0], [50, 0], [50, 50], [0, 50]] }],
  ]);
  const m = { a: 1, b: 0, c: 0, d: 1, e: 100, f: 0 }; // block → WCS +100
  const items = [
    { text: "in-block", x: 110, y: 10, ax: null, ay: null, owner: "I1", ownerMatrix: m, attrib: false },
    { text: "outside", x: 10, y: 10, ax: null, ay: null, owner: "I1", ownerMatrix: m, attrib: false },
    /* ATTRIB 注入副本跟随所属块一起裁；原始 ATTRIB 实体不在这里。 */
    { text: "attrib-out", x: 10, y: 10, ax: null, ay: null, owner: "I1", ownerMatrix: m, attrib: true },
    /* 其它没有 SPATIAL_FILTER 的 INSERT：文字/ATTRIB 都不能受影响。 */
    { text: "other-text", x: 10, y: 10, ax: null, ay: null, owner: "I2", ownerMatrix: m, attrib: false },
    { text: "other-attrib", x: 10, y: 10, ax: null, ay: null, owner: "I2", ownerMatrix: m, attrib: true },
  ];
  const res = clipFlattenedTexts(items, filters);
  assert.equal(res.removed, 2);
  assert.deepEqual(res.items.map((t) => t.text), ["in-block", "other-text", "other-attrib"]);

  /* 嵌套 XCLIP：外层在内、内层在外 → 仍应被裁（交集）。 */
  const nestedFilters = new Map([
    ["I1", { points: [[0, 0], [50, 0], [50, 50], [0, 50]] }],
    ["I3", { points: [[0, 0], [20, 0], [20, 20], [0, 20]] }],
  ]);
  const nested = [
    {
      text: "nested", x: 30, y: 10, ax: null, ay: null, attrib: false,
      owner: "I1", ownerMatrix: m,
      owners: [{ handle: "I1", matrix: m }, { handle: "I3", matrix: m }],
    },
  ];
  assert.equal(clipFlattenedTexts(nested, nestedFilters).removed, 1);
});

/* v39：SHX 字体缺一个字，就整条不转笔画、保留原文字（交给 TTF 画全）。
 * 施工005 实测 590 个字 / 165 条文字因此得救。 */
test("缺字形：有任何一个字缺字形就不允许用笔画替换（v39）", () => {
  assert.equal(shxTextIsComplete({ polylines: [[1]], missing: 0 }), true);
  assert.equal(shxTextIsComplete({ polylines: [[1]], missing: 2 }), false);
  assert.equal(shxTextIsComplete({ polylines: [], missing: 0 }), false);
  assert.equal(shxTextIsComplete(null), false);
});

/* ─────────────────── v61：图外散点过滤 ─────────────────── */

/** 最小 DXF：图内实体、图框、远处散点、远图纸空间、块定义各一份 */
function strayDoc() {
  return [
    "0", "SECTION", "2", "TABLES",
      "0", "TABLE", "2", "LAYER",
        "0", "LAYER", "2", "0", "70", "0", "62", "7",
        "0", "LAYER", "2", "NOISE", "70", "0", "62", "1",
        "0", "LAYER", "2", "FRAME", "70", "0", "62", "3",
        "0", "LAYER", "2", "PAPER", "70", "0", "62", "2",
      "0", "ENDTAB",
    "0", "ENDSEC",
    "0", "SECTION", "2", "BLOCKS",
      "0", "BLOCK", "5", "B1", "8", "0", "2", "FARBLK", "70", "0",
        "10", "0", "20", "0", "3", "FARBLK", "1", "",
        "0", "LINE", "5", "B2", "8", "0", "10", "20000", "20", "20000", "11", "20010", "21", "20010",
      "0", "ENDBLK", "5", "B3", "8", "0",
    "0", "ENDSEC",
    "0", "SECTION", "2", "ENTITIES",
      // 图内：必须保留
      "0", "LINE", "5", "K1", "8", "0", "10", "10", "20", "10", "11", "90", "21", "90",
      // 图框/标题栏：在 contentBox 外但只有 6 倍宽，必须保留
      "0", "LINE", "5", "K2", "8", "FRAME", "10", "600", "20", "600", "11", "700", "21", "700",
      // 图内 HATCH（第一对 10/20 是 elevation 0,0，不能把边界判成跨图）
      "0", "HATCH", "5", "K3", "8", "0", "10", "0", "20", "0", "30", "0",
        "2", "SOLID", "70", "1", "91", "1", "92", "3", "72", "0", "73", "1", "93", "2",
        "10", "20", "20", "20", "10", "40", "20", "40",
      // 三份真正的散点：远处线段 / 远处块实例 / 坐标损坏的 HATCH
      "0", "LINE", "5", "S1", "8", "NOISE", "10", "20000", "20", "20000", "11", "20010", "21", "20010",
      "0", "INSERT", "5", "S2", "8", "NOISE", "2", "FARBLK", "10", "20000", "20", "20000", "41", "1", "42", "1", "50", "0",
      "0", "HATCH", "5", "S3", "8", "NOISE", "10", "0", "20", "0", "30", "0",
        "2", "SOLID", "70", "1", "91", "1", "92", "3", "72", "0", "73", "1", "93", "2",
        "10", "30000", "20", "30000", "10", "30010", "20", "30010",
      // 图纸空间再远也不参与模型 contentBox 过滤（图框/标题栏在这里）
      "0", "TEXT", "5", "P1", "67", "1", "8", "PAPER", "10", "50000", "20", "50000", "40", "5", "1", "PAGEFAR",
      "0", "INSERT", "5", "P2", "67", "1", "8", "PAPER", "2", "FARBLK", "10", "40000", "20", "40000", "41", "1", "42", "1", "50", "0",
    "0", "ENDSEC",
    "0", "EOF", "",
  ].join("\n");
}

const STRAY_CBOX = { minX: 0, minY: 0, maxX: 100, maxY: 100, width: 100, height: 100 };

test("v61 阈值盒：默认 10× 对角线；contentBox 无效时返回 null", () => {
  assert.equal(STRAY_FILTER_FACTOR, 10);
  assert.equal(STRAY_ABS_LIMIT, 1e9);
  const box = strayLimitBox(STRAY_CBOX);
  const pad = 10 * Math.hypot(100, 100);
  assert.ok(Math.abs(box.pad - pad) < 1e-9);
  assert.ok(Math.abs(box.minX - (0 - pad)) < 1e-9);
  assert.equal(strayLimitBox(null), null);
  assert.equal(strayLimitBox({ width: 0, height: 0 }), null);
});

test("v61 开关：默认开；options / 环境变量都能明确关闭", () => {
  assert.equal(resolveStrayFilter({}, {}), true);
  assert.equal(resolveStrayFilter({}, { CADVIEWER_STRAY_FILTER: "0" }), false);
  assert.equal(resolveStrayFilter({}, { CADVIEWER_STRAY_FILTER: "off" }), false);
  assert.equal(resolveStrayFilter({}, { CADVIEWER_STRAY_FILTER: "1" }), true);
  assert.equal(resolveStrayFilter({ strayFilter: false }, {}), false);
  assert.equal(resolveStrayFilter({ strayFilter: true }, { CADVIEWER_STRAY_FILTER: "0" }), true);
});

test("v61 filterStrayEntities：只删整盒在图外的实体；图内/图框/图纸空间/块定义全保留", () => {
  const res = filterStrayEntities(strayDoc(), STRAY_CBOX);
  assert.equal(res.removed, 3, "远处 LINE / 远处 INSERT / 损坏 HATCH");
  assert.deepEqual(res.byKind, { "NOISE|LINE": 1, "NOISE|INSERT": 1, "NOISE|HATCH": 1 });
  assert.equal(res.samples.length, 3);
  const out = res.text;
  for (const h of ["K1", "K2", "K3", "P1", "P2", "B1", "B2"]) {
    assert.ok(out.includes(`\n${h}\n`), `句柄 ${h} 必须保留`);
  }
  for (const h of ["S1", "S2", "S3"]) {
    assert.ok(!out.includes(`\n${h}\n`), `句柄 ${h} 必须删除`);
  }
  assert.ok(out.includes("\nFARBLK\n"), "块定义本身不删");
  assert.ok(out.includes("\nPAGEFAR\n"), "图纸空间文字不参与模型 contentBox 过滤");
});

test("v61 3× 阈值会误删图框，10× 不会（阈值依据）", () => {
  /* K2 距 contentBox 500 > 3×pad(≈424)，会被 3× 删；10× pad≈1414 保留。
   * 断言真实行为，防止阈值被悄悄收回 3×。 */
  assert.ok(!filterStrayEntities(strayDoc(), STRAY_CBOX, { factor: 3 }).text.includes("\nK2\n"));
  const wide = filterStrayEntities(strayDoc(), STRAY_CBOX);
  assert.ok(wide.text.includes("\nK2\n"));
});

test("v61 countEntitiesInBox：过滤前后 contentBox 内实体数必须完全不变", () => {
  const doc = strayDoc();
  const before = countEntitiesInBox(doc, STRAY_CBOX);
  const after = countEntitiesInBox(filterStrayEntities(doc, STRAY_CBOX).text, STRAY_CBOX);
  assert.equal(before.inside, after.inside);
  assert.equal(before.inside, 2, "K1 + K3");
  assert.equal(before.unknown, 0);
  assert.equal(after.total, before.total - 3);
});
test("v61 关闭过滤：buildWebDxf 不删任何实体，开启时删 3 条", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cadviewer-stray-"));
  const file = path.join(dir, "stray.dxf");
  fs.writeFileSync(file, strayDoc(), "utf8");
  const onOut = path.join(dir, "on.dxf");
  const offOut = path.join(dir, "off.dxf");
  const on = await buildWebDxf(file, onOut, null, {
    shxText: false,
    space: parseSpace("model"),
    contentBox: STRAY_CBOX,
    strayFilter: true,
  });
  const off = await buildWebDxf(file, offOut, null, {
    shxText: false,
    space: parseSpace("model"),
    contentBox: STRAY_CBOX,
    strayFilter: false,
  });
  assert.equal(on.strayFilter, true);
  assert.equal(on.strayRemoved, 3);
  assert.equal(off.strayFilter, false);
  assert.equal(off.strayRemoved, 0);
  const offText = fs.readFileSync(offOut, "utf8");
  for (const h of ["S1", "S2", "S3"]) assert.ok(offText.includes(`\n${h}\n`), `关闭时 ${h} 必须还在`);
  assert.ok(!fs.readFileSync(onOut, "utf8").includes("\nS1\n"));
  assert.notEqual(
    crypto.createHash("sha256").update(fs.readFileSync(onOut)).digest("hex"),
    crypto.createHash("sha256").update(fs.readFileSync(offOut)).digest("hex")
  );
});

test("v61 space=layout：模型散点同样过滤，纸张图框/标题栏保留", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cadviewer-stray-layout-"));
  const file = path.join(dir, "stray-layout.dxf");
  /* 在 spacesDoc 的 ENTITIES 末尾加：一条模型散点 + 一条远处图纸空间文字 */
  const doc = spacesDoc().replace(
    "\n0\nENDSEC\n0\nSECTION\n2\nOBJECTS",
    [
      "",
      "0", "LINE", "5", "S1", "8", "MODEL", "10", "5000", "20", "5000", "11", "5010", "21", "5010",
      "0", "TEXT", "5", "P1", "67", "1", "8", "PAPER", "10", "5000", "20", "5000", "40", "5", "1", "STRAYPAPER",
      "0", "ENDSEC", "0", "SECTION", "2", "OBJECTS",
    ].join("\n")
  );
  fs.writeFileSync(file, doc, "utf8");
  const out = path.join(dir, "web.dxf");
  const stats = await buildWebDxf(file, out, null, {
    shxText: false,
    space: parseSpace("layout:平面图"),
    contentBox: { minX: 0, minY: 0, maxX: 12, maxY: 12, width: 12, height: 12 },
  });
  assert.equal(stats.space, "layout:平面图");
  assert.equal(stats.strayFilter, true);
  assert.equal(stats.strayRemoved, 1, "只删模型空间那条散点");
  const t = fs.readFileSync(out, "utf8");
  assert.ok(t.includes("STRAYPAPER"), "远处图纸空间文字必须保留");
  assert.ok(!/\nS1\n/.test(t), "模型散点删除后，布局视口块里也不应出现");
});

/* ───────────────── 导出专用 DXF（v66）─────────────────
 * 背景：cadcraft 的 converted.dxf 里天正自定义对象被静默丢弃（智能化图纸 DOOR_FIRE /
 * WINDOW / LATRINE 三层实体数 0）。导出（?raw=1 与 PDF）必须补注入，否则缺门窗墙。
 * 同时导出端不能做 WebGL 专用重处理（块文字展开 / ATTRIB 删除 / SHX 单线化）。
 */

function exportFixture() {
  return [
    "0", "SECTION", "2", "TABLES",
    "0", "TABLE", "2", "LAYER",
    "0", "LAYER", "2", "0", "70", "0", "62", "7",
    "0", "LAYER", "2", "A-DOOR", "70", "0", "62", "4",
    "0", "LAYER", "2", "WINDOW", "70", "0", "62", "3",
    "0", "LAYER", "2", "WALL", "70", "0", "62", "7",
    "0", "LAYER", "2", "PUB_TEXT", "70", "0", "62", "2",
    "0", "ENDTAB", "0", "ENDSEC",
    "0", "SECTION", "2", "ENTITIES",
    // 顶层实体 + 一条转义中文（导出必须先解码，否则自定义对象注入的中文与原文混编码）
    "0", "LINE", "5", "E1", "8", "0", "10", "0", "20", "0", "11", "10", "21", "0",
    "0", "TEXT", "5", "E2", "8", "0", "10", "0", "20", "5", "40", "2.5", "1", "\\U+8F66\\U+5E93",
    "0", "ENDSEC",
    "0", "SECTION", "2", "BLOCKS",
    "0", "BLOCK", "5", "B0", "8", "0", "2", "B1", "70", "0",
    "10", "0", "20", "0", "30", "0", "3", "B1", "1", "",
    // 块内文字：cadcraft 自己会画，导出**不能**展开/删除（实测删了 SVG 掉 30MB）
    "0", "TEXT", "5", "B2", "8", "0", "10", "0", "20", "0", "40", "2", "1", "BLOCKTEXT",
    "0", "ENDBLK", "5", "B3", "8", "0",
    "0", "ENDSEC",
    "0", "EOF", "",
  ].join("\n");
}

/** 一个门洞（A-DOOR，1100×2100，贴地）+ 一个窗洞（WINDOW，z=900）+ 一条天正文字 */
function exportTchDump() {
  const opening = (over) => ({
    handle: "4A001",
    class: "TCH_OPENING",
    layer: "A-DOOR",
    raw_len: 260,
    decode: {
      class: "TCH_OPENING",
      kind: "opening",
      status: "decoded",
      opening: {
        x: 500, y: 100, z: 0, width: 1100, half_thickness: 100, height: 2100,
        rotation: 0, direction: [1, 0], normal: [0, 1],
        ...over,
      },
    },
  });
  const wall = {
    handle: "4A002",
    class: "TCH_WALL",
    layer: "WALL",
    raw_len: 260,
    decode: {
      class: "TCH_WALL",
      kind: "wall",
      status: "decoded",
      wall: {
        start: [0, 100, 0], end: [4000, 100, 0], length: 4000,
        left_offset: 100, right_offset: 100, thickness: 200, height: 3000,
      },
    },
  };
  const text = {
    handle: "4A003",
    class: "TCH_TEXT",
    layer: "PUB_TEXT",
    raw_len: 136,
    decode: {
      class: "TCH_TEXT",
      kind: "text",
      status: "decoded",
      text: { position: [300, 300, 0], content: "房间名", charset: "gbk" },
    },
  };
  const win = opening({
    x: 1600, y: 100, z: 900, width: 1500, height: 1500, normal: [0, 1],
  });
  win.layer = "WINDOW";
  return {
    file: "fixture.dwg",
    dwg_version: "AC1018",
    entity_count: 3,
    stats: { udo_entities: 3 },
    entities: [opening({}), win, wall, text],
  };
}

function writeExportFixture(dir) {
  const file = path.join(dir, "converted.dxf");
  fs.writeFileSync(file, exportFixture(), "utf8");
  const dump = path.join(dir, "udo-dump.json");
  fs.writeFileSync(dump, JSON.stringify({ schema_version: 1, data: exportTchDump() }), "utf8");
  return { file, dump };
}

const sha256Of = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

test("v66 导出源包含天正注入；保留块文字/原生文字；窗洞不出开启弧", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cadviewer-export-dxf-"));
  const { file, dump } = writeExportFixture(dir);
  const out = path.join(dir, "export-v66.dxf");
  const stats = await buildExportDxf(file, out, { udoDumpPath: dump });
  assert.equal(stats.udoInjected, 4, "门 + 窗 + 墙 + 文字各 1 条");
  assert.ok(stats.udoPrimitives >= 6);
  assert.equal(stats.escaped, 2, "两条 \\U+XXXX 转义被解码");
  const t = fs.readFileSync(out, "utf8");
  assert.ok(!t.includes("\\U+"), "导出产物里不能再留 \\U+ 转义");
  assert.ok(t.includes("车库"), "转义中文已解码");
  assert.ok(t.includes("房间名"), "天正文字已注入");
  assert.ok(t.includes("BLOCKTEXT"), "块内文字必须保留（cadcraft 自己画，不能展开）");

  const ents = parseEnts(t);
  const doorPolys = ents.filter((e) => e.type === "LWPOLYLINE" && e.get("8") === "A-DOOR");
  assert.ok(doorPolys.length >= 2, "门洞四角 + 门扇");
  const doorArc = doorPolys.find((e) => e.all("10").length === 10);
  assert.ok(doorArc, "单扇门应有 10 点开启弧");
  const windowPolys = ents.filter((e) => e.type === "LWPOLYLINE" && e.get("8") === "WINDOW");
  assert.ok(windowPolys.length >= 1, "窗洞断面要注入");
  assert.ok(
    windowPolys.every((e) => e.all("10").length !== 10),
    "窗洞不得画门扇开启弧"
  );
  assert.equal(
    ents.filter((e) => e.type === "LINE" && e.get("5") === "E1").length,
    1,
    "原有实体不被重复注入"
  );
  // 产物必须是解析器能完整读出的 DXF（注入点/组码不能错位）
  const parsed = new DxfParser().parseSync(t);
  assert.ok(parsed.entities.length >= 5);
});

test("v66 导出构建失败时回退 fallback（converted.dxf），绝不抛错", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cadviewer-export-fallback-"));
  const fallback = path.join(dir, "converted.dxf");
  fs.writeFileSync(fallback, exportFixture(), "utf8");
  const out = path.join(dir, "export-v66.dxf");
  // 源文件不存在 → 读取/注入阶段直接失败
  const r1 = await buildExportDxfSafe({
    srcPath: path.join(dir, "missing.dxf"),
    outPath: out,
    fallbackPath: fallback,
  });
  assert.equal(r1.built, false);
  assert.equal(r1.path, fallback, "必须回退到原始的 converted.dxf");
  assert.ok(r1.error && r1.error.length > 0);
  assert.equal(fs.existsSync(out), false, "失败时不能留下半成品缓存");

  // 输出目录不存在 → 写盘阶段失败（注入已经跑过）
  const r2 = await buildExportDxfSafe({
    srcPath: fallback,
    outPath: path.join(dir, "nope", "export-v66.dxf"),
    fallbackPath: fallback,
  });
  assert.equal(r2.built, false);
  assert.equal(r2.path, fallback);
});

test("v66 导出链路不影响屏幕产物：buildWebDxf 前后逐字节相同", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cadviewer-export-screen-"));
  const { file, dump } = writeExportFixture(dir);
  const webA = path.join(dir, "web-a.dxf");
  const webB = path.join(dir, "web-b.dxf");
  const exp = path.join(dir, "export.dxf");
  await buildWebDxf(file, webA, null, { shxText: false, udoDumpPath: dump });
  const exportStats = await buildExportDxf(file, exp, { udoDumpPath: dump });
  await buildWebDxf(file, webB, null, { shxText: false, udoDumpPath: dump });
  assert.ok(exportStats.udoInjected >= 4);
  assert.equal(sha256Of(webA), sha256Of(webB), "导出构建不得改变屏幕链路的产物字节");
  assert.notEqual(sha256Of(webA), sha256Of(exp), "导出产物与 web 产物本来就是两份");
});

test("DXF_WEB_VERSION 已升到 68（字段改名 tch→udo，缓存按它失效）", () => {
  assert.equal(DXF_WEB_VERSION, 68);
});

/* ───────────────── 导出 XCLIP 几何裁剪（v67）─────────────────
 * 背景：屏幕链路把 SPATIAL_FILTER 转成 CADVIEWER_XCLIP XDATA 交给引擎裁剪；
 * 导出下游是 cadcraft（PDF）和第三方 CAD，都不读这条 XDATA，必须在几何层真删。
 * 实测 施工005：被裁块 7356 条实体里 4854 条完全在裁剪范围外，PDF 把它们全画出来了。
 */

/** 一个被 XCLIP 的块：块 B1 有内/外/跨界三种实体，顶层 INSERT 指向它。 */
function xclipFixture({ twoRefs = false } = {}) {
  const rows = [
    "0", "SECTION", "2", "TABLES",
    "0", "TABLE", "2", "LAYER",
    "0", "LAYER", "2", "0", "70", "0", "62", "7",
    "0", "LAYER", "2", "A-WALL", "70", "0", "62", "7",
    "0", "ENDTAB", "0", "ENDSEC",
    "0", "SECTION", "2", "ENTITIES",
    // INSERT H1 → 块 B1
    "0", "INSERT", "5", "H1", "8", "建筑", "2", "B1",
    "10", "0", "20", "0", "30", "0", "41", "1", "42", "1", "50", "0",
  ];
  if (twoRefs) {
    rows.push(
      "0", "INSERT", "5", "H2", "8", "建筑", "2", "B1",
      "10", "500", "20", "0", "30", "0", "41", "1", "42", "1", "50", "0"
    );
  }
  rows.push(
    "0", "ENDSEC",
    "0", "SECTION", "2", "BLOCKS",
    "0", "BLOCK", "5", "B0", "8", "0", "2", "B1", "70", "0",
    "10", "0", "20", "0", "30", "0", "3", "B1", "1", "",
    // 完全在裁剪框内
    "0", "LINE", "5", "L1", "8", "A-WALL", "10", "10", "20", "10", "11", "40", "21", "10",
    // 完全在外（模拟实测里 4854 条越界实体）
    "0", "LINE", "5", "L2", "8", "A-WALL", "10", "900", "20", "900", "11", "950", "21", "950",
    // 跨界：从 -20 到 20（裁剪框 x≥0），应被裁成 0..20
    "0", "LINE", "5", "L3", "8", "A-WALL", "10", "-20", "20", "50", "11", "20", "21", "50",
    // 在外的文字
    "0", "TEXT", "5", "T1", "8", "A-WALL", "10", "800", "20", "800", "40", "5", "1", "OUT",
    // 在内的闭合折线
    "0", "LWPOLYLINE", "5", "P1", "8", "A-WALL", "90", "4", "70", "1",
    "10", "10", "20", "20", "10", "30", "20", "20", "10", "30", "20", "30",
    "10", "10", "20", "30",
    "0", "ENDBLK", "5", "B3", "8", "0",
    "0", "ENDSEC",
    "0", "SECTION", "2", "OBJECTS",
    // INSERT H1 的扩展字典 → ACAD_FILTER 字典 → SPATIAL_FILTER
    "0", "DICTIONARY", "5", "D1", "330", "H1", "3", "ACAD_FILTER", "360", "F1",
    "0", "DICTIONARY", "5", "F1", "330", "D1", "3", "ACAD_FILTER", "360", "F2",
    "0", "SPATIAL_FILTER", "5", "F2", "70", "2", "10", "0", "20", "0", "10", "100", "20", "100",
    "71", "1",
  );
  // M1 / M2 各 12 个数（单位矩阵 → 裁剪多边形就是上面的矩形）
  for (let i = 0; i < 2; i++) {
    rows.push(
      "40", "1", "40", "0", "40", "0", "40", "0",
      "40", "0", "40", "1", "40", "0", "40", "0",
      "40", "0", "40", "0", "40", "1", "40", "0"
    );
  }
  rows.push("0", "ENDSEC", "0", "EOF", "");
  return rows.join("\n");
}

/** 取某个块定义里的实体（0/<TYPE> 分条，只读 BLOCKS 段）。 */
function parseBlockEnts(text, blockName) {
  const lines = normalizeEol(text).split("\n");
  const out = [];
  let inBlocks = false;
  let pendingSection = false;
  let curBlock = null;
  let cur = null;
  const flush = () => {
    if (cur && curBlock === blockName) out.push(cur);
    cur = null;
  };
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const c = lines[i].trim();
    const v = lines[i + 1].trim();
    if (c === "2" && pendingSection) {
      inBlocks = v.toUpperCase() === "BLOCKS";
      pendingSection = false;
      continue;
    }
    if (c !== "0") {
      if (inBlocks && cur) {
        cur.pairs.push([c, v]);
        if (cur.type === "BLOCK" && c === "2") curBlock = v;
      }
      continue;
    }
    flush();
    if (v === "SECTION") {
      pendingSection = true;
      continue;
    }
    if (v === "ENDSEC") {
      inBlocks = false;
      curBlock = null;
      continue;
    }
    if (!inBlocks) continue;
    if (v === "BLOCK") {
      curBlock = null;
      cur = { type: "BLOCK", pairs: [] };
      continue;
    }
    if (v === "ENDBLK") {
      cur = null;
      curBlock = null;
      continue;
    }
    cur = { type: v, pairs: [] };
  }
  flush();
  return out;
}

const getNum = (e, code) =>
  Number(e.pairs.find(([c]) => c === String(code))?.[1]);

test("v67 XCLIP：被裁块里越界实体被真删，跨界线段被裁短，块内其余实体保留", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cadviewer-xclip-"));
  const src = path.join(dir, "converted.dxf");
  fs.writeFileSync(src, xclipFixture(), "utf8");
  const out = path.join(dir, "export-v67.dxf");
  const stats = await buildExportDxf(src, out, {});

  assert.equal(stats.clipFilters, 1, "识别到 1 个 SPATIAL_FILTER");
  assert.equal(stats.clippedBlocks, 1);
  assert.equal(stats.droppedEntities, 2, "越界 LINE + 越界 TEXT");
  assert.ok(stats.clippedEntities >= 1, "跨界 LINE 被裁剪");

  const t = fs.readFileSync(out, "utf8");
  const ents = parseBlockEnts(t, "B1");
  const handles = ents.map((e) => e.pairs.find(([c]) => c === "5")?.[1]);
  assert.ok(!handles.includes("L2"), "完全在外的 LINE 必须删除");
  assert.ok(!handles.includes("T1"), "完全在外的 TEXT 必须删除");
  assert.ok(handles.includes("P1"), "完全在内的 LWPOLYLINE 必须保留");
  assert.ok(handles.includes("L1"), "完全在内的 LINE 必须保留");

  const l3 = ents.find((e) => e.pairs.find(([c]) => c === "5")?.[1] === "L3");
  assert.ok(l3, "跨界线段要被保留（裁剪后的部分）");
  assert.equal(l3.type, "LINE");
  const x0 = getNum(l3, 10);
  assert.ok(x0 >= -1e-6 && x0 <= 1e-6, `跨界线段左端应被裁到裁剪框边界 0，实际 ${x0}`);
  assert.ok(Math.abs(getNum(l3, 11) - 20) < 1e-6, "右端保持 20");

  // 产物必须仍是解析器能读的合法 DXF
  const parsed = new DxfParser().parseSync(t);
  assert.ok(parsed.entities.length >= 1);
});

test("v67 XCLIP：块被多处引用时保守跳过（不原地改写共享块定义）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cadviewer-xclip-multi-"));
  const src = path.join(dir, "converted.dxf");
  const fixture = xclipFixture({ twoRefs: true });
  fs.writeFileSync(src, fixture, "utf8");
  const out = path.join(dir, "export-v67.dxf");
  const stats = await buildExportDxf(src, out, {});
  assert.equal(stats.clipFilters, 1);
  assert.equal(stats.skippedMultiRef, 1, "共享块不得原地裁剪");
  assert.equal(stats.droppedEntities, 0);
  const t = fs.readFileSync(out, "utf8");
  const ents = parseBlockEnts(t, "B1");
  assert.ok(ents.some((e) => e.pairs.find(([c]) => c === "5")?.[1] === "L2"), "共享块内容原样保留");
});

test("v67 无 SPATIAL_FILTER 的图：导出内容与 XCLIP 改造前逐字节一致（不误伤）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cadviewer-xclip-none-"));
  const { file, dump } = writeExportFixture(dir);
  const a = path.join(dir, "export-a.dxf");
  const b = path.join(dir, "export-b.dxf");
  const s1 = await buildExportDxf(file, a, { udoDumpPath: dump });
  const s2 = await buildExportDxf(file, b, { udoDumpPath: dump, exportXclip: false });
  assert.equal(s1.clipFilters, 0, "这张图没有 XCLIP");
  assert.equal(s1.droppedEntities, 0);
  assert.equal(sha256Of(a), sha256Of(b), "裁剪开关对无过滤器图纸必须没有影响");
  assert.equal(s1.bytes, s2.bytes);
});

test("v67 导出几何量不低于屏幕产物（同层同类几何条数逐项 ≥ 屏幕）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cadviewer-parity-"));
  const { file, dump } = writeExportFixture(dir);
  const web = path.join(dir, "web.dxf");
  const exp = path.join(dir, "export.dxf");
  await buildWebDxf(file, web, null, { shxText: false, udoDumpPath: dump });
  await buildExportDxf(file, exp, { udoDumpPath: dump });

  const geo = ["LINE", "LWPOLYLINE", "CIRCLE", "ARC", "SOLID"];
  const tally = (text) => {
    const out = new Map();
    const all = [...parseEnts(text), ...parseBlockEnts(text, "B1")];
    for (const e of all) {
      if (!geo.includes(e.type)) continue;
      const key = `${e.get ? e.get("8") : e.pairs.find(([c]) => c === "8")?.[1]}|${e.type}`;
      out.set(key, (out.get(key) || 0) + 1);
    }
    return out;
  };
  const webTally = tally(fs.readFileSync(web, "utf8"));
  const expTally = tally(fs.readFileSync(exp, "utf8"));
  for (const [key, n] of webTally) {
    assert.ok(
      (expTally.get(key) || 0) >= n,
      `导出缺几何：${key} 屏幕=${n} 导出=${expTally.get(key) || 0}`
    );
  }
});


