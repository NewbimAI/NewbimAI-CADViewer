/**
 * DWG → DXF → 浏览器 WebGL 渲染（dxf-viewer）的服务端预处理。
 *
 * 为什么要这个模块（2026-10-18 实测，勿删）：
 * dxf-viewer 自带的解析器有两个硬缺口，直接用会导致内容成片丢失/乱码：
 *   ① **不解码 `\U+XXXX`**：cadcraft 导出的 DXF 把所有非 ASCII 写成 `\U+5C4B` 这种转义，
 *      实测 2024 条文字带这种转义、0 条是真汉字 → 不处理就是满屏 `\U+5C4B` 字样。
 *   ② **不认 ACAD_TABLE**：本图 63 张原生表格会被解析器直接丢弃（实体表里 TABLE: 0），
 *      而表格正是用户截图里"缺内容"的那部分。
 *
 * 做法：读进来是纯 ASCII（DXF R2004，AC1018，无编码字节），所以可以安全地
 *   A. 把 `\U+XXXX` 就地换成真字符，整体按 UTF-8 写回（R2004 规范就是 UTF-8）；
 *   B. 把每张表的网格（LWPOLYLINE）和单元格文字（TEXT，居中/垂直居中）**作为真实实体注回 ENTITIES**，
 *      这样表格就是原生 WebGL 几何，跟其它图元一样参与批处理，不需要额外的叠加层。
 * 句柄从文件内最大句柄 +1 递增，不会撞号。
 */
import fs from "node:fs";
import path from "node:path";

import { flattenTexts, DIAMETER_CHAR } from "./block-text.js";

/* ─────────────────── ACAD_TABLE 原始扫描（本模块内置）───────────────────
 * 为什么必须单独处理（2026-10-18 实测，勿删）：cadcraft 0.7.0 会把表格的
 * **网格线**画出来，但**单元格文字一个都不画** ——
 *   仅表格导出：63 张表 → 4,141 条 polyline（全部 stroke-width 统一 754.19，
 *               2~16 个顶点，纯网格），`<path>` = 0 条；
 *   仅文字导出：3,522 条 TEXT/MTEXT → 152MB 字形几何（13,261 path + 19,056 polyline）。
 * 而且它没有 explode 能力（`explode {"handles":["88F"]}` 返回空、表还在），
 * `tableexport` 只给文本不给几何。所以只能自己扫 DXF 把单元格的字读出来、按格位摆。
 *
 * ACAD_TABLE 关键块码（以 88F 实测）：
 *   2 块名  10/20 插入点（表格**左上角**）  11/21 方向向量（旋转）
 *   91 行数  92 列数  141×行数 行高  142×列数 列宽
 *   每格：171 开始  …  140 字高  1 文字（可能带 MTEXT 格式码，如 {\C256;KW}）
 * 行自插入点向下排（DXF y 递减），列自插入点向右排。
 */
const gbkDecoder = (() => {
  try {
    return new TextDecoder("gbk", { fatal: false });
  } catch {
    return null;
  }
})();
/** 严格 UTF-8：cadcraft 的产出两种都有 —— 纯 ASCII + `\U+` 转义，或真 UTF-8。
 *  逐值试解，成功即用 UTF-8；失败才按 GBK（老 ANSI 图）。 */
const utf8Strict = (() => {
  try {
    return new TextDecoder("utf-8", { fatal: true });
  } catch {
    return null;
  }
})();
const decodeDxfText = (vb) => {
  if (utf8Strict) {
    try {
      return utf8Strict.decode(vb);
    } catch {
      /* 不是 UTF-8，落到下面按 GBK 解 */
    }
  }
  return gbkDecoder ? gbkDecoder.decode(vb) : vb.toString("utf8");
};

/** 单元格文字里的 MTEXT 格式码/转义全部抹掉，只留可见字符 */
const cleanCellText = (raw) => {
  let t = raw;
  t = t.replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  for (let prev = null; prev !== t; ) {
    prev = t;
    t = t.replace(/\{[^{}]*;/g, "");
  }
  t = t.replace(/[{}]/g, "");
  t = t.replace(/\\P/g, " ").replace(/\\~/g, " ");
  t = t.replace(/\\[A-Za-z][^;\\]*;/g, "");
  t = t
    .replace(/%%C/gi, DIAMETER_CHAR)
    .replace(/%%D/gi, "°")
    .replace(/%%P/gi, "±")
    .replace(/%%%/g, "%")
    .replace(/%%([0-9]{3})/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
  return t.trim();
};

/** 逐行吐 [code, valueBuffer]；DXF 是"码行/值行"严格交替的文本 */
function* dxfPairs(buf, from, to) {
  let i = from;
  while (i < to) {
    let e = buf.indexOf(10, i);
    if (e < 0 || e > to) e = to;
    let ce = e > i && buf[e - 1] === 13 ? e - 1 : e;
    const code = buf.toString("latin1", i, ce).trim();
    i = e + 1;
    if (i >= to) return;
    let e2 = buf.indexOf(10, i);
    if (e2 < 0 || e2 > to) e2 = to;
    const ve = e2 > i && buf[e2 - 1] === 13 ? e2 - 1 : e2;
    yield [code, buf.subarray(i, ve)];
    i = e2 + 1;
  }
}

/**
 * 扫 DXF 取所有 ACAD_TABLE 的原始几何（**DXF 坐标，未做任何平移**）。
 * 单元格文字/行高/列宽/插入点/方向/图层/颜色全部原样吐出，
 * 供 buildTableEntities 注回 DXF 给 WebGL 引擎。
 */
function scanTables(dxfPath) {
  let buf;
  try {
    buf = fs.readFileSync(dxfPath);
  } catch {
    return [];
  }
  // 只在 ENTITIES 段里找（CLASSES 段也会出现 ACAD_TABLE 字样，但那是码 1）
  let from = 0;
  let to = buf.length;
  const ent = buf.indexOf(Buffer.from("\nENTITIES", "latin1"));
  if (ent >= 0) {
    const nl = buf.indexOf(10, ent + 1);
    from = nl >= 0 ? nl + 1 : ent;
    const end = buf.indexOf(Buffer.from("\nENDSEC", "latin1"), from);
    if (end > from) to = end;
  }

  const tables = [];
  let t = null;
  const flush = () => {
    if (!t) return;
    const cur = t;
    t = null;
    if (!cur.rows || !cur.cols || cur.rows > 512 || cur.cols > 512) return;
    if (!cur.cells.length) return;
    tables.push(cur);
  };

  for (const [code, vb] of dxfPairs(buf, from, to)) {
    if (code === "0") {
      const v = vb.toString("latin1").trim();
      if (v === "ACAD_TABLE") {
        flush();
        t = {
          ins: [0, 0],
          dir: null,
          rows: 0,
          cols: 0,
          rowH: [],
          colW: [],
          cells: [],
          layer: "0",
          aci: 7,
        };
      } else if (t) {
        flush();
      }
      continue;
    }
    if (!t) continue;
    switch (code) {
      case "8":
        if (!t.cells.length) t.layer = vb.toString("latin1").trim();
        break;
      case "62":
        if (!t.cells.length) t.aci = +vb.toString("latin1") || 7;
        break;
      case "10":
        if (!t.ins[0]) t.ins[0] = +vb.toString("latin1");
        break;
      case "20":
        if (!t.ins[1]) t.ins[1] = +vb.toString("latin1");
        break;
      case "11":
        if (!t.dir) t.dir = [1, 0];
        else t.dir[0] = +vb.toString("latin1");
        break;
      case "21":
        if (!t.dir) t.dir = [1, 0];
        t.dir[1] = +vb.toString("latin1");
        break;
      case "91":
        if (!t.rows && !t.cells.length) t.rows = +vb.toString("latin1") || 0;
        break;
      case "92":
        if (!t.cols && !t.cells.length) t.cols = +vb.toString("latin1") || 0;
        break;
      case "141":
        if (!t.cells.length) t.rowH.push(+vb.toString("latin1") || 0);
        break;
      case "142":
        if (!t.cells.length) t.colW.push(+vb.toString("latin1") || 0);
        break;
      case "171":
        t.cells.push({ h: 0, text: "" });
        break;
      case "140":
        if (t.cells.length) t.cells[t.cells.length - 1].h = +vb.toString("latin1") || 0;
        break;
      case "1":
        if (!t.cells.length) t.cells.push({ h: 0, text: "" });
        t.cells[t.cells.length - 1].text = decodeDxfText(vb);
        break;
      default:
        break;
    }
  }
  flush();
  return tables;
}

/** 改产出格式（注入规则/解码规则）就 +1，缓存文件名随之变化，旧文件自动失效 */
export const DXF_WEB_VERSION = 13; // v13: 顶层 ATTRIB 字高按 ATTDEF 模板判形态，避免缩放乘两次（旋转楼梯图字糊成一片）

/** 聚焦时"变灰"用的 ACI 颜色（8 = 深灰）。想调成其它灰度改这一个常量即可。 */
export const FOCUS_MUTED_COLOR = 8;

/**
 * 解析 `focus` 查询串：`layer:<图层名>` | `block:<图块名>`。
 * 非法（缺冒号/未知前缀/空名）一律返回 null —— 上层当作"无聚焦"处理，绝不影响开图。
 */
export function parseFocus(spec) {
  if (typeof spec !== "string") return null;
  const i = spec.indexOf(":");
  if (i <= 0) return null;
  const kind = spec.slice(0, i);
  const name = spec.slice(i + 1);
  if (!name) return null;
  if (kind !== "layer" && kind !== "block") return null;
  return { kind, name, spec };
}

/**
 * 聚焦涂灰：把"不属于聚焦目标"的实体颜色改成 FOCUS_MUTED_COLOR。
 *
 * ⚠️ 必须连 BLOCKS 段一起改，不能简化成"只改 INSERT 的 62"：
 *    块内实体的颜色只有在"自身图层为 0 / ByLayer"时才继承 INSERT；一旦实体自己画在真实
 *    图层上，改 INSERT 的 62 对它毫无作用。真实图纸里这很常见：块整体画在某个专用图层上，
 *    块内实体几乎全都不是 0 层。
 *    只改 INSERT → 该块的所有实例一个都不会变灰，功能等于没做。
 *
 * 规则：
 *   · focus=layer:X —— 按实体**自己的图层**判断；块内图层 0 的不动（它随 INSERT 继承，
 *     而 INSERT 的 62 已被本函数改掉）。
 *   · focus=block:X —— 聚焦块**可达**的块定义（含嵌套）保持原样，其余块定义内部一律涂灰；
 *     顶层只保留引用 X 的 INSERT。
 *
 * 已知边界：同一块定义同时被"聚焦块内部"和"顶层"引用时，共享定义上的颜色无法同时满足两边，
 *   此时以"聚焦块可达"为准，顶层那处会漏亮。
 */
function applyFocus(s, focus) {
  if (!focus) return { text: s, muted: 0, kept: 0 };

  // block 聚焦可能对应多个名字：原块名 + 被并入的匿名表示块名（*U8…）
  const focusNames =
    focus.kind === "block"
      ? new Set(
          Array.isArray(focus.names) && focus.names.length
            ? focus.names
            : [focus.name]
        )
      : null;

  const eol = s.includes("\r\n") ? "\r\n" : "\n";
  const lines = s.split(/\r?\n/);
  const pairs = pairLines(lines);

  /* ① 组码对归到实体上，记住它属于哪个段、哪个块定义 */
  const ents = [];
  let section = null;
  let pendingSec = false;
  let block = null;
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const e = cur;
    cur = null;
    if (e.type === "BLOCK") {
      const p2 = e.pairs.find((x) => x.c === 2);
      block = p2 ? p2.v.trim() : null;
    } else if (e.type === "ENDBLK") {
      block = null;
    } else if (e.type !== "SECTION" && e.type !== "ENDSEC") {
      ents.push(e);
    }
  };
  for (const p of pairs) {
    if (p.c === 0) {
      flush();
      cur = { type: p.v.trim(), section, block, pairs: [] };
      if (cur.type === "SECTION") pendingSec = true;
      continue;
    }
    if (pendingSec && p.c === 2) {
      section = p.v.trim();
      pendingSec = false;
      continue;
    }
    if (cur) cur.pairs.push(p);
  }
  flush();

  /* ② focus=block 的"可达块定义"闭包（含嵌套） */
  const blockRefs = new Map();
  for (const e of ents) {
    if (!e.block || e.type !== "INSERT") continue;
    const p2 = e.pairs.find((x) => x.c === 2);
    if (!p2) continue;
    if (!blockRefs.has(e.block)) blockRefs.set(e.block, new Set());
    blockRefs.get(e.block).add(p2.v.trim());
  }
  const reach = new Set();
  if (focus.kind === "block") {
    for (const n of focusNames) reach.add(n);
    for (let grew = true; grew; ) {
      grew = false;
      for (const d of [...reach]) {
        for (const r of blockRefs.get(d) || []) {
          if (!reach.has(r)) {
            reach.add(r);
            grew = true;
          }
        }
      }
    }
  }

  /* ③ 决策：只处理 BLOCKS / ENTITIES 两段里带图层码的实体 */
  const replace = new Map();
  const insertAfter = new Map();
  let muted = 0;
  let kept = 0;
  for (const e of ents) {
    if (e.section !== "BLOCKS" && e.section !== "ENTITIES") continue;
    const pLayer = e.pairs.find((x) => x.c === 8);
    if (!pLayer) continue;
    const layer = pLayer.v.trim();
    let mute;
    if (focus.kind === "layer") {
      mute = e.block && layer === "0" ? false : layer !== focus.name;
    } else if (e.block) {
      mute = !reach.has(e.block);
    } else {
      const p2 = e.type === "INSERT" ? e.pairs.find((x) => x.c === 2) : null;
      mute = !(p2 && focusNames.has(p2.v.trim()));
    }
    if (!mute) {
      kept++;
      continue;
    }
    muted++;
    const p62 = e.pairs.find((x) => x.c === 62);
    if (p62) replace.set(p62.vi, String(FOCUS_MUTED_COLOR));
    else insertAfter.set(pLayer.vi, ["62", String(FOCUS_MUTED_COLOR)]);
  }

  if (!muted) return { text: s, muted, kept };

  /* ④ 一次性重建行数组（按行号升序做插入/替换，避免索引漂移） */
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(replace.has(i) ? replace.get(i) : lines[i]);
    const ins = insertAfter.get(i);
    if (ins) out.push(ins[0], ins[1]);
  }
  return { text: out.join(eol), muted, kept };
}

const f = (v) => {
  // DXF 数值不要科学计数法，也不要 -0
  const s = Number.isInteger(v) ? String(v) : v.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
};

/** 文件里现有最大句柄，注入实体从这里往后排。
 *  句柄出现在码 5/105 的值行 —— 不能用"隔行取码"硬推，
 *  直接顺序扫：上一行是 5/105 就把这一行当句柄解析。 */
function maxHandle(text) {
  const lines = text.split(/\r?\n/);
  let max = 0;
  let prev = "";
  for (const line of lines) {
    const t = line.trim();
    if (prev === "5" || prev === "105") {
      const h = parseInt(t, 16);
      if (Number.isFinite(h) && h > max) max = h;
    }
    prev = t;
  }
  return max || 0x100;
}

/** LAYER 表里的层名集合，注入实体只往这些层上放（不存在的层名会让引擎取不到图层对象） */
function layerNames(text) {
  const out = new Set(["0"]);
  const t0 = text.indexOf("\nTABLES");
  if (t0 < 0) return out;
  const t1 = text.indexOf("\nENDSEC", t0);
  const seg = text.slice(t0, t1 < 0 ? undefined : t1);
  const rows = seg.split(/\r?\n/);
  for (let i = 0; i + 1 < rows.length; i++) {
    if (rows[i].trim() === "0" && rows[i + 1].trim() === "LAYER") {
      // 层名在紧接着的 2 值行（可能在 100/AcDbSymbolTableRecord 之后）
      for (let j = i + 2; j < Math.min(i + 40, rows.length - 1); j += 2) {
        if (rows[j].trim() === "2") {
          out.add(rows[j + 1].trim());
          break;
        }
      }
    }
  }
  return out;
}

const TBL_LAYER = "0"; // 表格注入后落在自己的层上；层不存在时退回 0

/**
 * 生成注入用的实体文本（DXF 组码对）。
 * 表格坐标系：插入点 = 左上角，u = 方向向量（默认 +X），v = u 顺时针 90°（表格向下方向）
 */
function buildTableEntities(tables, layers, startHandle, focus) {
  const out = [];
  let h = startHandle;
  const push = (...rows) => {
    for (const r of rows) out.push(r);
  };

  for (const t of tables) {
    const { ins, rows, cols, rowH, colW, cells, aci } = t;
    if (!rows || !cols) continue;
    const layer = layers.has(t.layer) ? t.layer : TBL_LAYER;
    let color = Number.isFinite(aci) && aci > 0 && aci < 256 ? aci : 7;
    // 表格不属于任何图块：focus=block 时一律涂灰；focus=layer 时按所在图层判断
    if (focus && !(focus.kind === "layer" && layer === focus.name)) color = FOCUS_MUTED_COLOR;

    const dir = t.dir || [1, 0];
    const len = Math.hypot(dir[0], dir[1]) || 1;
    const u = [dir[0] / len, dir[1] / len];
    const v = [u[1], -u[0]]; // 表格"向下"
    const at = (dx, dy) => [ins[0] + u[0] * dx + v[0] * dy, ins[1] + u[1] * dx + v[1] * dy];

    const sum = (arr, n) => {
      let s = 0;
      for (let i = 0; i < n && i < arr.length; i++) s += arr[i];
      return s;
    };
    const totalH = sum(rowH, rows);
    const totalW = sum(colW, cols);
    const rot = (Math.atan2(u[1], u[0]) * 180) / Math.PI;

    const addLine = (x1, y1, x2, y2) => {
      push(
        "0", "LWPOLYLINE",
        "5", (h++).toString(16).toUpperCase(),
        "100", "AcDbEntity",
        "8", layer,
        "62", String(color),
        "100", "AcDbPolyline",
        "90", "2",
        "70", "0",
        "10", f(x1), "20", f(y1),
        "10", f(x2), "20", f(y2),
      );
    };

    // 网格：rows+1 条横线、cols+1 条竖线
    for (let k = 0; k <= rows; k++) {
      const [x1, y1] = at(0, sum(rowH, k));
      const [x2, y2] = at(totalW, sum(rowH, k));
      addLine(x1, y1, x2, y2);
    }
    for (let k = 0; k <= cols; k++) {
      const [x1, y1] = at(sum(colW, k), 0);
      const [x2, y2] = at(sum(colW, k), totalH);
      addLine(x1, y1, x2, y2);
    }

    // 单元格文字：10/20 与 11/21 都给格心，72=1（居中）73=2（垂直居中）
    for (let row = 0; row < rows; row++) {
      const hRow = rowH[row] ?? rowH[rowH.length - 1] ?? 0;
      const top = sum(rowH, row);
      for (let col = 0; col < cols; col++) {
        const cell = cells[row * cols + col];
        if (!cell) continue;
        // ⚠️ 必须清掉 MTEXT 格式码：单元格原文是 `{\C256;KW}` 这种，
        //    注进去当 TEXT 会被当成字面量渲染成 `C256;KW`（实测截图里满格乱码）
        const text = cleanCellText(cell.text || "");
        if (!text) continue;
        const wCol = colW[col] ?? colW[colW.length - 1] ?? 0;
        const hh = cell.h > 0 ? cell.h : hRow * 0.5;
        if (!hh) continue;
        const [cx, cy] = at(sum(colW, col) + wCol / 2, top + hRow / 2);
        push(
          "0", "TEXT",
          "5", (h++).toString(16).toUpperCase(),
          "100", "AcDbEntity",
          "8", layer,
          "62", String(color),
          "100", "AcDbText",
          "10", f(cx), "20", f(cy), "30", "0.0",
          "40", f(hh),
          "1", text,
          "50", f(rot),
          "72", "1",
          "73", "2",
          "11", f(cx), "21", f(cy), "31", "0.0",
        );
      }
    }
  }
  return out;
}

/**
 * 删掉 BLOCKS 段里的 TEXT / MTEXT。
 *
 * 为什么：dxf-viewer 渲染块内文字时完全不用块变换（见 block-text.js 顶部说明），
 * 留着它们只会在世界原点附近堆一堆 0.01 大小的垃圾三角（实测 6MB 顶点）。
 * 这些字我们已经按每个 INSERT 实例展开成顶层 TEXT 注回去了，一份不多一份不少。
 * @returns {{del:Set<number>, count:number}}
 */
/**
 * 把整份文件切成实体区间（起止行号）。
 *
 * ⚠️ 必须用"下一个 `0` 码行"当边界，绝不能靠 `行数 = 2*(组码对+1)` 去推算 ——
 * ATTRIB / SEQEND 里带 XDATA（1001/1000）时对数好算，但一旦某处估错一行，
 * 后面整份文件的组码/值就全部错位，解析器报 `Cannot parse group code: AcDbText`
 * 并且整张图白屏（2026-10-18 踩过）。
 */
function entityRanges(pairs, lineCount) {
  const out = [];
  for (let k = 0; k < pairs.length; k++) {
    if (pairs[k].c !== 0) continue;
    let j = k + 1;
    while (j < pairs.length && pairs[j].c !== 0) j++;
    out.push({
      type: pairs[k].v.trim(),
      start: pairs[k].ci,
      end: j < pairs.length ? pairs[j].ci : lineCount,
    });
    k = j - 1;
  }
  return out;
}

/**
 * 删掉 BLOCKS 段里的 TEXT / MTEXT。
 *
 * 为什么：dxf-viewer 渲染块内文字时完全不用块变换（见 block-text.js 顶部说明），
 * 留着它们只会在世界原点附近堆一堆 0.01 大小的垃圾三角（实测 6MB 顶点）。
 * 这些字我们已经按每个 INSERT 实例展开成顶层 TEXT 注回去了，一份不多一份不少。
 * @returns {{del:Set<number>, count:number}}
 */
function collectBlockTextLines(lines) {
  const del = new Set();
  const pairs = pairLines(lines);
  const ranges = entityRanges(pairs, lines.length);

  let section = null;
  let inBlock = false;
  let count = 0;

  for (let k = 0; k < pairs.length; k++) {
    const p = pairs[k];
    if (p.c === 2 && k > 0 && pairs[k - 1].c === 0 && pairs[k - 1].v.trim() === "SECTION") {
      section = p.v.trim();
    }
  }
  void section;

  /* 段归属：按行号二分不了的，就顺序走一遍 pair 流 */
  let sec = null;
  for (let k = 0; k < pairs.length; k++) {
    const p = pairs[k];
    if (p.c === 2 && k > 0 && pairs[k - 1].c === 0 && pairs[k - 1].v.trim() === "SECTION") {
      sec = p.v.trim();
      continue;
    }
    if (p.c !== 0) continue;
    const t = p.v.trim();
    if (t === "BLOCK") {
      inBlock = true;
    } else if (t === "ENDBLK") {
      inBlock = false;
    } else if (sec === "BLOCKS" && inBlock && (t === "TEXT" || t === "MTEXT")) {
      const r = ranges.find((x) => x.start === p.ci);
      if (!r) continue;
      for (let i = r.start; i < r.end; i++) del.add(i);
      count++;
    }
  }
  return { del, count };
}

/**
 * 找出所有 ATTRIB 实体（连同紧跟的 SEQEND），供上层整段删除。
 *
 * 为什么删：属性文字我们已经用 `block-text.js` 展开成世界坐标的 TEXT 注回去了，
 * 留着原 ATTRIB 只会让 dxf-viewer 用**块内字高**（0.012）在原地画一堆看不见的小点，
 * 而且 84% 的属性 70 组码带 invisible 位会被引擎整条丢弃。删掉最干净。
 * @returns {{del:Set<number>, count:number}}
 */
function collectAttribLines(lines) {
  const del = new Set();
  const pairs = pairLines(lines);
  const ranges = entityRanges(pairs, lines.length);
  let count = 0;
  for (let k = 0; k < ranges.length; k++) {
    if (ranges[k].type !== "ATTRIB") continue;
    for (let i = ranges[k].start; i < ranges[k].end; i++) del.add(i);
    count++;
    if (ranges[k + 1]?.type === "SEQEND") {
      for (let i = ranges[k + 1].start; i < ranges[k + 1].end; i++) del.add(i);
      k++;
    }
  }
  return { del, count };
}


/** 展开出来的块内文字 → 顶层 TEXT 实体 */
function buildBlockTextEntities(items, layers, startHandle, focus) {
  const out = [];
  let h = startHandle;
  const hl = ["left", "center", "right"];
  void hl;
  // 与 applyFocus 一致：block 聚焦按名字集合（原块 + 被并入的匿名表示块）
  const focusNames =
    focus && focus.kind === "block"
      ? new Set(
          Array.isArray(focus.names) && focus.names.length
            ? focus.names
            : [focus.name]
        )
      : null;
  for (const it of items) {
    const text = String(it.text || "").replace(/[\r\n]+/g, " ").trim();
    if (!text || !(it.h > 0)) continue;
    const layer = layers.has(it.layer) ? it.layer : "0";
    let color = Number.isFinite(it.aci) && it.aci > 0 && it.aci < 256 ? it.aci : 7;
    // 注入文字按"原始所属图块"归属（block-text.js 的 flattenTexts 已带 block 字段）
    if (focus) {
      const keep =
        focus.kind === "block" ? focusNames.has(it.block) : layer === focus.name;
      if (!keep) color = FOCUS_MUTED_COLOR;
    }
    const align = Number(it.halign) || 0;
    const valign = Number(it.valign) || 0;
    // 非左/基线对齐时，DXF 用 11/21 的第二点定位；没有就用第一点
    const ax = Number.isFinite(it.ax) ? it.ax : it.x;
    const ay = Number.isFinite(it.ay) ? it.ay : it.y;
    const rows = [
      "0", "TEXT",
      "5", (h++).toString(16).toUpperCase(),
      "100", "AcDbEntity",
      "8", layer,
      "62", String(color),
      "100", "AcDbText",
      "10", f(it.x), "20", f(it.y), "30", "0.0",
      "40", f(it.h),
      "1", text,
    ];
    if (it.rot) rows.push("50", f(it.rot));
    if (it.wf && Math.abs(it.wf - 1) > 1e-6) rows.push("41", f(it.wf));
    if (align || valign) {
      rows.push("72", String(align), "73", String(valign), "11", f(ax), "21", f(ay), "31", "0.0");
    }
    out.push(rows.join("\r\n"));
  }
  return out;
}



/* ============================================================================
 * 属性块（INSERT + ATTRIB）文字烘焙 —— 2026-10-18 实测定位的缺字主因
 *
 * 现象：WebGL 下电气专业那批设备标注（"应急照明配电箱""动力配电、控制箱"…）几乎全不见，
 *      画面上只剩零星几个字，用户对比 CAD 原图说"还是有些文字丢失"。
 *
 * 取证（不是推断，是数出来的）：
 *   · 本图顶层 ATTRIB 2680 条，其中 **1885 条组码 70 带 bit0（不可见）**，
 *     dxf-viewer 的 `_FilterEntity()` 见 `entity.hidden` 直接整条丢弃 → 连字都不进渲染管线；
 *   · 剩下的 795 条虽然进了管线，但**字高是块内模板值**（0.012），插入缩放到 600 倍后
 *     应该是 7.2 世界单位 —— `_DecomposeAttribute()` 只做 `textHeight * entity.scale`，
 *     `entity.scale` 是属性自己的组码 41（宽度因子，通常 1），**不乘 INSERT 的 41/42**。
 *     结果：字高小 600 倍，在 32 万 × 180 万的图纸上就是一个亚像素点，等于不可见。
 *
 * 判据（为什么不能无脑 ×scale）：同一张图里两种都有 ——
 *   · 未烘焙：40 = 0.0202500，块内 ATTDEF 的 40 也是 0.0202500 → 必须 ×1518.75 = 30.755；
 *   · 已烘焙：40 = 303.75（"EF-RT"），再 ×1518.75 会炸成 46 万。
 *   所以按「块内同 tag 的 ATTDEF 模板字高」反推：更接近模板值的是未烘焙，更接近
 *   「模板值 × 插入缩放」的是已烘焙。
 *
 * 隐藏位：属性 70 与块内 ATTDEF 的 70 **完全一致**时（本图 9 = 不可见+预设，1387+868 条），
 *   这是 cadcraft 从 DWG 导出时把模板标志原样复制下来的产物，不是"用户真把属性设成不可见"，
 *   一律清掉 bit0 —— 否则那批属性标注还是看不见。
 * ========================================================================== */

/** `\U+XXXX` → 真字符（只处理 4 位十六进制，CAD 的转义标准就是 4 位） */
const decodeUnicodeEscapes = (s) => s.replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, x) => String.fromCharCode(parseInt(x, 16)));

/** 组码/值配对（带行号），空行与脏行自动跳过不错位 */
function pairLines(lines) {
  const pairs = [];
  let i = 0;
  while (i < lines.length) {
    const c = lines[i].trim();
    if (!/^-?\d+$/.test(c)) {
      i++;
      continue;
    }
    pairs.push({ c: Number(c), v: lines[i + 1] ?? "", ci: i, vi: i + 1 });
    i += 2;
  }
  return pairs;
}

/** 按 `0/<类型>` 切实体 */
function splitEntities(pairs) {
  const out = [];
  let cur = null;
  for (let k = 0; k < pairs.length; k++) {
    const p = pairs[k];
    if (p.c === 0) {
      if (cur) out.push(cur);
      cur = { type: p.v.trim(), pairs: [] };
    } else if (cur) {
      cur.pairs.push(p);
    }
  }
  if (cur) out.push(cur);
  return out;
}

const firstVal = (ent, code, dflt = "") => {
  const p = ent.pairs.find((x) => x.c === code);
  return p ? p.v.trim() : dflt;
};
const numVal = (ent, code, dflt = 0) => {
  const p = ent.pairs.find((x) => x.c === code);
  if (!p) return dflt;
  const v = Number(p.v);
  return Number.isFinite(v) ? v : dflt;
};

/** 图纸主体范围（同目录 meta.json 里 cadcraft 算好的 contentBox）；拿不到就返回 null */
function contentBoxOf(srcPath) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(path.dirname(srcPath), "meta.json"), "utf8"));
    return m?.stats?.contentBox ?? null;
  } catch {
    return null;
  }
}

/**
 * 展开出来的文字要过一道合理性筛，在"变换后的世界坐标候选"与"raw 原样候选"（块内坐标/块内字高）
 * 之间取舍，并滤掉明显垃圾。
 *
 * 背景（2026-10-18 实测）：cadcraft 导出的 DXF 里"块内字高/坐标"有两种形态混着——
 * 有的块是标准块内坐标（字高 0.012，必须乘插入缩放），有的块字高已经是世界值（350），
 * 再乘一次 700 的缩放就成 245,000。没有元数据能区分，只能用**结果合理性**兜底。
 *
 * 2026-10-19 收紧（v12）：旧实现给两个候选各打"分"、**分低者胜**，导致约 46% 的文字被误判为
 * "raw 更可信"而退回块内坐标/块内字高（位置/大小明显错），并且把约 4.7% 本来合规的文字丢掉。
 * 新规则保守且阈值含义明确：
 *   · 近邻容忍区 = contentBox 各向外扩 50%（"看着合理"的位置范围）；
 *   · 明显越界 = contentBox 各向外扩**整整一个自身尺寸**（只有这么远的才叫越界）；
 *   · **默认信任变换后的候选**：只要它位置在容忍区内、字高不为零即保留；
 *   · 只有变换后候选"明显越界或字高离谱"、且 raw 候选合理时，才改用 raw；
 *   · 仅当**两个候选的位置都明显越界**（都飞到图纸外）才丢弃 —— 位置是唯一可靠的垃圾信号，
 *     字高单独不可靠（本图实测救回的属性标注字高普遍偏小，绝不能因为字高就把它们丢掉）。
 * 实测（09bb）：旧规则 944/2040 选了 raw；新规则在 3707 条上只有 267 条改 raw，
 * 丢弃从"按字高连带误丢"收敛为"只丢两边位置都出界的垃圾"。
 */
function filterFlatTexts(items, cbox, stats = null) {
  const done = (kept, raw, dropped) => {
    if (stats) Object.assign(stats, { kept, raw, dropped });
  };
  if (!cbox || !(cbox.height > 0)) {
    done(items.length, 0, 0);
    return items;
  }
  const hMin = cbox.height / 40000;
  const hMax = cbox.height / 80;
  // 近邻容忍区（外扩 50%）：位置"看着合理"
  const zx0 = cbox.minX - cbox.width * 0.5;
  const zx1 = cbox.maxX + cbox.width * 0.5;
  const zy0 = cbox.minY - cbox.height * 0.5;
  const zy1 = cbox.maxY + cbox.height * 0.5;
  // "明显越界"（外扩 100%）：只有这么远才叫越界
  const ox0 = cbox.minX - cbox.width;
  const ox1 = cbox.maxX + cbox.width;
  const oy0 = cbox.minY - cbox.height;
  const oy1 = cbox.maxY + cbox.height;

  const inZone = (x, y) => x >= zx0 && x <= zx1 && y >= zy0 && y <= zy1;
  const hOk = (h) => h >= hMin && h <= hMax;
  const posFar = (x, y) => x < ox0 || x > ox1 || y < oy0 || y > oy1; // 位置明显越界
  const plausible = (x, y, h) => inZone(x, y) && hOk(h);

  const out = [];
  let kept = 0;
  let raw = 0;
  let dropped = 0;
  for (const it of items) {
    if (plausible(it.x, it.y, it.h)) {
      out.push(it); // 默认信任变换后的世界坐标候选
      kept++;
      continue;
    }
    const r = it.raw;
    const bOk = r ? plausible(r.x, r.y, r.h) : false;
    // 仅当变换后候选"明显越界或字高离谱"、且 raw 合理时，才退回 raw（默认仍倾向变换后候选）
    if (bOk && (posFar(it.x, it.y) || !hOk(it.h))) {
      out.push({ ...it, x: r.x, y: r.y, ax: r.ax, ay: r.ay, h: r.h, rot: r.rot });
      raw++;
      continue;
    }
    // 只有两个候选的位置都明显越界才丢弃（真正的垃圾），字高不作为丢弃依据
    if (posFar(it.x, it.y) && (r ? posFar(r.x, r.y) : true)) {
      dropped++;
      continue;
    }
    out.push(it); // 其余（如字高偏小的属性标注）保守保留变换后的候选
    kept++;
  }
  done(kept, raw, dropped);
  return out;
}

/**
 * 产出可直接给 dxf-viewer 吃的 DXF。
 * @returns {{bytes:number, entities:number, tables:number, cells:number, decoded:number, encoding:string}}
 */
export function buildWebDxf(srcPath, outPath, focus = null) {
  const buf = fs.readFileSync(srcPath);

  /* 编码必须自适应（2026-10-18 实测，勿删）：
   *   cadcraft 的产出不统一 —— 小图是**纯 ASCII + `\U+XXXX` 转义**（9.4MB 那份 0 个高位字节、
   *   2024 条文字带转义），而 91MB 那份是**真的 UTF-8 中文**（93 万个高位字节、0 条转义）。
   *   原来一律按 latin1 读再按 UTF-8 写，会把后者二次编码成乱码。
   *   所以：先严格试 UTF-8；失败才当 GBK（R2004 以前的 ANSI 图）。
   */
  let s;
  let encoding;
  try {
    s = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    encoding = "utf-8";
  } catch {
    try {
      s = new TextDecoder("gbk").decode(buf);
      encoding = "gbk";
    } catch {
      s = buf.toString("utf8");
      encoding = "utf-8(loose)";
    }
  }

  const before = (s.match(/\\U\+[0-9A-Fa-f]{4}/g) || []).length;
  s = decodeUnicodeEscapes(s);

  /* `%%C`（直径控制码）统一字面：dxf-viewer 自带的 ParseSpecialChars 会把残余的 `%%C`
   * 映射成 U+2205（∅），而 U+2205 在它加载的 simfang.ttf 里**没有字形** → 实际画成 "?"；
   * 我们注入的表格/块内文字却用 φ，两处字面不一致（实测：原图 "?" vs 注入 φ）。
   * 交给 dxf-viewer 之前把整份文件里的 `%%C` 预替换成同一个字符 DIAMETER_CHAR(φ)，
   * 它就不会再走自己的映射。只碰 `%%C`，`%%D`/`%%P`/`%%%`/`\U+` 转义一概不动。 */
  const diameterFixed = (s.match(/%%C/gi) || []).length;
  if (diameterFixed) s = s.replace(/%%C/gi, DIAMETER_CHAR);

  /* ① 删掉全部原 ATTRIB（它们由 block-text.js 展开成世界坐标 TEXT 后重新注入）。
   *    不删的话引擎会按块内字高在原位置画一堆看不见的小点，纯垃圾。 */
  const attrLines = s.split(/\r?\n/);
  const { del: delAttr, count: attribRemoved } = collectAttribLines(attrLines);
  const { del: delBlkText, count: blockTextRemoved } = collectBlockTextLines(attrLines);
  for (const i of delBlkText) delAttr.add(i);
  if (delAttr.size) s = attrLines.filter((_, i) => !delAttr.has(i)).join("\r\n");

  /* ③ 聚焦涂灰（必须在注入之前：注入实体自己按 focus 决定颜色） */
  const focusResult = applyFocus(s, focus);
  s = focusResult.text;

  /* ② 展开块内文字（这是"属性块里的字画不出来"的正解） */
  const flat = flattenTexts(srcPath);
  const cbox = contentBoxOf(srcPath);
  const flatFilterStats = {};
  const blockTexts = filterFlatTexts(flat.items, cbox, flatFilterStats);

  const tables = scanTables(srcPath);
  const layers = layerNames(s);

  const start = maxHandle(s) + 1;
  const ents = buildTableEntities(tables, layers, start, focus);
  ents.push(...buildBlockTextEntities(blockTexts, layers, start + ents.length + 1, focus));
  let cells = 0;
  for (const t of tables) cells += t.cells.filter((c) => cleanCellText(c.text || "")).length;

  // 注入点：ENTITIES 段的 `0 / ENDSEC` 这对组码**之前**。
  // ⚠️ 不能插在 `0` 与 `ENDSEC` 之间 —— ENDSEC 是那个 0 码的值，
  //    插在中间会让它变成某个实体的类型名，解析器直接抛 "Cannot parse group code"。
  let at = -1;
  if (ents.length) {
    const e0 = s.indexOf("\nENTITIES");
    if (e0 >= 0) {
      const m = /(\r?\n)[ \t]*0\r?\nENDSEC/.exec(s.slice(e0));
      if (m) at = e0 + m.index + m[1].length;
    }
  }

  if (at >= 0) {
    const block = ents.join("\r\n") + "\r\n";
    s = s.slice(0, at) + block + s.slice(at);
  }

  // 注意：源文件是纯 ASCII（所有非 ASCII 都是 \U+ 转义），所以这里按 UTF-8 写回不会动任何原字节
  fs.writeFileSync(outPath, Buffer.from(s, "utf8"));

  return {
    bytes: fs.statSync(outPath).size,
    entities: ents.reduce((a, x) => a + (x === "0" ? 1 : 0), 0),
    tables: tables.length,
    cells,
    decoded: before,
    diameterFixed,
    encoding,
    attribRemoved,
    blockTextRemoved,
    blockTexts: blockTexts.length,
    flatTotal: flat.items.length,
    flatStats: flat.stats,
    flatDropped: flat.items.length - blockTexts.length,
    flatKept: flatFilterStats.kept ?? null,
    flatRaw: flatFilterStats.raw ?? null,
    flatFilterDropped: flatFilterStats.dropped ?? null,
    invisibleAttrib: flat.stats.invisibleAttrib ?? 0,
    rescuedAttrib: flat.stats.rescuedAttrib ?? 0,
    focus: focus ? focus.spec : null,
    focusMuted: focusResult.muted,
    focusKept: focusResult.kept,
  };
}
