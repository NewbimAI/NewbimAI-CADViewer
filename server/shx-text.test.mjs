/**
 * shx-text.js 的单测：全部用注入的假字体（ctx.resolveShape），不需要真实 .shx 文件。
 *
 * 运行：node --test server/shx-text.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  isShxName,
  inferShxEncoding,
  createShxContext,
  measureTextWidth,
  renderShxText,
  mtextToPlainText,
  mtextAttachToAlign,
  SHX_LIMITS,
} from "./shx-text.js";

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));

/** 单位正方形字形：1×1，字宽 1（后续按 item.h 缩放） */
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

function ctxFor(styleTable, resolveShape) {
  return createShxContext({ root: process.cwd(), styleTable, resolveShape });
}

function item(over = {}) {
  return {
    text: "A",
    x: 0,
    y: 0,
    h: 10,
    rot: 0,
    wf: 1,
    halign: 0,
    valign: 0,
    layer: "TEXT",
    aci: 3,
    style: "F",
    ...over,
  };
}

const xs = (r) => r.polylines.flatMap((p) => p.points.map((q) => q[0]));
const ys = (r) => r.polylines.flatMap((p) => p.points.map((q) => q[1]));

/* ───────────────────────── 基础识别 ───────────────────────── */

test("isShxName：只认 .shx 结尾（大小写/路径不敏感）", () => {
  assert.equal(isShxName("hztxt.shx"), true);
  assert.equal(isShxName("C:\\Fonts\\GBCBIG.SHX"), true);
  assert.equal(isShxName("simsun.ttf"), false);
  assert.equal(isShxName("shx.txt"), false);
  assert.equal(isShxName(""), false);
  assert.equal(isShxName(null), false);
});

test("inferShxEncoding：大字体名 → 传统码页；推断不出用 codepage，最后 gbk", () => {
  assert.equal(inferShxEncoding("gbcbig.shx"), "gbk");
  assert.equal(inferShxEncoding("hztxt.shx"), "gbk");
  assert.equal(inferShxEncoding("tssdchn.shx"), "gbk");
  assert.equal(inferShxEncoding("chineset.shx"), "big5");
  assert.equal(inferShxEncoding("bigfont.shx"), "big5");
  assert.equal(inferShxEncoding("extfont.shx"), "shift_jis");
  assert.equal(inferShxEncoding("whgdtxt.shx"), "euc-kr");
  assert.equal(inferShxEncoding("whatever.shx"), "gbk");
  assert.equal(inferShxEncoding("whatever.shx", "ANSI_950"), "big5");
  assert.equal(inferShxEncoding("whatever.shx", "ANSI_932"), "shift_jis");
  assert.equal(inferShxEncoding("whatever.shx", "ANSI_949"), "euc-kr");
});

test("非 SHX 样式：上下文为空，render/measure 都返回空", async () => {
  const ctx = await ctxFor({ T: { font: "arial.ttf" } }, () => unitSquare());
  assert.equal(ctx.hasAnyShx, false);
  assert.equal(ctx.styles.size, 0);
  assert.equal(renderShxText(item({ style: "T" }), ctx), null);
  assert.equal(measureTextWidth(item({ style: "T" }), ctx), 0);
});

test("fonts.js 不存在时降级为 SHX 关闭，不抛异常", async () => {
  const ctx = await createShxContext({ root: process.cwd(), styleTable: { S: { font: "nope.shx" } } });
  assert.equal(ctx.hasAnyShx, false);
  assert.ok(ctx.warnings.length >= 1);
});

/* ───────────────────────── ASCII 排版 ───────────────────────── */

test("ASCII：字距按 lastPoint.x 累加", async () => {
  const ctx = await ctxFor({ F: STYLE }, () => unitSquare());
  const r = renderShxText(item({ text: "AB" }), ctx);
  assert.ok(r);
  assert.equal(r.missing, 0);
  assert.ok(close(r.advance, 20), `advance=${r.advance}`);
  assert.ok(close(Math.min(...xs(r)), 0));
  assert.ok(close(Math.max(...xs(r)), 20));
});

test("宽度因子 0.5 把总宽减半", async () => {
  const ctx = await ctxFor({ F: STYLE }, () => unitSquare());
  const r = renderShxText(item({ text: "AB", wf: 0.5 }), ctx);
  assert.ok(r);
  assert.ok(close(r.advance, 10), `advance=${r.advance}`);
  assert.ok(close(Math.max(...xs(r)), 10));
  assert.ok(close(measureTextWidth(item({ text: "AB", wf: 0.5 }), ctx), 10));
});

test("样式上的宽度因子在没有实体 41 时生效", async () => {
  const ctx = await ctxFor({ F: { ...STYLE, widthFactor: 0.5 } }, () => unitSquare());
  const r = renderShxText(item({ text: "A" }), ctx);
  assert.ok(r);
  assert.ok(close(r.advance, 5));
  assert.ok(close(Math.max(...xs(r)), 5));
});

test("缺字不吐 ?，计数进 missing，后续字符留出名义间距", async () => {
  const ctx = await ctxFor({ F: STYLE }, (_s, code) => (code === 65 ? unitSquare() : null));
  const r = renderShxText(item({ text: "A?" }), ctx);
  assert.ok(r);
  assert.equal(r.missing, 1);
  assert.equal(r.polylines.length, 1);
  // 10（A 的宽度） + 0.5h（缺字占位）
  assert.ok(close(r.advance, 15), `advance=${r.advance}`);
  // "?" 没有几何：A 之外不应有多余笔画
  assert.ok(close(Math.max(...xs(r)), 10));
  assert.ok(!String(JSON.stringify(r.polylines)).includes("63"));
});

test("整段无字形 → null（调用方保留原 TEXT）", async () => {
  const ctx = await ctxFor({ F: STYLE }, () => null);
  assert.equal(renderShxText(item({ text: "ABC" }), ctx), null);
});

/* ───────────────────────── 旋转 / 对齐 / 斜体 ───────────────────────── */

test("旋转 90°：(x,y) → (-y,x)（CCW 正角，绕插入点）", async () => {
  const ctx = await ctxFor({ F: STYLE }, () => unitSquare());
  const r = renderShxText(item({ text: "A", rot: 90 }), ctx);
  assert.ok(r);
  // DXF 组码 50 是 CCW 正角：(x,y) → (-y,x)
  // 原图 (0,0),(10,0),(10,10),(0,10) → (0,0),(0,10),(-10,10),(-10,0)
  const pts = r.polylines[0].points;
  const expect = [
    [0, 0],
    [0, 10],
    [-10, 10],
    [-10, 0],
  ];
  for (let i = 0; i < expect.length; i++) {
    assert.ok(close(pts[i][0], expect[i][0]), `p${i}.x=${pts[i][0]}`);
    assert.ok(close(pts[i][1], expect[i][1]), `p${i}.y=${pts[i][1]}`);
  }
  // 绕插入点：最大值
  assert.ok(close(Math.max(...xs(r)), 0));
  assert.ok(close(Math.min(...ys(r)), 0));
});

test("汉字 rot=90° 整串按 item.rot 旋转，不做正立逐字堆叠", async () => {
  // 基准是广联达截图：这类标签整串侧倒、沿竖直方向排字（不是逐字正立下叠）。
  const ctx = await ctxFor({ F: STYLE }, () => unitSquare());
  const r = renderShxText(item({ text: "中中", rot: 90 }), ctx);
  assert.ok(r);
  // CCW：(x,y) → (-y,x)，原 x 0..20 / y 0..10 → x -10..0 / y 0..20
  assert.ok(close(Math.min(...xs(r)), -10), `minX=${Math.min(...xs(r))}`);
  assert.ok(close(Math.max(...xs(r)), 0), `maxX=${Math.max(...xs(r))}`);
  assert.ok(close(Math.min(...ys(r)), 0), `minY=${Math.min(...ys(r))}`);
  assert.ok(close(Math.max(...ys(r)), 20), `maxY=${Math.max(...ys(r))}`);
  assert.equal(r.lineCount, 1, "仍是单行（折行只由 wrapByWidth 决定）");
  assert.equal(r.polylines.length, 2, "两个字 = 两条笔画折线");
  assert.ok(r.polylines.every((p) => p.cjk === true));
});

test("镜像块（item.mirror）：本地 y 翻转后再旋转", async () => {
  const ctx = await ctxFor({ F: STYLE }, () => unitSquare());
  // 镜像 INSERT 的累计矩阵 det<0 → block-text 给 rot=180 + mirror=true
  const r = renderShxText(item({ text: "A", rot: 180, mirror: true }), ctx);
  assert.ok(r);
  // (x,y) → (x,-y) → 转 180° → (-x,y)  [= diag(-1,1) 的纯水平镜像]
  const pts = r.polylines[0].points;
  const expect = [
    [0, 0],
    [-10, 0],
    [-10, 10],
    [0, 10],
  ];
  for (let i = 0; i < expect.length; i++) {
    assert.ok(close(pts[i][0], expect[i][0]), `p${i}.x=${pts[i][0]}`);
    assert.ok(close(pts[i][1], expect[i][1]), `p${i}.y=${pts[i][1]}`);
  }
});

test("halign CENTER / RIGHT 按测量宽度平移", async () => {
  const ctx = await ctxFor({ F: STYLE }, () => unitSquare());

  const c = renderShxText(item({ text: "A", halign: 1 }), ctx);
  assert.ok(c);
  assert.ok(close(Math.min(...xs(c)), -5));
  assert.ok(close(Math.max(...xs(c)), 5));

  const rr = renderShxText(item({ text: "A", halign: 2 }), ctx);
  assert.ok(rr);
  assert.ok(close(Math.min(...xs(rr)), -10));
  assert.ok(close(Math.max(...xs(rr)), 0));
});

test("halign 非 0 且有 11/21 对齐点时以对齐点为锚点", async () => {
  const ctx = await ctxFor({ F: STYLE }, () => unitSquare());
  const r = renderShxText(item({ text: "A", halign: 1, x: 0, y: 0, ax: 100, ay: 50 }), ctx);
  assert.ok(r);
  assert.ok(close(Math.min(...xs(r)), 95));
  assert.ok(close(Math.max(...xs(r)), 105));
  assert.ok(close(Math.min(...ys(r)), 50));
});

test("valign MIDDLE / TOP 按墨迹 bbox 平移", async () => {
  const ctx = await ctxFor({ F: STYLE }, () => unitSquare());

  const m = renderShxText(item({ text: "A", valign: 2 }), ctx);
  assert.ok(m);
  assert.ok(close(Math.min(...ys(m)), -5));
  assert.ok(close(Math.max(...ys(m)), 5));

  const t = renderShxText(item({ text: "A", valign: 3 }), ctx);
  assert.ok(t);
  assert.ok(close(Math.min(...ys(t)), -10));
  assert.ok(close(Math.max(...ys(t)), 0));

  const b = renderShxText(item({ text: "A", valign: 1 }), ctx);
  assert.ok(b);
  assert.ok(close(Math.min(...ys(b)), 0));
  assert.ok(close(Math.max(...ys(b)), 10));
});

test("斜体 45°：x += y·tan(45°)", async () => {
  const ctx = await ctxFor({ F: { ...STYLE, oblique: 45 } }, () => unitSquare());
  const r = renderShxText(item({ text: "A" }), ctx);
  assert.ok(r);
  // 顶点 (0,10) → x = 0 + 10 = 10；(10,10) → x = 10 + 10 = 20
  assert.ok(close(Math.max(...xs(r)), 20), `maxX=${Math.max(...xs(r))}`);
  assert.ok(close(Math.min(...xs(r)), 0));
});

/* ───────────────────────── 多行 ───────────────────────── */

test("多行 \\n：每行下移 1.6h", async () => {
  const ctx = await ctxFor({ F: STYLE }, () => unitSquare());
  const r = renderShxText(item({ text: "A\nB" }), ctx);
  assert.ok(r);
  assert.ok(close(Math.max(...ys(r)), 10));
  assert.ok(close(Math.min(...ys(r)), -16), `minY=${Math.min(...ys(r))}`);
  // 两行各 10 宽，总 advance 取最宽行
  assert.ok(close(r.advance, 10));
});

test("多行 \\P 也识别为换行", async () => {
  const ctx = await ctxFor({ F: STYLE }, () => unitSquare());
  const r = renderShxText(item({ text: "A\\PB" }), ctx);
  assert.ok(r);
  assert.ok(close(Math.min(...ys(r)), -16));
});

/* ───────────────────────── 中文折行保护（v25） ───────────────────────── */

test("中文折行：248/225 的「数据机架」折成 2 字一行（共两行）", async () => {
  const ctx = await ctxFor({ F: STYLE }, () => unitSquare());
  const r = renderShxText(item({ text: "数据机架", h: 225, width: 248 }), ctx);
  assert.ok(r);
  assert.equal(r.lineCount, 2, "2 字一行共两行，而不是 1 字一行共四行");
  // 两行行距 1.6h = 360；每行 2 字 = 450 宽
  assert.ok(close(Math.max(...xs(r)), 450), `maxX=${Math.max(...xs(r))}`);
  assert.ok(close(Math.max(...ys(r)), 225));
  assert.ok(close(Math.min(...ys(r)), -360));
});

test("中文折行：「空调」两字不拆成两行", async () => {
  const ctx = await ctxFor({ F: STYLE }, () => unitSquare());
  const r = renderShxText(item({ text: "空调", h: 225, width: 248 }), ctx);
  assert.ok(r);
  assert.equal(r.lineCount, 1);
  assert.ok(close(Math.max(...xs(r)), 450));
  assert.ok(close(Math.min(...ys(r)), 0));
});

test("中文折行：单字不折", async () => {
  const ctx = await ctxFor({ F: STYLE }, () => unitSquare());
  const r = renderShxText(item({ text: "中", h: 225, width: 1 }), ctx);
  assert.ok(r);
  assert.equal(r.lineCount, 1);
});

test("拉丁串折行不受中文保护影响（仍按原宽度，1 字一行也可以）", async () => {
  const ctx = await ctxFor({ F: STYLE }, () => unitSquare());
  // 每字 10 宽、折行宽度 12 → 旧行为就是一行一个字
  const r = renderShxText(item({ text: "ABCD", h: 10, width: 12 }), ctx);
  assert.ok(r);
  assert.equal(r.lineCount, 4);
  assert.ok(close(Math.min(...ys(r)), -48));
});

/* ───────────────────────── 大字体映射 ───────────────────────── */

test("大字体：码页编码 → lead*256+trail 查字形", async () => {
  const calls = [];
  const ctx = await ctxFor(
    { CJK: { font: "hztxt.shx", bigFont: "gbcbig.shx" } },
    (styleName, code, kind) => {
      calls.push({ styleName, code, kind });
      return unitSquare();
    }
  );
  const r = renderShxText(item({ text: "中", style: "CJK" }), ctx);
  assert.ok(r);
  assert.equal(ctx.styles.get("CJK").encoding, "gbk");
  // 中 的 GBK = D6 D0 → 0xD6 * 256 + 0xD0
  const expected = 0xd6 * 256 + 0xd0;
  assert.ok(
    calls.some((c) => c.kind === "big" && c.code === expected),
    `calls=${JSON.stringify(calls)}`
  );
  assert.ok(!calls.some((c) => c.kind === "big" && c.code === 0x4e2d));
});

test("大字体：注入 encodeChar 时用自定义映射（lead*256+trail）", async () => {
  const seen = [];
  const ctx = await ctxFor(
    { CJK: { font: "hztxt.shx", bigFont: "chineset.shx" } },
    (_s, code, kind) => {
      seen.push({ code, kind });
      return kind === "big" && code === 0x81 * 256 + 0x40 ? unitSquare() : null;
    }
  );
  ctx.encodeChar = () => [0x81, 0x40];
  const r = renderShxText(item({ text: "中", style: "CJK" }), ctx);
  assert.ok(r);
  assert.equal(ctx.styles.get("CJK").encoding, "big5");
  assert.ok(seen.some((s) => s.kind === "big" && s.code === 0x81 * 256 + 0x40));
});

test("大字体缺字 → 回退主字体 Unicode 码位；都缺则计 missing", async () => {
  const ctx = await ctxFor(
    { CJK: { font: "hztxt.shx", bigFont: "gbcbig.shx" } },
    (_s, code, kind) => (kind === "primary" && code === 0x4e2d ? unitSquare() : null)
  );
  const r = renderShxText(item({ text: "中", style: "CJK" }), ctx);
  assert.ok(r); // 主字体兜底成功
  assert.equal(r.missing, 0);

  const ctx2 = await ctxFor(
    { CJK: { font: "hztxt.shx", bigFont: "gbcbig.shx" } },
    () => null
  );
  const r2 = renderShxText(item({ text: "中", style: "CJK" }), ctx2);
  assert.equal(r2, null); // 整段无字形
});

test("unifont 主字体：非 ASCII 直接按 Unicode 码位取字形", async () => {
  const seen = [];
  const ctx = await ctxFor(
    { U: { font: "unifont.shx", primaryType: "unifont" } },
    (_s, code, kind) => {
      seen.push({ code, kind });
      return kind === "primary" && code === 0x4e2d ? unitSquare() : null;
    }
  );
  const r = renderShxText(item({ text: "中", style: "U" }), ctx);
  assert.ok(r);
  assert.ok(seen.some((s) => s.kind === "primary" && s.code === 0x4e2d));
});

test("大字体按单元格宽度推进（lastPoint 是笔位，不是字宽）", async () => {
  // 复刻 gbcbig.shx「中」的真实字形：lastPoint.x=12 但墨迹到 55，字高单位 64。
  // 如果拿 lastPoint.x 当字距，整行汉字会叠在一起（实测 bug）。
  const ink = {
    polylines: [
      [
        { x: 12, y: 1 },
        { x: 55, y: 1 },
        { x: 55, y: 90 },
        { x: 12, y: 90 },
      ],
    ],
    lastPoint: { x: 12, y: 34 },
    bbox: { minX: 12, minY: 1, maxX: 55, maxY: 90 },
  };
  const ctx = await ctxFor(
    { CJK: { font: "hztxt.shx", bigFont: "gbcbig.shx" } },
    (_s, _code, kind) => (kind === "big" ? ink : null)
  );
  ctx.styles.get("CJK").bigUnits = 64; // 注入字形按 64 单位为 1 个字号
  const r = renderShxText(item({ text: "中中", style: "CJK", h: 10 }), ctx);
  assert.ok(r);
  // 两个汉字各占 1 个单元格 = 10 → 总宽 20，而不是 2×12/64×10 ≈ 3.75
  assert.ok(close(r.advance, 20), `advance=${r.advance}`);
  assert.ok(close(Math.max(...xs(r)), 55 * (10 / 64) + 10), `maxX=${Math.max(...xs(r))}`);
});

test("STYLE 组码 3/4 省略 .shx 扩展名（SIMPLEX/GBCBIG）也纳入", async () => {
  const ctx = await ctxFor(
    { S: { font: "SIMPLEX", bigFont: "GBCBIG" } },
    () => unitSquare()
  );
  assert.equal(ctx.hasAnyShx, true);
  assert.ok(ctx.styles.has("S"));
  const r = renderShxText(item({ text: "A", style: "S" }), ctx);
  assert.ok(r);
});

test("只有大字体是 SHX 时，ASCII 也会回退到大字体取字形", async () => {
  const ctx = await ctxFor(
    { MIX: { font: "arial.ttf", bigFont: "gbcbig.shx" } },
    (_s, code, kind) => (kind === "big" && code === 0x41 ? unitSquare() : null)
  );
  assert.equal(ctx.hasAnyShx, true);
  const r = renderShxText(item({ text: "A", style: "MIX" }), ctx);
  assert.ok(r);
  assert.equal(r.missing, 0);
});

/* ───────────────────────── MTEXT 内联码（v18） ───────────────────────── */

test("mtextToPlainText：\\P 换行、\\~ 空格、转义字面量与分组花括号", () => {
  assert.equal(mtextToPlainText("A\\PB"), "A\nB");
  assert.equal(mtextToPlainText("A\\~B"), "A B");
  assert.equal(mtextToPlainText("a\\\\b"), "a\\b");
  assert.equal(mtextToPlainText("\\{x\\}"), "{x}");
  // 分组花括号只是格式作用域，不参与显示
  assert.equal(mtextToPlainText("{ABC}"), "ABC");
  // 分组里的字体码删掉，内容保留
  assert.equal(mtextToPlainText("{\\fArial|b0|i0;ABC}"), "ABC");
});

test("mtextToPlainText：\\H…\\W… 之后的无参数开关码 \\o/\\l/\\k 也必须删除", () => {
  /* 实测 f98307048d9d 的标题（块内 MTEXT，style ELEC_DIM）：
   *   \FDIM.shx,HZTXT.shx;\W0.8;\T1;\o\l数据机房通道及走线架安装立面图（侧面）
   * 旧版块内展开只删「带分号」的码，\o\ 和 \l 被当成 4 个可见字符画出来。 */
  const raw = "\\FDIM.shx,HZTXT.shx;\\W0.8000000000;\\T1.0000000000;\\o\\l数据机房通道及走线架安装立面图（侧面）";
  const plain = mtextToPlainText(raw);
  assert.equal(plain, "数据机房通道及走线架安装立面图（侧面）");
  assert.ok(!/\\[A-Za-z]/.test(plain), `不应残留内联码: ${JSON.stringify(plain)}`);
  // 开关码可以成对出现、也可以混在中间
  assert.equal(mtextToPlainText("\\L下划线\\l正常"), "下划线正常");
  assert.equal(mtextToPlainText("\\O上划线\\o\\K删除线\\k"), "上划线删除线");
});

test("MTEXT 折行：自然宽度恰好等于组码 41 时不折行（19 字标题保持一行）", async () => {
  /* 同样取自 f98307048d9d：h=425.19685、STYLE 宽度因子 0.8、19 个汉字，
   * 组码 41 = 19 × 425.19685 × 0.8 = 6462.99212598425 —— 恰好排满。
   * 这属于 AutoCAD 的"放得下"，不能因为 1e-12 的浮点误差就折行。 */
  const ctx = await ctxFor({ F: { ...STYLE, widthFactor: 0.8 } }, () => unitSquare());
  const text = "数据机房通道及走线架安装立面图（侧面）";
  assert.equal(Array.from(text).length, 19);
  const it = item({ text, h: 425.19685039370063, style: "F", halign: 0, valign: 3 });
  const natural = measureTextWidth(it, ctx);
  assert.ok(close(natural, 6462.99212598425, 1e-12), `natural=${natural}`);
  const r = renderShxText({ ...it, width: natural }, ctx);
  assert.ok(r);
  assert.equal(r.lineCount, 1, "恰好排满必须一行");
  // 再多一点就真的排不下 → 折行（容差不能把真正的溢出也放过）
  const r2 = renderShxText({ ...it, width: natural - 1 }, ctx);
  assert.ok(r2);
  assert.equal(r2.lineCount, 2);
});

test("mtextToPlainText：字高/对齐/颜色/宽度/字距/段落码全部删除", () => {
  assert.equal(mtextToPlainText("\\H1.5x;A"), "A");
  assert.equal(mtextToPlainText("\\H2.5;A"), "A");
  assert.equal(mtextToPlainText("\\A1;A"), "A");
  assert.equal(mtextToPlainText("\\C1;A"), "A");
  assert.equal(mtextToPlainText("\\c255;A"), "A");
  assert.equal(mtextToPlainText("\\T1.5;A"), "A");
  assert.equal(mtextToPlainText("\\Q15;A"), "A");
  assert.equal(mtextToPlainText("\\W0.8;A"), "A");
  assert.equal(mtextToPlainText("\\pql;A"), "A");
  // 连续码 + 换行混合
  assert.equal(mtextToPlainText("\\A1;8000"), "8000");
  assert.equal(mtextToPlainText("\\A1;第一行\\P\\H2.5;第二行"), "第一行\n第二行");
});

test("mtextToPlainText：\\S 堆叠分数保留内容与分隔符", () => {
  assert.equal(mtextToPlainText("\\S1/2;"), "1/2");
  assert.equal(mtextToPlainText("\\S1^2;"), "1^2");
  assert.equal(mtextToPlainText("\\S+0.5^-0.2;"), "+0.5^-0.2");
});

test("mtextToPlainText：%% 控制码与 \\U+XXXX", () => {
  assert.equal(mtextToPlainText("%%d"), "°");
  assert.equal(mtextToPlainText("%%D"), "°");
  assert.equal(mtextToPlainText("%%p"), "±");
  assert.equal(mtextToPlainText("%%P"), "±");
  assert.equal(mtextToPlainText("%%%"), "%");
  assert.equal(mtextToPlainText("%%c"), "\u2205");
  assert.equal(mtextToPlainText("%%C"), "\u2205");
  assert.equal(mtextToPlainText("%%065"), "A");
  assert.equal(mtextToPlainText("\\U+4E2D"), "中");
  // 被转义的反斜杠后面跟 U+ 不应再被解码
  assert.equal(mtextToPlainText("\\\\U+0041"), "\\U+0041");
});

test("mtextToPlainText：控制字符与首尾换行被清掉，中间换行保留", () => {
  assert.equal(mtextToPlainText("\u0007 A \u0001"), " A ");
  assert.equal(mtextToPlainText("\\P\\PAB\\P"), "AB");
  assert.equal(mtextToPlainText("A\\PB"), "A\nB");
});

test("mtextAttachToAlign：71 的 3×3 附着点 → halign/valign", () => {
  // 上排：左/中/右 + 顶部（valign=3，墨迹顶边在插入点）
  assert.deepEqual(mtextAttachToAlign(1), { halign: 0, valign: 3 });
  assert.deepEqual(mtextAttachToAlign(2), { halign: 1, valign: 3 });
  assert.deepEqual(mtextAttachToAlign(3), { halign: 2, valign: 3 });
  // 中排
  assert.deepEqual(mtextAttachToAlign(4), { halign: 0, valign: 2 });
  assert.deepEqual(mtextAttachToAlign(5), { halign: 1, valign: 2 });
  assert.deepEqual(mtextAttachToAlign(6), { halign: 2, valign: 2 });
  // 下排
  assert.deepEqual(mtextAttachToAlign(7), { halign: 0, valign: 1 });
  assert.deepEqual(mtextAttachToAlign(8), { halign: 1, valign: 1 });
  assert.deepEqual(mtextAttachToAlign(9), { halign: 2, valign: 1 });
  // 缺省/非法值按左上
  assert.deepEqual(mtextAttachToAlign(0), { halign: 0, valign: 3 });
  assert.deepEqual(mtextAttachToAlign(undefined), { halign: 0, valign: 3 });
});

test("MTEXT 顶部附着：字形墨迹顶边落在插入点 y（基线低于顶边一个字高）", async () => {
  const ctx = await ctxFor({ F: STYLE }, () => unitSquare());
  const { halign, valign } = mtextAttachToAlign(1);
  const r = renderShxText(item({ text: "A", x: 100, y: 50, halign, valign, ax: 100, ay: 50 }), ctx);
  assert.ok(r);
  assert.ok(close(Math.max(...ys(r)), 50)); // 顶边 = 插入点
  assert.ok(close(Math.min(...ys(r)), 40)); // 字高 10，基线在下方
});



test("折线上限 2000：超出截断并给 warning", async () => {
  const many = {
    polylines: Array.from({ length: 3000 }, () => [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ]),
    lastPoint: { x: 1, y: 0 },
    bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
  };
  const ctx = await ctxFor({ F: STYLE }, () => many);
  const r = renderShxText(item({ text: "A" }), ctx);
  assert.ok(r);
  assert.equal(r.polylines.length, SHX_LIMITS.maxPolylines);
  assert.ok(r.warnings.length >= 1);
  assert.ok(ctx.warnings.length >= 1);
});

test("单条折线顶点上限 4000：超出截断并给 warning", async () => {
  const long = {
    polylines: [
      Array.from({ length: 5000 }, (_, i) => ({ x: i / 5000, y: 0 })),
    ],
    lastPoint: { x: 1, y: 0 },
    bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
  };
  const ctx = await ctxFor({ F: STYLE }, () => long);
  const r = renderShxText(item({ text: "A" }), ctx);
  assert.ok(r);
  assert.equal(r.polylines[0].points.length, SHX_LIMITS.maxPoints);
  assert.ok(r.warnings.length >= 1);
});

/* ───────────────────────── 图层/颜色透传 ───────────────────────── */

test("图层与颜色原样带在每条折线上", async () => {
  const ctx = await ctxFor({ F: STYLE }, () => unitSquare());
  const r = renderShxText(item({ text: "A", layer: "标注", aci: 5 }), ctx);
  assert.ok(r);
  assert.equal(r.polylines[0].layer, "标注");
  assert.equal(r.polylines[0].aci, 5);
});

/* ───────────────────────── CJK 标记（v25 加粗的判据） ───────────────────────── */

test("每条折线带 cjk 标记：拉丁 false，汉字 true", async () => {
  const ctx = await ctxFor({ F: STYLE }, () => unitSquare());
  const r = renderShxText(item({ text: "A中" }), ctx);
  assert.ok(r);
  assert.equal(r.polylines.length, 2);
  assert.equal(r.polylines[0].cjk, false, "A 是拉丁，保持细折线");
  assert.equal(r.polylines[1].cjk, true, "中 是汉字，可加粗成填充");
});

test("全角标点/汉字统一标 cjk；纯拉丁整段都 false", async () => {
  const ctx = await ctxFor({ F: STYLE }, () => unitSquare());
  const latin = renderShxText(item({ text: "AB-12" }), ctx);
  assert.ok(latin);
  assert.ok(latin.polylines.every((p) => p.cjk === false));

  const cjk = renderShxText(item({ text: "中文，。" }), ctx);
  assert.ok(cjk);
  assert.ok(cjk.polylines.every((p) => p.cjk === true));
});

test("上下文暴露笔画模式：auto 不加粗，always 加粗", async () => {
  const auto = await ctxFor({ F: STYLE }, () => unitSquare());
  assert.equal(auto.textStroke, "auto");
  assert.equal(auto.strokeAll, false);

  const always = await createShxContext({
    root: process.cwd(),
    styleTable: { F: STYLE },
    resolveShape: () => unitSquare(),
    textStroke: "always",
  });
  assert.equal(always.textStroke, "always");
  assert.equal(always.strokeAll, true);
});
