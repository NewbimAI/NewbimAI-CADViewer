/**
 * block-text.js 的展平属性测试（v21）：
 *   · MTEXT 的折行宽度（组码 41）、旋转（50）、附着点（71）必须带到展平项上；
 *   · 转义的样式名（`\U+XXXX`）必须解码，否则上层查不到 SHX 样式；
 *   · TEXT 的展平行为保持不变（单行、样式缺省 STANDARD、不带折行宽度）。
 *
 * 运行：node --test server/block-text.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { flattenTexts } from "./block-text.js";

function fixtureDxf() {
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
    "10", "10",
    "20", "20",
    "30", "0",
    "40", "225",
    "41", "248.0387374109996",
    "71", "1",
    "50", "15",
    "7", "\\U+5B8B\\U+4F53",
    "1", "{\\W1;数据机架}",
    "0", "TEXT",
    "5", "11",
    "8", "0",
    "10", "30",
    "20", "40",
    "40", "50",
    "1", "A  B",
    "0", "ENDBLK",
    "5", "12",
    "8", "0",
    "0", "ENDSEC",
    "0", "SECTION", "2", "ENTITIES",
    "0", "INSERT",
    "5", "13",
    "8", "0",
    "2", "*B",
    "10", "1000",
    "20", "2000",
    "41", "1",
    "42", "1",
    "50", "0",
    "0", "ENDSEC",
    "0", "EOF",
    "",
  ].join("\n");
}

function flattenFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cadviewer-block-text-"));
  const file = path.join(dir, "fixture.dxf");
  fs.writeFileSync(file, fixtureDxf(), "utf8");
  try {
    return flattenTexts(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("MTEXT 展平保留折行宽度 / 旋转 / 附着点，样式名解码", () => {
  const { items } = flattenFixture();
  const mt = items.find((it) => it.mtext);
  assert.ok(mt, "应能找到展平的 MTEXT");

  assert.equal(mt.text, "数据机架");
  assert.equal(mt.mtext, true);
  assert.equal(mt.wrapWidth, 248.0387374109996);
  assert.equal(mt.rot, 15);
  assert.equal(mt.h, 225);
  assert.equal(mt.attach, 1);
  assert.deepEqual({ halign: mt.halign, valign: mt.valign }, { halign: 0, valign: 3 });
  // INSERT 在 (1000,2000)，块基点 (0,0)
  assert.equal(mt.x, 1010);
  assert.equal(mt.y, 2020);
  assert.equal(mt.style, "宋体", "组码 7 的 \\U+XXXX 必须解码");
});

test("TEXT 展平行为不变：单行、无折行宽度、缺省样式 STANDARD", () => {
  const { items } = flattenFixture();
  const tx = items.find((it) => !it.mtext);
  assert.ok(tx, "应能找到展平的 TEXT");

  assert.equal(tx.text, "A B", "连续空白折叠为单空格");
  assert.equal(tx.mtext, false);
  assert.equal(tx.wrapWidth, 0);
  assert.equal(tx.style, "STANDARD");
  assert.equal(tx.h, 50);
  assert.equal(tx.rot, 0);
  assert.equal(tx.x, 1030);
  assert.equal(tx.y, 2040);
});

/* ───────────── v30：块内 MTEXT 走共享的 mtextToPlainText ───────────── */

test("块内 MTEXT：\\o\\l 等无参数开关码不得泄漏到展平文字里", () => {
  /* 实测 f98307048d9d（桥架照明及智能化测试图纸）的立面图标题就在块里，
   * 以前 block-text.js 用自己的 cleanText，`\o`/`\l` 原样留下：
   *   展平文字 = "\o\l数据机房通道及走线架安装立面图（侧面）"
   * 多出的 4 个字符还把自然宽度从 6462.99 撑到 7325.53，触发组码 41 折行。 */
  const raw = "\\FDIM.shx,HZTXT.shx;\\W0.8000000000;\\T1.0000000000;\\o\\l数据机房通道及走线架安装立面图（侧面）";
  const { items } = flattenDxf(
    dxfOf({
      blocks: [
        {
          name: "TITLE",
          ents: [
            [
              "0", "MTEXT", "8", "Defpoints", "10", "10", "20", "20", "30", "0",
              "40", "425.19685039370063", "41", "6462.99212598425", "71", "1",
              "7", "ELEC_DIM", "1", raw,
            ],
          ],
        },
      ],
      tops: [ins({ name: "TITLE", x: 1000, y: 2000 })],
    })
  );
  const mt = items.find((it) => it.mtext);
  assert.ok(mt, "应能找到展平的块内 MTEXT");
  assert.equal(mt.text, "数据机房通道及走线架安装立面图（侧面）");
  assert.ok(!/\\[A-Za-z]/.test(mt.text), `内联码泄漏: ${JSON.stringify(mt.text)}`);
  // wrapWidth / attach 语义保持不变
  assert.equal(mt.wrapWidth, 6462.99212598425);
  assert.equal(mt.attach, 1);
  assert.deepEqual({ halign: mt.halign, valign: mt.valign }, { halign: 0, valign: 3 });
});

test("块内 MTEXT：\\P 仍展开为换行（多段不被压成一行）", () => {
  const { items } = flattenDxf(
    dxfOf({
      blocks: [
        {
          name: "TITLE",
          ents: [
            [
              "0", "MTEXT", "8", "0", "10", "0", "20", "0", "30", "0",
              "40", "10", "1", "\\A1;第一段\\P第二段",
            ],
          ],
        },
      ],
      tops: [ins({ name: "TITLE", x: 0, y: 0 })],
    })
  );
  assert.equal(items[0].text, "第一段\n第二段");
});

test("块内 MTEXT：内部空格原样保留（不折叠，也不吃掉 `\\~` 的空格）", () => {
  /* 需求：抽取器不得吞掉 MTEXT 里有意义的空格。TEXT 会折叠连续空白，MTEXT 不会。 */
  const { items } = flattenDxf(
    dxfOf({
      blocks: [
        {
          name: "B",
          ents: [
            [
              "0", "MTEXT", "8", "0", "10", "0", "20", "0", "30", "0",
              "40", "10", "1", "数据 机房\\~通道",
            ],
          ],
        },
      ],
      tops: [ins({ name: "B", x: 0, y: 0 })],
    })
  );
  assert.equal(items[0].text, "数据 机房 通道");
});

test("块内 MTEXT：mtEXT 统计只计 MTEXT，不计 TEXT", () => {
  const { stats } = flattenDxf(
    dxfOf({
      blocks: [
        {
          name: "B",
          ents: [
            [
              "0", "MTEXT", "8", "0", "10", "0", "20", "0", "30", "0", "40", "10", "1", "m",
            ],
            ...txt({ text: "t", x: 5, y: 5 }),
          ],
        },
      ],
      tops: [ins({ name: "B", x: 0, y: 0 })],
    })
  );
  assert.equal(stats.mtext, 1);
});

/* ───────────── v29：块内文字 = 整块变换（位置/旋转/字高/镜像） ───────────── */
/** 用「实体行」拼一个最小 DXF（BLOCK 图元 + 顶层实体） */
function dxfOf({ blocks = [], tops = [] }) {
  const out = ["0", "SECTION", "2", "BLOCKS"];
  for (const b of blocks) {
    out.push(
      "0", "BLOCK", "8", "0", "2", b.name, "70", "0",
      "10", String(b.base?.[0] ?? 0), "20", String(b.base?.[1] ?? 0), "30", "0",
      "3", b.name, "1", ""
    );
    for (const e of b.ents) out.push(...e);
    out.push("0", "ENDBLK", "8", "0");
  }
  out.push("0", "ENDSEC", "0", "SECTION", "2", "ENTITIES");
  for (const e of tops) out.push(...e);
  out.push("0", "ENDSEC", "0", "EOF", "");
  return out.join("\n");
}

function flattenDxf(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cadviewer-block-xform-"));
  const file = path.join(dir, "fixture.dxf");
  fs.writeFileSync(file, text, "utf8");
  try {
    return flattenTexts(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const txt = ({ text = "A", x = 0, y = 0, h = 2, rot = 0 } = {}) => [
  "0", "TEXT", "8", "0", "10", String(x), "20", String(y), "30", "0",
  "40", String(h), "1", text, "50", String(rot),
];
const ins = ({ name, handle, x = 0, y = 0, rot = 0, sx = 1, sy = 1 } = {}) => [
  "0", "INSERT", ...(handle ? ["5", handle] : []), "8", "0", "2", name,
  "10", String(x), "20", String(y), "30", "0",
  "41", String(sx), "42", String(sy), "43", "1", "50", String(rot),
];
/** 跟在 INSERT 后面的顶层 ATTRIB（组码 40 的 h 是 WCS 值；owner = INSERT 句柄） */
const attrib = ({ owner, handle = "A1", tag = "A", text = "ATTR", x = 0, y = 0, h = 1 } = {}) => [
  "0", "ATTRIB", "5", handle, "330", owner, "8", "0", "2", tag,
  "10", String(x), "20", String(y), "30", "0", "40", String(h), "1", text, "70", "0",
];
/** 块定义里的属性模板 */
const attdef = ({ tag = "A", text = "ATTR", h = 1, x = 0, y = 0 } = {}) => [
  "0", "ATTDEF", "8", "0", "2", tag,
  "10", String(x), "20", String(y), "30", "0", "40", String(h), "1", text, "70", "0",
];

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));

test("块旋转 90° + 文字 rot=0 → 世界角 90°（CCW，正值）", () => {
  const { items } = flattenDxf(
    dxfOf({
      blocks: [{ name: "B", ents: [txt({ x: 10, y: 0 })] }],
      tops: [ins({ name: "B", x: 100, y: 200, rot: 90 })],
    })
  );
  assert.equal(items.length, 1);
  const it = items[0];
  assert.ok(close(it.rot, 90), `rot=${it.rot}`);
  assert.ok(close(it.x, 100), `x=${it.x}`);
  assert.ok(close(it.y, 210), `y=${it.y}`);
  assert.equal(it.mirror, false);
});

test("嵌套块：旋转逐级叠加（外 90° + 内 45° = 135°）", () => {
  const { items } = flattenDxf(
    dxfOf({
      blocks: [
        { name: "INNER", ents: [txt({ x: 10, y: 0 })] },
        { name: "OUTER", ents: [ins({ name: "INNER", x: 100, y: 0, rot: 45 })] },
      ],
      tops: [ins({ name: "OUTER", x: 0, y: 0, rot: 90 })],
    })
  );
  assert.equal(items.length, 1);
  const it = items[0];
  assert.ok(close(it.rot, 135), `rot=${it.rot}`);
  // R45·(10,0)=(7.0711,7.0711) → +(100,0) → R90 → (-7.0711,107.0711)
  assert.ok(close(it.x, -7.0710678118654755), `x=${it.x}`);
  assert.ok(close(it.y, 107.07106781186548), `y=${it.y}`);
});

test("嵌套块：位置按基点偏移累计（内块基点非零）", () => {
  const { items } = flattenDxf(
    dxfOf({
      blocks: [
        { name: "INNER", base: [10, 5], ents: [txt({ x: 10, y: 5 })] },
        { name: "OUTER", ents: [ins({ name: "INNER", x: 100, y: 0, rot: 0 })] },
      ],
      tops: [ins({ name: "OUTER", x: 0, y: 0, rot: 0 })],
    })
  );
  // 内块基点 (10,5) 恰好等于文字位置 → 世界 (100,0)
  assert.ok(close(items[0].x, 100), `x=${items[0].x}`);
  assert.ok(close(items[0].y, 0), `y=${items[0].y}`);
});

test("非均匀缩放：字高乘两轴平均并产生告警", () => {
  const { items, stats } = flattenDxf(
    dxfOf({
      blocks: [{ name: "B", ents: [txt({ x: 0, y: 0, h: 2 })] }],
      tops: [ins({ name: "B", x: 0, y: 0, sx: 2, sy: 3 })],
    })
  );
  assert.equal(items.length, 1);
  assert.ok(close(items[0].h, 2 * 2.5), `h=${items[0].h}`);
  assert.equal(stats.nonUniformTexts, 1);
  assert.equal(stats.warnings.length, 1);
  assert.match(stats.warnings[0], /非均匀缩放/);
});

test("均匀缩放：字高乘该缩放，不产生告警", () => {
  const { items, stats } = flattenDxf(
    dxfOf({
      blocks: [{ name: "B", ents: [txt({ x: 0, y: 0, h: 2 })] }],
      tops: [ins({ name: "B", x: 0, y: 0, sx: 4, sy: 4 })],
    })
  );
  assert.ok(close(items[0].h, 8), `h=${items[0].h}`);
  assert.equal(stats.nonUniformTexts, 0);
  assert.equal(stats.warnings.length, 0);
});

/* ───────────── v50：顶层 ATTRIB 字高（无 ATTDEF 模板 = 已烘焙的 WCS 值） ───────────── */

test("顶层 ATTRIB：块内没有 ATTDEF 时字高按 WCS 原值，不再乘 INSERT 缩放", () => {
  /* 实测 机柜图纸.dxf（887ab95e7a53）的 $WINLIB2D$ / $DorLib2D$ 门窗库块：
   * 块里只有 6 条 LWPOLYLINE、没有任何 ATTDEF；INSERT 41=6800/42=200；
   * 顶层 ATTRIB 的 40 已经是世界值 297.5 → 旧代码乘 |41| 变成 2,023,000 高。 */
  const { items } = flattenDxf(
    dxfOf({
      blocks: [{ name: "$WINLIB2D$00000001", ents: [] }],
      tops: [
        ins({ name: "$WINLIB2D$00000001", handle: "A400", x: 11615.49, y: -267590.21, sx: 6800, sy: 200 }),
        attrib({ owner: "A400", handle: "A401", text: "BLM1", x: 11280.49, y: -267378.78, h: 297.5 }),
      ],
    })
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].h, 297.5, "组码 40 已是世界字高，不能再乘 6800");
  assert.ok(close(items[0].x, 11280.49), `x=${items[0].x}`);
  assert.ok(close(items[0].y, -267378.78), `y=${items[0].y}`);
  assert.equal(items[0].attrib, true);
});

test("顶层 ATTRIB：有 ATTDEF 模板且 h 仍是块内值时，仍按模板判据乘缩放（旧行为不变）", () => {
  const { items } = flattenDxf(
    dxfOf({
      blocks: [{ name: "B", ents: [attdef({ tag: "A", h: 0.5 })] }],
      tops: [
        ins({ name: "B", handle: "I2", x: 0, y: 0, sx: 100, sy: 100 }),
        attrib({ owner: "I2", handle: "A2", tag: "A", h: 0.5, x: 10, y: 20 }),
      ],
    })
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].h, 50, "h=0.5 = 模板值 → 乘插入缩放 100");
});

test("顶层 ATTRIB：有 ATTDEF 模板但 h 已烘焙成世界值时，不再乘缩放（v13 行为不变）", () => {
  const { items } = flattenDxf(
    dxfOf({
      blocks: [{ name: "B", ents: [attdef({ tag: "A", h: 0.5 })] }],
      tops: [
        ins({ name: "B", handle: "I3", x: 0, y: 0, sx: 100, sy: 100 }),
        attrib({ owner: "I3", handle: "A3", tag: "A", h: 50, x: 10, y: 20 }),
      ],
    })
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].h, 50, "h=50 已等于 模板 0.5 × 100 → 保持原值");
});

test("镜像块（det<0）：标记 mirror，位置按矩阵走，旋转吸收反射", () => {
  const { items, stats } = flattenDxf(
    dxfOf({
      blocks: [{ name: "B", ents: [txt({ x: 10, y: 0 })] }],
      tops: [ins({ name: "B", x: 100, y: 200, sx: -1, sy: 1 })],
    })
  );
  assert.equal(items.length, 1);
  const it = items[0];
  assert.equal(it.mirror, true);
  assert.ok(close(it.x, 90), `x=${it.x}`); // 100 - 10
  assert.ok(close(it.y, 200), `y=${it.y}`);
  assert.ok(close(Math.abs(it.rot), 180), `rot=${it.rot}`);
  assert.equal(stats.mirroredTexts, 1);
});
