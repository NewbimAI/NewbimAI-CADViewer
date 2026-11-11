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
 *   B. 把每张表的网格（LWPOLYLINE）和单元格文字（TEXT，居中/垂直居中；单线体模式下
 *      已按笔画注入 LWPOLYLINE）**作为真实实体注回 ENTITIES**，
 *      这样表格就是原生 WebGL 几何，跟其它图元一样参与批处理，不需要额外的叠加层。
 * 句柄从文件内最大句柄 +1 递增，不会撞号。
 *
 * v32 起另外接管三类引擎完全不认识的实体（解析器里 0 处匹配）与关闭图层：
 *   C. LEADER / MULTILEADER / MLINE → LWPOLYLINE / SOLID / TEXT（就地替换，见下方合成段说明）；
 *   D. LAYER 62<0（**关闭**）图层上的实体整段删除（见 filterHiddenLayers）。
 *      冻结层（70 bit1）保留：带尺寸的冻结层默认可见，其余仍隐藏（避免整层内容看起来像丢了），面板可手动打开。
 *
 * v45 起接管第三方插件的自定义实体（IAEC_* / IWT_*，类名 IcDb*）：
 *   E. 带 `310` 代理图形的自定义实体 → LWPOLYLINE / TEXT / SOLID（见 proxy-graphics.js）。
 *      机柜图/施工图的墙、房间文字、门窗、箭头只存在 310 里，不转换会被引擎整条丢弃。
 *      v46 起解出的文字直接渲染成 SHX 单线笔画（与图中其它 SHX 文字同一套字形），
 *      没法出字形时仍保留 TEXT 交回 TTF；其余图元不变。
 */
import fs from "node:fs";
import path from "node:path";

import DxfParser from "dxf-parser";

import { entityToPrimitives } from "../shared/geometry/index.mjs";
import { flattenTexts, DIAMETER_CHAR } from "./block-text.js";
import { detectCodepageFromText } from "./dxf-codepage.js";
import { createShxContext, renderShxText, mtextToPlainText, mtextAttachToAlign } from "./shx-text.js";
import { convertProxyGraphicsEntities } from "./proxy-graphics.js";
import { injectUdoGeometry, loadUdoDump } from "./udo-convert.js";

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

/* 非 UTF-8 时用哪张码页：由 `$DWGCODEPAGE` 决定，GBK 是兜底。
 * 之前写死 GBK，繁体（Big5）/日文（Shift-JIS）/韩文（EUC-KR）图纸会整片乱码。 */
let activeEncoding = "gbk";
const decoderCache = new Map();
const decoderFor = (enc) => {
  if (!enc) return null;
  let d = decoderCache.get(enc);
  if (d === undefined) {
    try {
      d = new TextDecoder(enc, { fatal: false });
    } catch {
      d = null;
    }
    decoderCache.set(enc, d);
  }
  return d;
};

/** 读头部定码页；$ACADVER ≥ AC1021 时声明的是 UTF-8，但既然严格 UTF-8 解不开，
 *  说明文件其实是老 ANSI，仍按码页走（此函数只在"非 UTF-8 分支"里调用）。 */
const resolveLegacyEncoding = (buf) => {
  try {
    const meta = detectCodepageFromText(buf.subarray(0, 128 * 1024).toString("latin1"));
    activeEncoding = meta.encoding && meta.encoding !== "utf-8" ? meta.encoding : "gbk";
  } catch {
    activeEncoding = "gbk";
  }
  return activeEncoding;
};

/** 严格 UTF-8：cadcraft 的产出两种都有 —— 纯 ASCII + `\U+` 转义，或真 UTF-8。
 *  逐值试解，成功即用 UTF-8；失败才按当前码页（默认 GBK）解。 */
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
      /* 不是 UTF-8，落到下面按码页解 */
    }
  }
  const d = decoderFor(activeEncoding) || gbkDecoder;
  return d ? d.decode(vb) : vb.toString("utf8");
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
  resolveLegacyEncoding(buf);
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
export const DXF_WEB_VERSION = 68; // v68 = 自定义对象命名统一（dump 文件名与 JSON 字段由 tch 改为 udo，旧缓存必须重建）
// v67 = 导出链路几何级 XCLIP 裁剪（buildExportDxf 专属；屏幕链路 buildWebDxf 一行未改，产物逐字节不变）
// v66: 新增导出专用 DXF（buildExportDxf：自定义对象注入 + 代理图形）
// v65: 门/窗语义按洞口底标高+层族判定；门型双扇/单扇/推拉按 T3 口径；注入几何 contentBox 自检
// v64: 块内天正对象按 origin.block 回注所属块定义（坐标减 origin.point 回到块内坐标），消除双重变换
// v63: 块内天正墙/洞口按所属块 INSERT 的平移落到世界坐标（载荷存块内坐标；解不出基准的一律 candidate 不画）
// v62: 天正尺寸线/界线/箭头几何（TDbDimension2 载荷给全 dim_line/ext_lines/ticks/text_point，端点与文字位置全部取自载荷）
// v61: 图外散点过滤（整盒落在 contentBox 外扩 3×对角线之外 → 默认不画，CADVIEWER_STRAY_FILTER=0 可关）
// v60: 仅版本占位（上一 lane 未落地过滤实现，产物等同 v59）
// v59: 天正 TDbDimension2 已解码数值文字注入（每个 segments[] 一条 TEXT，BYLAYER）
// v58: 天正几何按 owner 回注块定义（墙/洞口进 BLOCK，文字按 INSERT 链摊平）
// v57: 布局空间改用"先模型预处理再拷贝视口"（块文字/属性/单线笔画/表格/天正不再丢）
// v56: 回滚 XCLIP 标注守卫（v55 仅保留 AC1032 文字/符号注入）
// v55: AC1032（AutoCAD 2018）文字/符号注入
// v54: 天正对象按 TDb 类名匹配（TCH_* / AEC_* 伪装都注入）；probe 预筛改为 udo-cli probe
// v53: 自定义对象门符号（门扇线 + 90° 开启弧）+ 墙面线接头 miter/洞口裁剪/自由端封口
// v52: 自定义对象洞口/墙体/文字三类几何注入（udo-cli 解码 → LWPOLYLINE / 双面墙线 / TEXT）
// v51: 自定义对象洞口几何注入（udo-cli 解码的 TCH_OPENING → LWPOLYLINE）
// v50: 顶层 ATTRIB 无 ATTDEF 时字高不再乘 INSERT 缩放（机柜 DXF 巨大字形）；DXF 直开把 rec.stats.contentBox 传进文字过滤
// v49: XCLIP 过滤注入文字/笔画
// v46: 代理图形解出的 IAEC_TEXT 直接出 SHX 单线笔画（与图中其它 SHX 文字统一字形/字重）
// v45: IAEC_*/IWT_* 自定义实体的 310 代理图形 → LWPOLYLINE/TEXT/SOLID（墙/房间文字不再丢）
// v44: 块内尺寸（DIMENSION→*D 块）不再丢；布局视口保留 INSERT/DIMENSION 并用 XCLIP 裁剪

/** 汉字笔画加粗：线宽 = h × 该系数（CADVIEWER_STROKE_WIDTH 可覆盖） */
const STROKE_WIDTH_MULT = 0.055;

/** 全文件最多产出多少个加粗 SOLID 实体；超出的笔画退回细折线 */
export const STROKE_SOLID_LIMIT = 400000;

/** 聚焦时"变灰"用的 ACI 颜色（8 = 深灰）。想调成其它灰度改这一个常量即可。 */
export const FOCUS_MUTED_COLOR = 8;

/**
 * 解析 `focus` 查询串：`layer:<图层名>` | `block:<图块名>` | `mute:all`。
 * 非法（缺冒号/未知前缀/空名/`mute` 用别的名字）一律返回 null ——
 * 上层当作"无聚焦"处理，绝不影响开图。
 */
export function parseFocus(spec) {
  if (typeof spec !== "string") return null;
  const i = spec.indexOf(":");
  if (i <= 0) return null;
  const kind = spec.slice(0, i);
  const name = spec.slice(i + 1);
  if (!name) return null;
  if (kind !== "layer" && kind !== "block" && kind !== "mute") return null;
  /* mute 只有一个合法目标：all（对比模式两侧整体灰显）。别的名字当非法，不猜。 */
  if (kind === "mute" && name !== "all") return null;
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
 *   · focus=mute:all —— 对比模式：**所有**实体涂灰，不做任何保留（kept 恒为 0）。
 *     BLOCK/ENDBLK/SEQEND 这类结构记录不写 62（它们没有颜色语义）。
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

  /* ③ 决策：只处理 BLOCKS / ENTITIES 两段里的实体
   * `mute:all`（v32，对比用）例外：不带图层码的实体也要涂灰，锚点退到句柄/100 组码。 */
  const replace = new Map();
  const insertAfter = new Map();
  let muted = 0;
  let kept = 0;
  for (const e of ents) {
    if (e.section !== "BLOCKS" && e.section !== "ENTITIES") continue;
    const pLayer = e.pairs.find((x) => x.c === 8);
    let mute;
    if (focus.kind === "mute") {
      /* 对比模式：全部实体涂灰。BLOCK/ENDBLK/SEQEND 是结构记录（没有颜色语义），
       * 往它们身上写 62 只会给解析器添乱 —— 跳过。 */
      if (e.type === "BLOCK" || e.type === "ENDBLK" || e.type === "SEQEND") continue;
      mute = true;
    } else if (!pLayer) {
      continue;
    } else {
      const layer = pLayer.v.trim();
      if (focus.kind === "layer") {
        mute = e.block && layer === "0" ? false : layer !== focus.name;
      } else if (e.block) {
        mute = !reach.has(e.block);
      } else {
        const p2 = e.type === "INSERT" ? e.pairs.find((x) => x.c === 2) : null;
        mute = !(p2 && focusNames.has(p2.v.trim()));
      }
    }
    if (!mute) {
      kept++;
      continue;
    }
    muted++;
    const p62 = e.pairs.find((x) => x.c === 62);
    const anchor =
      pLayer || e.pairs.find((x) => x.c === 5 || x.c === 105) || e.pairs.find((x) => x.c === 100);
    if (p62) replace.set(p62.vi, String(FOCUS_MUTED_COLOR));
    else if (anchor) insertAfter.set(anchor.vi, ["62", String(FOCUS_MUTED_COLOR)]);
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
export function layerNames(text) {
  const out = new Set(["0"]);
  /* ⚠️ 不能用 `text.indexOf("\nTABLES")`：CLASSES 段里有 `1/TABLESTYLE`（字符串前缀相同），
   *    会命中错位置 → 整张表的层名一个都读不到（v32 实测 af7f93811f50：只剩 {"0"}，
   *    于是所有注入文字都被迫落到 0 层）。这里要求 TABLES 是**独立的值行**。 */
  const m = /(?:^|\n)[ \t]*2[ \t]*\r?\nTABLES[ \t]*(?=\r?\n|$)/.exec(text);
  if (!m) return out;
  let to = text.indexOf("\nENDSEC", m.index);
  if (to < 0) to = text.length;
  for (const [name] of layerTableInfo(text.slice(m.index, to))) out.add(name);
  return out;
}

/**
 * LAYER 表：层名 → ACI（组码 62 的绝对值；负数表示图层关闭）。
 * 与 layerNames() 不同，这里需要颜色值，供块内颜色烘焙使用。
 * 组码 420（真彩色）不换算成 ACI —— 只用于没有 ACI 时的兜底，见 bakeBlockColours。
 * @returns {Map<string, number>}
 */
export function layerAciTable(text) {
  const out = new Map();
  for (const [name, rec] of layerTableInfo(text)) out.set(name, rec.aci);
  return out;
}

/**
 * LAYER 表原始信息：层名 → { aci, raw, flags }。
 *   · `raw`   = 组码 62 原值（**负数**才是 DXF 规范的"图层关闭"）
 *   · `flags` = 组码 70（bit1 冻结、bit2 新视口冻结、bit4 锁定 —— 注意 bit4 是锁定，不是关闭）
 * `raw === null` 表示该记录没有 62（BYLAYER 默认色）。
 * @returns {Map<string, {aci:number, raw:number|null, flags:number}>}
 */
export function layerTableInfo(text) {
  const out = new Map();
  const lines = text.split(/\r?\n/);
  let inLayer = false;
  let rec = null;
  const flush = () => {
    if (rec && rec.name) out.set(rec.name, rec);
    rec = null;
  };
  for (const p of pairLines(lines)) {
    if (p.c === 0) {
      flush();
      inLayer = p.v.trim() === "LAYER";
      if (inLayer) rec = { name: null, aci: 7, raw: null, flags: 0 };
      continue;
    }
    if (!inLayer || !rec) continue;
    if (p.c === 2 && rec.name === null) rec.name = p.v.trim();
    else if (p.c === 62) {
      const n = Number(p.v);
      if (Number.isFinite(n)) {
        rec.raw = n;
        rec.aci = Math.abs(n) || 7;
      }
    } else if (p.c === 70) {
      const n = Number(p.v);
      if (Number.isFinite(n)) rec.flags = n;
    }
  }
  flush();
  return out;
}

/* ───────────────────── 隐藏图层过滤（v33）─────────────────────
 * 为什么必须在服务端做（2026-11-08 实测，勿删）：
 *
 * LAYER 表的"关闭（off）"在 DXF 里**只有一种**权威表示 —— 组码 62 为负数
 * （绝对值才是颜色号）。dxf-viewer 的 parser 会把它读成 layer.visible=false，
 * 但渲染过滤只看 `layer.frozen`（70 bit1），所以 **62<0 的层照样被画出来**。
 *
 * 冻结（70 bit1）**不在这里删**：fork 后的 dxf-viewer 会保留冻结层几何、
 * 以 `visible:true` 载入，用户可以在图层面板里手动关闭（如 AXIS 的 169 个
 * 尺寸标注）。v32 曾把冻结层实体一起删掉，导致这些层在面板里变成空层、
 * 永远打不开 —— 那是回归，v33 已改回「只删关闭层」。
 *
 * 实测（三份缓存）：
 *   · e115b25b946e：`泵房轮廓线` 62=-1 → 真 off；
 *   · 7a75a89eebe1：**没有任何一层 62<0**。审计报告里说的 `地库增加范围`
 *     实际是 **70 bit1（冻结）**，cadcraft 的 SVG 也确实不画它（按点比对 0/93 命中）；
 *     而 meta.json 里 `off:true` 的 `建筑` 其实是 **70=4（锁定）** —— 锁定层是可见的，
 *     cadcraft SVG 里 83% 的点命中。那是 stats 层把 bit4 当成了 off（见 scanner.js），
 *     不是 DXF 丢了标志。
 *
 * 所以判定顺序（保守，只认权威来源）：
 *   1. LAYER 记录 62 < 0            → off（DXF 规范）→ 整段删除
 *   2. LAYER 记录 70 & 1（冻结）    → **保留**，带尺寸的层默认可见，其余隐藏，面板可切
 *   3. 仅当该层在 DXF 里**完全没有 62**（raw===null）时，才接受 meta.json 的 off:true
 *      —— 防止把 `建筑` 这种"扫描器误判的锁定层"删掉。
 */

/** 需要整段删除的图层（只含"关闭"层）：层名 → {reason:"off", source?:"dxf"|"meta"} */
export function hiddenLayerTable(text, metaLayers = null) {
  const info = layerTableInfo(text);
  const out = new Map();
  for (const [name, rec] of info) {
    if (!name || name === "0") continue;
    if (rec.raw !== null && rec.raw < 0) {
      out.set(name, { reason: "off", source: "dxf" });
    }
    /* 冻结（70 bit1）不删：fork 的 dxf-viewer 保留其几何并以 visible:false 载入，
     * 图层面板里可以手动打开。删掉就变成"空层、永远打不开"。 */
  }
  if (Array.isArray(metaLayers)) {
    for (const l of metaLayers) {
      if (!l || l.off !== true) continue;
      const name = typeof l.name === "string" ? l.name.trim() : "";
      if (!name || name === "0" || out.has(name)) continue;
      const rec = info.get(name);
      // DXF 自己写了 62：以 DXF 为准（扫描器的 off 把 bit4=锁定 也算进来了，不可信）
      if (rec && rec.raw !== null) continue;
      out.set(name, { reason: "off", source: "meta" });
    }
  }
  return out;
}

/**
 * 把隐藏图层上的实体整段删掉（ENTITIES + BLOCKS 两段，按实体行区间，不碰组码结构）。
 *
 * · 隐藏层上的 INSERT 整条删除 → 它引用的块实例一起消失（与 AutoCAD 语义一致）；
 * · 块定义里画在隐藏层上的子实体也删除；块内 0 层实体沿用 INSERT 的层，实例层面已处理；
 * · 已有的 focus/highlight、块内颜色烘焙都在这之后跑，互不干扰。
 *
 * @param {string} s
 * @param {Map<string,{reason:string}>|null} hidden 缺省自行从 LAYER 表算
 * @param {Array|null} metaLayers meta.json 的 stats.layers（仅在 DXF 缺 62 时兜底）
 * @returns {{text:string, skipped:number, off:number, frozen:number, hidden:Map,
 *            layers:Array<{name:string,reason:string,entities:number,source:string}>}}
 */
export function filterHiddenLayers(s, hidden = null, metaLayers = null) {
  const hid = hidden || hiddenLayerTable(s, metaLayers);
  if (!hid.size) {
    return { text: s, skipped: 0, off: 0, frozen: 0, hidden: hid, layers: [] };
  }
  const eol = s.includes("\r\n") ? "\r\n" : "\n";
  const lines = s.split(/\r?\n/);
  const pairs = pairLines(lines);
  const ents = collectEntityRanges(lines, pairs);
  const del = new Set();
  const perLayer = new Map();
  let skipped = 0;
  for (const e of ents) {
    if (e.section !== "ENTITIES" && e.section !== "BLOCKS") continue;
    const p8 = e.pairs.find((p) => p.c === 8);
    if (!p8) continue;
    const name = p8.v.trim();
    const why = hid.get(name);
    if (!why) continue;
    for (let i = e.start; i < e.end; i++) del.add(i);
    skipped++;
    const row = perLayer.get(name) || { name, reason: why.reason, source: why.source || "dxf", entities: 0 };
    row.entities++;
    perLayer.set(name, row);
  }
  let off = 0;
  let frozen = 0;
  for (const row of perLayer.values()) {
    if (row.reason === "off") off += row.entities;
    else frozen += row.entities;
  }
  const layers = [...perLayer.values()].sort((a, b) => b.entities - a.entities);
  if (!del.size) {
    return { text: s, skipped: 0, off: 0, frozen: 0, hidden: hid, layers: [] };
  }
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (del.has(i)) continue;
    out.push(lines[i]);
  }
  return { text: out.join(eol), skipped, off, frozen, hidden: hid, layers };
}

/* ─────────────────────── 块内颜色烘焙（v31）───────────────────────
 * 为什么必须在服务端补（2026-11-08 实测，勿删）：
 *
 * dxf-viewer 1.0.50 对"块内实体颜色"有两条**互相矛盾**的解析路径，两条都不完全符合
 * AutoCAD 的 DXF 语义：
 *
 *   ① 实例化（不摊平）路径 —— SceneReader._ResolveInstanceColor / DxfViewer._GetInstanceColor：
 *      BYLAYER 用 blockBatch.layer（实体自己写的图层）解析。块内实体基本都画在 0 层，
 *      于是颜色 = 0 层的颜色 = 7 号白。AutoCAD 的规则是「块内 0 层 + BYLAYER 继承 INSERT 的图层」，
 *      所以夹具里 939 个 $equip$00002649 消防设备全部画成白色，而原图是 EQUIP-消防 的绿色。
 *
 *   ② 摊平路径 —— DxfScene._FlattenBatch：
 *      `layerName ??= blockBatch.key.layerName`，但调用方传进来的 layerName 恒为 INSERT 的图层
 *      （非 null），因此**块内每个 BYLAYER 实体**都被改成 INSERT 图层的颜色，实体自己写在哪一层
 *      完全失效。实测 A$C29980DFE（7356 个实体、跨 A-WALL/建筑/… 十几层）被整块涂成
 *      INSERT 的红色；cadcraft 直接读 DWG 出的 SVG 里这些墙是青色的。
 *
 * 两条路径都无法在客户端配置，改 viewport 也没用。服务端能做的、且**语义正确**的补偿是：
 * 把块内 BYLAYER 实体的颜色**烘焙成显式 ACI**（= 它本应解析出的图层颜色）。这样：
 *   · 非摊平：62 显式 → 命中 _GetEntityColor 的显式颜色分支 → 正确；
 *   · 摊平：key.color 不再是 BY_LAYER → _FlattenBatch 直接用显式色 → 正确。
 *
 * 判定规则（保守，只处理能唯一确定的）：
 *   · 只处理 BLOCKS 段里的几何实体（BLOCK/ENDBLK/ATTDEF/ATTRIB/SEQEND/VERTEX 不动）；
 *   · 只处理 BYLAYER（组码 62 缺失，或 62=256）；
 *   · 62=0（BYBLOCK）、其它显式 62、带 420 真彩色的实体一律不动 —— dxf-viewer 对 BYBLOCK 的
 *     实例化解析是正确的，动它反而会破坏"随 INSERT 变色"的语义；
 *   · 实体自己有非 0 图层：直接烘焙该层的 ACI（与实例无关，永远正确）；
 *   · 实体在 0 层：需要知道 AutoCAD 会继承哪一层。只有**该块在全图的所有 INSERT 都解析到同一个
 *     非 0 图层**时才烘焙（顶层 INSERT 的 0 层视为 0 层；嵌套 INSERT 递归看父块），
 *     多个图层/无法解析时保持原样（这些只能靠 fork 修）。
 *
 * 烘焙发生在 applyFocus 之后：focus 已经写进去的 62（涂灰）会被"已有显式色"规则跳过，
 * 聚焦行为与 v30 完全一致。
 */

/** 参与颜色烘焙的实体类型：全部是 dxf-viewer 会画、且颜色走 _GetEntityColor 的类型。
 *  INSERT 不在内：它自己没有几何，颜色只对 BYBLOCK 子实体生效，而 dxf-viewer 的嵌套 INSERT
 *  路径根本不读 INSERT 的颜色（见 _ProcessInsert 的 blockCtx 分支），烘焙它既无效也多余。 */
const BLOCK_COLOUR_TYPES = new Set([
  "LINE", "LWPOLYLINE", "POLYLINE", "ARC", "CIRCLE", "ELLIPSE", "POINT", "SPLINE",
  "SOLID", "TRACE", "3DFACE", "TEXT", "MTEXT", "HATCH", "DIMENSION",
]);

/**
 * 把块内 BYLAYER 实体的颜色烘焙成显式 ACI。
 * @param {string} s DXF 文本（此时 `\U+XXXX` 已解码、ATTRIB/块内文字已按需删除）
 * @param {Map<string, number>} [layerAci] 图层 → ACI；缺省从文本的 LAYER 表读取
 * @returns {{text:string, baked:number, layerZeroBaked:number, ambiguous:number,
 *            layerZeroSkipped:number, unknownLayer:number, byBlock:number, explicit:number}}
 */
export function bakeBlockColours(s, layerAci = null) {
  const aciOf = layerAci || layerAciTable(s);
  const eol = s.includes("\r\n") ? "\r\n" : "\n";
  const lines = s.split(/\r?\n/);
  const pairs = pairLines(lines);
  const ents = collectEntityRanges(lines, pairs);

  /* ① 每块被谁引用：INSERT 的图层 + 引用者（顶层 or 父块） */
  const refs = new Map();
  for (const e of ents) {
    if (e.type !== "INSERT") continue;
    const p2 = e.pairs.find((p) => p.c === 2);
    if (!p2) continue;
    const name = p2.v.trim();
    if (!name) continue;
    const p8 = e.pairs.find((p) => p.c === 8);
    if (!refs.has(name)) refs.set(name, []);
    refs.get(name).push({
      layer: p8 ? p8.v.trim() : "0",
      top: !e.blockName,
      parent: e.blockName,
    });
  }

  /* ② 块的有效图层集合（0 层实体继承的就是它）。无法确定/成环 → null */
  const memo = new Map();
  const effLayers = (name, stack = new Set()) => {
    if (memo.has(name)) return memo.get(name);
    if (stack.has(name)) return null;
    stack.add(name);
    const set = new Set();
    for (const r of refs.get(name) || []) {
      if (r.layer !== "0") {
        set.add(r.layer);
        continue;
      }
      if (r.top) {
        set.add("0");
        continue;
      }
      const par = effLayers(r.parent, stack);
      if (!par) {
        stack.delete(name);
        return null;
      }
      for (const l of par) set.add(l);
    }
    stack.delete(name);
    const res = set.size ? set : null;
    memo.set(name, res);
    return res;
  };

  /* ③ 逐实体决策 */
  const replace = new Map(); // 62 值行 → 新值
  const insertAfter = new Map(); // 8 值行之后插 ["62", aci]
  const stats = {
    baked: 0,
    layerZeroBaked: 0,
    ambiguous: 0,
    layerZeroSkipped: 0,
    unknownLayer: 0,
    byBlock: 0,
    explicit: 0,
  };

  for (const e of ents) {
    if (e.section !== "BLOCKS" || !e.blockName) continue;
    if (!BLOCK_COLOUR_TYPES.has(e.type)) continue;
    // 420 真彩色优先：dxf-viewer 会用 entity.color（ParseHelpers 420 分支），别再塞 ACI
    if (e.pairs.some((p) => p.c === 420)) {
      stats.explicit++;
      continue;
    }
    const p62 = e.pairs.find((p) => p.c === 62);
    const c62 = p62 ? Number(p62.v) : null;
    if (c62 === 0) {
      stats.byBlock++;
      continue;
    }
    if (c62 !== null && c62 !== 256) {
      stats.explicit++;
      continue;
    }
    const p8 = e.pairs.find((p) => p.c === 8);
    const layer = p8 ? p8.v.trim() : "0";
    let target = layer;
    if (layer === "0") {
      const set = effLayers(e.blockName);
      if (!set || set.size !== 1) {
        stats.ambiguous++;
        continue;
      }
      target = [...set][0];
      if (target === "0") {
        stats.layerZeroSkipped++;
        continue;
      }
    }
    const aci = aciOf.get(target);
    if (!(Number.isFinite(aci) && aci > 0 && aci < 256)) {
      if (layer === "0") stats.layerZeroSkipped++;
      else stats.unknownLayer++;
      continue;
    }
    if (p62) replace.set(p62.vi, String(aci));
    else if (p8) insertAfter.set(p8.vi, ["62", String(aci)]);
    else continue;
    stats.baked++;
    if (layer === "0") stats.layerZeroBaked++;
  }

  if (!replace.size && !insertAfter.size) return { text: s, ...stats };

  const out = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(replace.has(i) ? replace.get(i) : lines[i]);
    const ins = insertAfter.get(i);
    if (ins) out.push(ins[0], ins[1]);
  }
  return { text: out.join(eol), ...stats };
}

const TBL_LAYER = "0"; // 表格注入后落在自己的层上；层不存在时退回 0

/**
 * 生成注入用的实体文本（DXF 组码对）。
 * 表格坐标系：插入点 = 左上角，u = 方向向量（默认 +X），v = u 顺时针 90°（表格向下方向）
 */
export function buildTableEntities(tables, layers, startHandle, focus, shxCtx = null, injectedStats = null, emitOpts = null, skipLayers = null, tableOpts = null) {
  const out = [];
  let h = startHandle;
  /* 导出路径（v66）只补单元格文字：cadcraft 的 SVG writer 会把表格网格画出来，
   * 但**不画单元格文字**（见本文件顶部 ACAD_TABLE 说明）。网格交给 cadcraft 原生绘制，
   * 这里传 { grid:false } 避免重复。默认 true → 屏幕链路逐字节不变。 */
  const drawGrid = !(tableOpts && tableOpts.grid === false);
  const push = (...rows) => {
    for (const r of rows) out.push(r);
  };
  const eo = emitOptions(shxCtx, emitOpts);
  const solidsBefore = eo.state.solids;
  const fallbackBefore = eo.state.fallback;

  for (const t of tables) {
    // 表格所在的图层被关闭/冻结：整张表都不该出现（与源图一致）
    if (skipLayers && t.layer && skipLayers.has(t.layer)) {
      if (injectedStats) injectedStats.skippedHidden += (t.rows || 0) * (t.cols || 0);
      continue;
    }
    const { ins, rows, cols, rowH, colW, cells, aci } = t;
    if (!rows || !cols) continue;
    const layer = layers.has(t.layer) ? t.layer : TBL_LAYER;
    let color = Number.isFinite(aci) && aci > 0 && aci < 256 ? aci : 7;
    // 表格不属于任何图块：focus=block 时一律涂灰；focus=layer 时按所在图层判断；
    // focus=mute:all（对比模式）不保留任何表格
    if (focus && (focus.kind === "mute" || !(focus.kind === "layer" && layer === focus.name))) {
      color = FOCUS_MUTED_COLOR;
    }

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
    if (drawGrid) {
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
        /* v21：单元格文字也走笔画转换 —— 之前表格注入的 TEXT 从未进过 renderShxText，
         * 是"开图后还剩一堆 TEXT"的主要来源。找不到笔画字体（ctx 为空/无字形）时
         * 仍按原样注入 TEXT，绝不丢字。 */
        if (shxCtx) {
          const rendered = renderShxText(
            {
              text,
              x: cx,
              y: cy,
              h: hh,
              rot,
              wf: 1,
              width: 0,
              halign: 1, // 72=1 居中
              valign: 2, // 73=2 垂直居中
              ax: cx,
              ay: cy,
              layer,
              aci: color,
              style: resolveStyleName("STANDARD"),
            },
            shxCtx
          );
          if (rendered && rendered.polylines.length) {
            const width = eo.thick ? strokeWidthFor(hh, eo) : 0;
            for (const pl of rendered.polylines) {
              const r = strokeEntityTexts(pl, h, {
                thick: eo.thick,
                width,
                maxSolids: eo.maxSolids,
                state: eo.state,
                layer,
                color,
              });
              for (const row of r.rows) out.push(row);
              h = r.nextHandle;
            }
            if (injectedStats) injectedStats.strokes++;
            continue;
          }
        }
        if (injectedStats) injectedStats.fallback++;
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
  return {
    entities: out,
    nextHandle: h,
    thickStrokeSolids: eo.state.solids - solidsBefore,
    thickStrokeFallback: eo.state.fallback - fallbackBefore,
  };
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
 * 收集 DIMENSION 引用的预渲染块名（组码 2）。
 *
 * 为什么需要：dxf-viewer 的 `_DecomposeDimension` 里写着
 * 「Dimension may have pre-rendered block attached. Then just render this block
 *  instead of synthesizing dimension geometry from parameters.」
 * 也就是说块存在时它**整块渲染**，不会自己合成标注文字。
 * 我们如果照常把块内文字删掉，标注线还在、标注数字就没了（实测本库 sample.dwg：
 * 4524 个 *D 块每个 1 条文字，全被删掉 → 界面上的尺寸数字整片缺失）。
 * @returns {Set<string>}
 */
function collectDimensionBlockNames(pairs) {
  const names = new Set();
  let isDim = false;
  for (const p of pairs) {
    if (p.c === 0) {
      isDim = p.v.trim() === "DIMENSION";
      continue;
    }
    if (isDim && p.c === 2) names.add(p.v.trim());
  }
  return names;
}

/**
 * 删掉 BLOCKS 段里的 TEXT / MTEXT。
 *
 * 为什么：dxf-viewer 渲染块内文字时完全不用块变换（见 block-text.js 顶部说明），
 * 留着它们只会在世界原点附近堆一堆 0.01 大小的垃圾三角（实测 6MB 顶点）。
 * 这些字我们已经按每个 INSERT 实例展开成顶层 TEXT 注回去了，一份不多一份不少。
 *
 * 例外：尺寸标注的预渲染块（`*D*` / DIMENSION 组码 2 引用的块）**必须保留文字**，
 * 因为引擎对这些块是整块渲染而不是自己合成标注文字，删了就等于把标注数字抹掉。
 * @returns {{del:Set<number>, count:number, keptDimText:number}}
 */
function collectBlockTextLines(lines) {
  const del = new Set();
  const pairs = pairLines(lines);
  const ranges = entityRanges(pairs, lines.length);
  const dimBlocks = collectDimensionBlockNames(pairs);

  let sec = null;
  let inBlock = false;
  let blockName = null;
  let count = 0;
  let keptDimText = 0;

  for (let k = 0; k < pairs.length; k++) {
    const p = pairs[k];
    if (p.c === 2 && k > 0 && pairs[k - 1].c === 0 && pairs[k - 1].v.trim() === "SECTION") {
      sec = p.v.trim();
      continue;
    }
    if (p.c !== 0) {
      if (inBlock && blockName === null && p.c === 2) blockName = p.v.trim();
      continue;
    }

    const t = p.v.trim();
    if (t === "BLOCK") {
      inBlock = true;
      blockName = null;
    } else if (t === "ENDBLK") {
      inBlock = false;
      blockName = null;
    } else if (sec === "BLOCKS" && inBlock && (t === "TEXT" || t === "MTEXT")) {
      if (blockName && (dimBlocks.has(blockName) || /^\*D/i.test(blockName))) {
        keptDimText++;
        continue;
      }
      const r = ranges.find((x) => x.start === p.ci);
      if (!r) continue;
      for (let i = r.start; i < r.end; i++) del.add(i);
      count++;
    }
  }
  return { del, count, keptDimText };
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


/* ───────────────────────── SHX 笔画文字（v15，v18 扩展 MTEXT/标注块）─────────────────────────
 * dxf-viewer 只能画 TTF 字形；STYLE 指向 .shx 的文字在 WebGL 下会整段消失。
 * 这里把这类文字转成 LWPOLYLINE 注回 DXF（shx-text.js 负责排版/字形），接管三类文字：
 *   · **顶层 TEXT**（v15）；
 *   · **顶层 MTEXT**（v18）：先用 shx-text.js 的 mtextToPlainText 抽掉内联排版码，
 *     再按组码 71 附着点映射 halign/valign；
 *   · **尺寸标注预渲染块（*D）里的 TEXT/MTEXT**（v18）：dxf-viewer 的
 *     `_DecomposeDimension` 见到预渲染块就整块渲染并提前返回，标注数字因此一直是填充字；
 *     这里把块内文字原地换成同一块坐标系的笔画折线。
 * 块内其余文字已在上一步被删除并由 flattenTexts() 展开，天然走同一入口。
 * 找不到任何 SHX 字体时 activeShxCtx 为 null，产出与 v17 **逐字节一致**。
 */

/** 一条笔画折线 → DXF LWPOLYLINE 实体文本（与 buildTableEntities 里同样的组码形状）。
 *  `color === null` 时**不写 62**：块内文字原本没有 62（BYLAYER/BYBLOCK）时必须保持原样，
 *  否则会把标注文字强制成 7 号色，和标注线（随图层颜色）不一致。
 *  `inPaperSpace` 时写 67=1：图纸空间文字（标题栏）必须留在图纸空间，
 *  否则会按图纸坐标画到模型空间原点附近。 */
function lwpolylineEntity(handle, layer, color, points, inPaperSpace = false) {
  const rows = [
    "0", "LWPOLYLINE",
    "5", handle,
    "100", "AcDbEntity",
    "8", layer,
  ];
  if (inPaperSpace) rows.push("67", "1");
  if (color != null) rows.push("62", String(color));
  rows.push(
    "100", "AcDbPolyline",
    "90", String(points.length),
    "70", "0",
  );
  for (const [x, y] of points) rows.push("10", f(x), "20", f(y));
  return rows.join("\r\n");
}

/* ─────────────── CJK 笔画加粗：线段 → 填充四边形（SOLID）───────────────
 * 为什么不能用线宽：dxf-viewer 的 `_IsPlainLine()` 无条件返回 true
 * （`web/node_modules/dxf-viewer/src/DxfScene.js`），LWPOLYLINE 的组码 43 /
 * 顶点宽度 40/41 一律忽略。想要真正的粗细只能给**填充面**。
 *
 * 一条笔画折线拆成每段的矩形条，每段一个 SOLID 实体：
 *   n  = 单位法向 × w/2
 *   周长顺序 A=p0+n, B=p0-n, C=p1-n, D=p1+n
 * SOLID 的角点语义是「10/11 是一条边，12/13 是对角点」（即 3、4 与 1、2 交叉），
 * 所以组码 10/11/12/13 必须存 **1,2,4,3**，即 10=A、11=B、12=D、13=C。
 * dxf-viewer 的 `_DecomposeFace` 正好用三角形 (0,1,2) + (1,3,2) 拼两块三角；
 * 角点顺序写错会画成自交的蝴蝶结。
 */

/**
 * 判据/参数：只有单线体模式（strokeAll）才加粗；auto 模式必须逐字节不变。
 * @param {object|null} ctx createShxContext() 的返回值
 * @param {{thick?:boolean}} [opts]
 */
function thickenAllowed(ctx, opts = {}) {
  if (opts.thick === true) return true;
  if (opts.thick === false) return false;
  /* 默认**不加粗**：用户明确要求保留 CAD 原本的"单线铁丝字"观感，
   * 加粗（SOLID 四边形）会把位置/观感都改掉。需要时设 CADVIEWER_STROKE_THICK=1。 */
  return process.env.CADVIEWER_STROKE_THICK === "1";
}

/**
 * 笔画线宽（图纸单位）。
 *   · `options.strokeWidth` = 绝对线宽，直接覆盖；
 *   · 否则 h × 系数，系数取自 `options.strokeWidthMult` 或环境变量
 *     `CADVIEWER_STROKE_WIDTH`，默认 0.055；
 *   · 再套一个 `1e-6 × 图幅` 的下限，避免超大图（图幅 1e6 单位）上线宽小到亚像素。
 * @param {number} h 字高
 * @param {{strokeWidth?:number, strokeWidthMult?:number, drawingSize?:number}} [opts]
 */
export function strokeWidthFor(h, opts = {}) {
  const abs = Number(opts.strokeWidth);
  if (Number.isFinite(abs) && abs > 0) return abs;
  let mult = Number(opts.strokeWidthMult);
  if (!(Number.isFinite(mult) && mult > 0)) {
    mult = Number(process.env.CADVIEWER_STROKE_WIDTH);
    if (!(Number.isFinite(mult) && mult > 0)) mult = STROKE_WIDTH_MULT;
  }
  const ds = Number(opts.drawingSize);
  const floor = Number.isFinite(ds) && ds > 0 ? ds * 1e-6 : 0;
  const w = Number(h) * mult;
  return Math.max(Number.isFinite(w) ? w : 0, floor, 0);
}

/**
 * 一条折线的线段 → 四边形（每组 4 个角点，已按 SOLID 的 1,2,4,3 顺序排好）。
 * 退化段（长度为 0）跳过。
 * @param {[number,number][]} points
 * @param {number} w 线宽（图纸单位）
 * @returns {[number,number][][]}
 */
export function quadsForPolyline(points, w) {
  const out = [];
  const half = Number(w) / 2;
  if (!(half > 0) || !Array.isArray(points)) return out;
  for (let i = 0; i + 1 < points.length; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    if (!Array.isArray(p0) || !Array.isArray(p1)) continue;
    const x0 = Number(p0[0]);
    const y0 = Number(p0[1]);
    const x1 = Number(p1[0]);
    const y1 = Number(p1[1]);
    if (![x0, y0, x1, y1].every(Number.isFinite)) continue;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (!(len > 1e-12)) continue;
    const nx = (-dy / len) * half;
    const ny = (dx / len) * half;
    // 周长顺序 A,B,C,D → SOLID 存 A,B,D,C（组码 10/11/12/13）
    out.push([
      [x0 + nx, y0 + ny], // A = p0+n
      [x0 - nx, y0 - ny], // B = p0-n
      [x1 + nx, y1 + ny], // D = p1+n（第 3、4 点互换）
      [x1 - nx, y1 - ny], // C = p1-n
    ]);
  }
  return out;
}

/** 一个 SOLID 实体（填充四边形）。颜色规则与 lwpolylineEntity 一致。 */
function solidEntity(handle, layer, color, quad, inPaperSpace = false) {
  const rows = [
    "0", "SOLID",
    "5", handle,
    "100", "AcDbEntity",
    "8", layer,
  ];
  if (inPaperSpace) rows.push("67", "1");
  if (color != null) rows.push("62", String(color));
  rows.push("100", "AcDbTrace");
  const codes = [
    ["10", "20", "30"],
    ["11", "21", "31"],
    ["12", "22", "32"],
    ["13", "23", "33"],
  ];
  for (let i = 0; i < 4; i++) {
    const [x, y] = quad[i];
    rows.push(codes[i][0], f(x), codes[i][1], f(y), codes[i][2], "0.0");
  }
  return rows.join("\r\n");
}

/** 归一化调用方传入的 emit 选项（缺省按 ctx 的笔画模式决定是否加粗）。 */
function emitOptions(ctx, opts = {}, fallbackState = null) {
  const o = opts && typeof opts === "object" ? opts : {};
  const state = o.state && typeof o.state === "object" ? o.state : fallbackState || { solids: 0, fallback: 0 };
  if (!Number.isFinite(state.solids)) state.solids = 0;
  if (!Number.isFinite(state.fallback)) state.fallback = 0;
  const limit = Number(o.maxSolids);
  return {
    thick: thickenAllowed(ctx, o),
    strokeWidth: o.strokeWidth,
    strokeWidthMult: o.strokeWidthMult,
    drawingSize: o.drawingSize,
    maxSolids: Number.isFinite(limit) && limit >= 0 ? limit : STROKE_SOLID_LIMIT,
    state,
  };
}

/**
 * 一条笔画折线 → 注入实体文本。
 *   · 加粗启用且 `pl.cjk === true`：每段一个 SOLID（填充矩形条）；
 *   · 否则（拉丁/自动模式/超出 SOLID 上限）：一条 LWPOLYLINE。
 * 超上限时**整条折线**退回细线并累加 `state.fallback`（一条 = 一条折线）。
 *
 * @returns {{rows:string[], nextHandle:number}}
 */
function strokeEntityTexts(pl, startHandle, o) {
  const hl = (n) => n.toString(16).toUpperCase();
  const points = (pl && pl.points) || [];
  const quads =
    o.thick && pl && pl.cjk === true && points.length >= 2
      ? quadsForPolyline(points, o.width)
      : null;
  if (quads && quads.length) {
    if (o.state.solids + quads.length > o.maxSolids) {
      o.state.fallback++;
      return {
        rows: [lwpolylineEntity(hl(startHandle), o.layer, o.color, points, o.inPaperSpace)],
        nextHandle: startHandle + 1,
      };
    }
    const rows = [];
    let h = startHandle;
    for (const q of quads) rows.push(solidEntity(hl(h++), o.layer, o.color, q, o.inPaperSpace));
    o.state.solids += quads.length;
    return { rows, nextHandle: h };
  }
  return {
    rows: [lwpolylineEntity(hl(startHandle), o.layer, o.color, points, o.inPaperSpace)],
    nextHandle: startHandle + 1,
  };
}


/** 按 `0/<类型>` 走一遍，记下每个实体的段归属与行区间（供安全地整段替换）。
 *  `pairs` 可由调用方预先算好复用（大图避免重复扫全文）。 */
function collectEntityRanges(lines, pairs = pairLines(lines)) {
  const ents = [];
  let section = null;
  let inBlock = false;
  let blockName = null;
  let cur = null;
  const flush = (endLine) => {
    if (!cur) return;
    cur.end = endLine;
    ents.push(cur);
    cur = null;
  };
  for (let k = 0; k < pairs.length; k++) {
    const p = pairs[k];
    if (p.c === 2 && k > 0 && pairs[k - 1].c === 0 && pairs[k - 1].v.trim() === "SECTION") {
      section = p.v.trim();
      continue;
    }
    if (p.c !== 0) {
      if (inBlock && blockName === null && p.c === 2) blockName = p.v.trim();
      if (cur) cur.pairs.push(p);
      continue;
    }
    flush(p.ci);
    const type = p.v.trim();
    if (type === "BLOCK") {
      inBlock = true;
      blockName = null;
    } else if (type === "ENDBLK") {
      inBlock = false;
    }
    cur = { type, start: p.ci, end: lines.length, section, block: inBlock, blockName: inBlock ? blockName : null, pairs: [] };
  }
  flush(lines.length);
  return ents;
}

/* ───────── 不支持实体的服务端合成：LEADER / MULTILEADER / MLINE（v32）─────────
 * dxf-viewer 的解析器里**完全没有**这三个实体（DxfParser.js / DxfScene.js 各 0 处匹配），
 * 原始 DXF 里它们连实体表都进不去 —— af7f93811f50 的 214 条 LEADER、e115b25b946e 的
 * 4 条 MLINE 就是这么整片消失的。这里在服务端把它们**就地**换成引擎认识的原语：
 *   · LEADER      → LWPOLYLINE（顶点折线）+ SOLID（箭头三角）
 *   · MULTILEADER → LWPOLYLINE（引线）+ TEXT（注记）
 *   · MLINE       → 每条元素线一条 LWPOLYLINE
 * 因为是替换原实体的行区间（不是追加），块坐标系、focus 涂灰、图层/线型/颜色都自然保持。
 *
 * 覆盖范围（明确写下来，避免以后误以为"全支持"）：
 *   LEADER：
 *     · 直线路径（72=0）完整支持；样条路径（72=1）按顶点折线近似（降级但画得出来）；
 *     · 箭头按 71 标志画实心三角形，大小 = 引用 DIMSTYLE 的 DIMASZ×DIMSCALE，
 *       取不到时用注释高度(40)/图幅兜底，并限制在首段长度的 60% 以内；
 *     · 组码 341（硬指针）指向的 TEXT/MTEXT **不复制**：它们本来就会正常渲染，
 *       复制只会出重影。只有 304 里带字面量文字时才补一条 TEXT；
 *     · 钩线（74/75）、注释偏移（211/213/215）、真彩色 / XDATA 一律丢弃（不画）。
 *   MULTILEADER：
 *     · 只覆盖"直线引线 + 一段文字"的常见形态：CONTEXT_DATA 里 LEADER_LINE{...} 的
 *       10/20/30 顶点 + 304 文字（或组码 1）；
 *     · 多段引线合并成一条折线；块内容/弧线引线/附着点精细排版/样式覆盖不处理，
 *       降级成"只画引线"；连顶点都解析不到时保留原实体，计入 leaderFallbacks。
 *   MLINE：
 *     · 按 DXF 规范读 73(元素数) / 40(比例) / 72(顶点数)，每个顶点后跟
 *       74 参数个数 + 41 参数（第 1 个是元素偏移）+ 75 填充参数；
 *     · 偏移沿 12/22（方向向量）在顶点处展开，方向缺失时用 13/23（斜接方向）兜底；
 *     · 解析不到顶点/元素时退回中心线，计入 mlineFallbacks；
 *     · 元素间填充、端头封口（cap）不画。
 */

/** LWPOLYLINE 组码行（与 lwpolylineEntity 同形状，多了可选线型 6）。 */
function polylineRows(handle, layer, color, points, opts = {}) {
  const rows = [
    "0", "LWPOLYLINE",
    "5", handle,
    "100", "AcDbEntity",
    "8", layer,
  ];
  if (opts.inPaperSpace) rows.push("67", "1");
  if (opts.linetype) rows.push("6", opts.linetype);
  if (color != null) rows.push("62", String(color));
  rows.push("100", "AcDbPolyline", "90", String(points.length), "70", "0");
  for (const [x, y] of points) rows.push("10", f(x), "20", f(y));
  return rows;
}

/** SOLID 组码行；`quad` 顺序 = 组码 10/11/12/13（见 quadsForPolyline 的 A,B,D,C 说明）。 */
function solidRows(handle, layer, color, quad, opts = {}) {
  const rows = [
    "0", "SOLID",
    "5", handle,
    "100", "AcDbEntity",
    "8", layer,
  ];
  if (opts.inPaperSpace) rows.push("67", "1");
  if (color != null) rows.push("62", String(color));
  rows.push("100", "AcDbTrace");
  const codes = [
    ["10", "20", "30"],
    ["11", "21", "31"],
    ["12", "22", "32"],
    ["13", "23", "33"],
  ];
  for (let i = 0; i < 4; i++) {
    const [x, y] = quad[i];
    rows.push(codes[i][0], f(x), codes[i][1], f(y), codes[i][2], "0.0");
  }
  return rows;
}

/** TEXT 组码行（非左/基线对齐时才写 11/21 第二定位点）。 */
function textRows(handle, layer, color, t) {
  const rows = [
    "0", "TEXT",
    "5", handle,
    "100", "AcDbEntity",
    "8", layer,
  ];
  if (t.inPaperSpace) rows.push("67", "1");
  if (color != null) rows.push("62", String(color));
  rows.push(
    "100", "AcDbText",
    "10", f(t.x), "20", f(t.y), "30", "0.0",
    "40", f(t.h),
    "1", t.text
  );
  if (t.rot) rows.push("50", f(t.rot));
  if (Number.isFinite(t.wf) && Math.abs(t.wf - 1) > 1e-6) rows.push("41", f(t.wf));
  const halign = Number(t.halign) || 0;
  const valign = Number(t.valign) || 0;
  if (halign || valign) {
    rows.push(
      "72", String(halign), "73", String(valign),
      "11", f(Number.isFinite(t.ax) ? t.ax : t.x),
      "21", f(Number.isFinite(t.ay) ? t.ay : t.y),
      "31", "0.0"
    );
  }
  return rows;
}

/** DIMSTYLE 表：名 → { asz: DIMASZ(41), scale: DIMSCALE(40), txt: DIMTXT(140) } */
function dimStyleTable(text) {
  const out = new Map();
  let inDim = false;
  let rec = null;
  const flush = () => {
    if (rec && rec.name) out.set(rec.name, rec);
    rec = null;
  };
  for (const p of pairLines(text.split(/\r?\n/))) {
    if (p.c === 0) {
      flush();
      inDim = p.v.trim() === "DIMSTYLE";
      if (inDim) rec = { name: null, asz: 0, scale: 1, txt: 0 };
      continue;
    }
    if (!inDim || !rec) continue;
    if (p.c === 2 && rec.name === null) rec.name = p.v.trim();
    else if (p.c === 41) rec.asz = Number(p.v) || 0;
    else if (p.c === 40) rec.scale = Number(p.v) || 0;
    else if (p.c === 140) rec.txt = Number(p.v) || 0;
  }
  flush();
  return out;
}

/** 一段实体行区间替换：{ [startLine]: {end, text} } */
function applyEntityReplacements(s, repl) {
  if (!repl.size) return s;
  const eol = s.includes("\r\n") ? "\r\n" : "\n";
  const lines = s.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const r = repl.get(i);
    if (r) {
      out.push(r.text);
      i = r.end - 1;
      continue;
    }
    out.push(lines[i]);
  }
  return out.join(eol);
}

/** 合成实体写什么颜色：显式 ACI 照抄；BYBLOCK(0) 在顶层解析成图层色；BYLAYER 用图层色。 */
function synthesisedColour(e, layer, layerAci, inBlock) {
  const p62 = e.pairs.find((p) => p.c === 62);
  if (p62) {
    const n = Number(p62.v);
    if (Number.isFinite(n)) {
      if (n > 0 && n < 256) return n;
      /* 62=0 是 BYBLOCK：块内保持 0（交给 INSERT 解析）；顶层按 AutoCAD/dxf-viewer
       * 的规则解析成白色，否则写 0 会和引擎语义不一致。 */
      if (n === 0) return inBlock ? 0 : 7;
      if (n < 0) return Math.abs(n);
    }
  }
  return layerAci.get(layer) ?? 7;
}

function synthesisOpts(s, opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const cbox = o.cbox || null;
  const ok = cbox && cbox.width > 0 && cbox.height > 0;
  return {
    layerAci: o.layerAci || layerAciTable(s),
    dimStyles: o.dimStyles || dimStyleTable(s),
    layers: o.layers || null,
    cbox,
    /* 图幅兜底尺寸：箭头/字高取不到时用 1e-4×图幅长边（630k 图幅 → 63 单位）。 */
    fallbackSize: ok ? Math.max(cbox.width, cbox.height) * 1e-4 : 1,
  };
}

/** LEADER 的顶点：重复 10/20（30 忽略）。 */
function leaderVertices(e) {
  const out = [];
  for (let i = 0; i < e.pairs.length; i++) {
    if (e.pairs[i].c !== 10) continue;
    let x = Number(e.pairs[i].v);
    let y = null;
    for (let j = i + 1; j < e.pairs.length && e.pairs[j].c !== 10; j++) {
      if (e.pairs[j].c === 20 && y === null) y = Number(e.pairs[j].v);
    }
    if (Number.isFinite(x) && Number.isFinite(y)) out.push([x, y]);
  }
  return out;
}

/**
 * LEADER → LWPOLYLINE + SOLID（箭头）。
 * @returns {{text:string, used:number, leadersConverted:number, leaderFallbacks:number,
 *            leaderArrows:number, leaderAnnotations:number}}
 */
export function convertLeaders(s, startHandle, opts = {}) {
  const o = synthesisOpts(s, opts);
  const eol = s.includes("\r\n") ? "\r\n" : "\n";
  const lines = s.split(/\r?\n/);
  const ents = collectEntityRanges(lines, pairLines(lines));
  let h = startHandle;
  let leadersConverted = 0;
  let leaderFallbacks = 0;
  let leaderArrows = 0;
  let leaderAnnotations = 0;
  const repl = new Map();

  for (const e of ents) {
    if (e.type !== "LEADER") continue;
    if (e.section !== "ENTITIES" && e.section !== "BLOCKS") continue;
    const verts = leaderVertices(e);
    if (verts.length < 2) {
      leaderFallbacks++;
      continue;
    }
    const inBlock = !!e.block;
    const layerRaw = firstVal(e, 8, "0");
    const layer = o.layers && !o.layers.has(layerRaw) ? "0" : layerRaw;
    const color = synthesisedColour(e, layer, o.layerAci, inBlock);
    const inPaperSpace = numVal(e, 67, 0) === 1;
    const linetype = firstVal(e, 6, "") || null;
    const rows = polylineRows((h++).toString(16).toUpperCase(), layer, color, verts, {
      inPaperSpace,
      linetype,
    });

    /* 箭头：71=1 表示有箭头。尺寸 = DIMASZ×DIMSCALE（AutoCAD 的规则）。 */
    const arrow = numVal(e, 71, 1) !== 0;
    if (arrow) {
      const style = firstVal(e, 3, "STANDARD");
      const ds = o.dimStyles.get(style);
      let asz = ds && ds.scale > 0 ? ds.asz * ds.scale : 0;
      if (!(asz > 0)) asz = numVal(e, 40, 0);
      if (!(asz > 0)) asz = o.fallbackSize;
      const [x0, y0] = verts[0];
      const [x1, y1] = verts[1];
      const dx = x0 - x1; // 箭头尖端指向图纸对象（背离引线）
      const dy = y0 - y1;
      const len = Math.hypot(dx, dy);
      if (len > 1e-12) {
        const ux = dx / len;
        const uy = dy / len;
        const seg = Math.hypot(x1 - x0, y1 - y0);
        const size = Math.max(Math.min(asz, seg * 0.6), 1e-9);
        const bx = x0 - ux * size;
        const by = y0 - uy * size;
        const wx = (-uy * size) / 2 / 1.6; // 半宽 ≈ size/3.2
        const wy = (ux * size) / 2 / 1.6;
        /* SOLID 角点顺序：10=尖端(A)、11=B1、12=B2、13=B2（退化第四点）。
         * dxf-viewer 的 _DecomposeFace 用 (0,1,2)+(1,3,2) 拼三角，正好一个实心箭头。 */
        const quad = [
          [x0, y0],
          [bx + wx, by + wy],
          [bx - wx, by - wy],
          [bx - wx, by - wy],
        ];
        rows.push(
          ...solidRows((h++).toString(16).toUpperCase(), layer, color, quad, { inPaperSpace })
        );
        leaderArrows++;
      }
    }

    /* 注释：341 硬指针指向的 MTEXT/TEXT 本来就会渲染 —— 绝不复制。
     * 只有 304 带字面量文字（极少见）时才补一条 TEXT。 */
    const p304 = e.pairs.find((p) => p.c === 304);
    const literal = p304 ? cleanCellText(p304.v) : "";
    if (literal) {
      const ds = o.dimStyles.get(firstVal(e, 3, "STANDARD"));
      let th = numVal(e, 40, 0);
      if (!(th > 0) && ds && ds.scale > 0) th = ds.txt * ds.scale;
      if (!(th > 0)) th = o.fallbackSize;
      const [tx, ty] = verts[verts.length - 1];
      rows.push(
        ...textRows((h++).toString(16).toUpperCase(), layer, color, {
          x: tx,
          y: ty + th * 0.5,
          h: th,
          text: literal,
          inPaperSpace,
        })
      );
      leaderAnnotations++;
    }

    repl.set(e.start, { end: e.end, text: rows.join(eol) });
    leadersConverted++;
  }

  return {
    text: applyEntityReplacements(s, repl),
    used: h - startHandle,
    leadersConverted,
    leaderFallbacks,
    leaderArrows,
    leaderAnnotations,
  };
}

/**
 * 解析 MULTILEADER 的 CONTEXT_DATA。
 * 返回 { vertices, textPos, text }。只覆盖直线引线 + 一段文字的常见形态。
 */
export function parseMLeaderPairs(pairs) {
  const stack = [];
  const vertices = [];
  const outside = [];
  let textPos = null;
  const texts = [];
  let last10 = null;
  let sawLeaderLine = false;

  for (const p of pairs) {
    if (p.c >= 300 && p.c <= 309) {
      const v = String(p.v).trim();
      if (v.endsWith("{")) {
        const name = v.slice(0, -1).trim().toUpperCase();
        stack.push(name);
        if (name.includes("LEADER_LINE")) sawLeaderLine = true;
        continue;
      }
      if (v === "}" || v === "}^{") {
        stack.pop();
        continue;
      }
      if (p.c === 304) {
        const top = stack.length ? stack[stack.length - 1] : "";
        // 结构关键字（kPolyline/kArc…）和裸上下文名不算文字
        const isKeyword = /^k[A-Za-z]/.test(v);
        const isContext = /^(CONTEXT_DATA|LEADER|LEADER_LINE|MTEXT|TEXT)$/i.test(v);
        if (v && !isKeyword && !isContext && !top.includes("LEADER_LINE")) texts.push(v);
      }
      continue;
    }
    if (p.c === 10) {
      last10 = Number(p.v);
      continue;
    }
    if (p.c === 20) {
      const y = Number(p.v);
      if (Number.isFinite(last10) && Number.isFinite(y)) {
        const inLeader = stack.some((n) => n.includes("LEADER_LINE"));
        if (inLeader) vertices.push([last10, y]);
        else if (outside.length < 4) outside.push([last10, y]);
      }
      last10 = null;
      continue;
    }
    if (p.c === 1) {
      const v = String(p.v).trim();
      if (v) texts.push(v);
    }
  }

  /* 没有 LEADER_LINE 作用域标记（老导出器会把上下文剥掉）：退一步把除插入点外的
   * 所有 10/20 当顶点 —— 仍比"整条不画"强，计入降级但不算失败。 */
  if (!sawLeaderLine) {
    for (const p of outside) {
      if (p !== outside[0]) vertices.push(p);
    }
  }
  if (outside.length) textPos = outside[0];

  /* 文字取最长的候选，并按 MTEXT 内联码清洗 */
  let text = "";
  for (const t of texts) {
    const cleaned = mtextToPlainText(t).trim();
    if (cleaned && cleaned.length > text.length) text = cleaned;
  }
  if (vertices.length) textPos = textPos || vertices[vertices.length - 1];
  return { vertices, text, textPos };
}

/**
 * MULTILEADER → LWPOLYLINE + TEXT（常见形态）。
 * @returns {{text:string, used:number, multileadersConverted:number,
 *            multileaderTexts:number, leaderFallbacks:number}}
 */
export function convertMultiLeaders(s, startHandle, opts = {}) {
  const o = synthesisOpts(s, opts);
  const eol = s.includes("\r\n") ? "\r\n" : "\n";
  const lines = s.split(/\r?\n/);
  const ents = collectEntityRanges(lines, pairLines(lines));
  let h = startHandle;
  let multileadersConverted = 0;
  let multileaderTexts = 0;
  let leaderFallbacks = 0;
  const repl = new Map();

  for (const e of ents) {
    if (e.type !== "MULTILEADER") continue;
    if (e.section !== "ENTITIES" && e.section !== "BLOCKS") continue;
    const parsed = parseMLeaderPairs(e.pairs);
    if (parsed.vertices.length < 2) {
      leaderFallbacks++;
      continue;
    }
    const inBlock = !!e.block;
    const layerRaw = firstVal(e, 8, "0");
    const layer = o.layers && !o.layers.has(layerRaw) ? "0" : layerRaw;
    const color = synthesisedColour(e, layer, o.layerAci, inBlock);
    const inPaperSpace = numVal(e, 67, 0) === 1;
    const rows = polylineRows((h++).toString(16).toUpperCase(), layer, color, parsed.vertices, {
      inPaperSpace,
      linetype: firstVal(e, 6, "") || null,
    });
    if (parsed.text) {
      let th = numVal(e, 41, 0); // 上下文里的文字高度
      if (!(th > 0)) th = numVal(e, 140, 0); // 箭头尺寸（退一步）
      if (!(th > 0)) th = o.fallbackSize * 1.5;
      const [tx, ty] = parsed.textPos || parsed.vertices[parsed.vertices.length - 1];
      rows.push(
        ...textRows((h++).toString(16).toUpperCase(), layer, color, {
          x: tx,
          y: ty + th * 0.5,
          h: th,
          text: parsed.text,
          inPaperSpace,
        })
      );
      multileaderTexts++;
    }
    repl.set(e.start, { end: e.end, text: rows.join(eol) });
    multileadersConverted++;
  }

  return {
    text: applyEntityReplacements(s, repl),
    used: h - startHandle,
    multileadersConverted,
    multileaderTexts,
    leaderFallbacks,
  };
}

/**
 * 解析 MLINE：返回 { vertices:[{x,y,dx,dy,mx,my,offs:number[]}], elements, scale }。
 * 顶点组顺序固定为 11/21/31（点）、12/22/32（方向）、13/23/33（斜接方向），
 * 之后每个元素一组 74(参数个数) + 41×n（第 1 个是偏移） + 75(填充参数个数) + 41×m。
 */
export function parseMLinePairs(pairs) {
  let elements = 0;
  let scale = 1;
  let scaleSeen = false;
  for (const p of pairs) {
    if (p.c === 73 && !elements) elements = Number(p.v) || 0;
    else if (p.c === 40 && !scaleSeen) {
      scale = Number(p.v) || 1;
      scaleSeen = true;
    }
  }
  const vertices = [];
  let i = 0;
  while (i < pairs.length) {
    if (pairs[i].c !== 11) {
      i++;
      continue;
    }
    const v = { x: Number(pairs[i].v), y: NaN, dx: null, dy: null, mx: null, my: null, offs: [] };
    i++;
    while (i < pairs.length && pairs[i].c !== 11) {
      const p = pairs[i];
      if (p.c === 21) v.y = Number(p.v);
      else if (p.c === 12) v.dx = Number(p.v);
      else if (p.c === 22) v.dy = Number(p.v);
      else if (p.c === 13 && v.mx === null) v.mx = Number(p.v);
      else if (p.c === 23 && v.my === null) v.my = Number(p.v);
      else if (p.c === 74) {
        const n = Math.max(0, Math.min(32, Number(p.v) || 0));
        i++;
        const params = [];
        for (let k = 0; k < n && i < pairs.length && pairs[i].c === 41; k++, i++) {
          params.push(Number(pairs[i].v));
        }
        if (params.length) v.offs.push(params[0]); // 第 1 个参数 = 元素偏移
        continue;
      } else if (p.c === 75) {
        const n = Math.max(0, Math.min(32, Number(p.v) || 0));
        i += 1 + n;
        continue;
      }
      i++;
    }
    if (Number.isFinite(v.x) && Number.isFinite(v.y)) vertices.push(v);
  }
  if (!elements) {
    let max = 0;
    for (const v of vertices) max = Math.max(max, v.offs.length);
    elements = max;
  }
  return { vertices, elements, scale: scale > 0 ? scale : 1 };
}

/**
 * MLINE → 每条元素线一条 LWPOLYLINE。
 * @returns {{text:string, used:number, mlinesConverted:number, mlineElements:number,
 *            mlineFallbacks:number}}
 */
export function convertMLines(s, startHandle, opts = {}) {
  const o = synthesisOpts(s, opts);
  const eol = s.includes("\r\n") ? "\r\n" : "\n";
  const lines = s.split(/\r?\n/);
  const ents = collectEntityRanges(lines, pairLines(lines));
  let h = startHandle;
  let mlinesConverted = 0;
  let mlineElements = 0;
  let mlineFallbacks = 0;
  const repl = new Map();

  for (const e of ents) {
    if (e.type !== "MLINE") continue;
    if (e.section !== "ENTITIES" && e.section !== "BLOCKS") continue;
    const parsed = parseMLinePairs(e.pairs);
    const verts = parsed.vertices;
    if (verts.length < 2) {
      mlineFallbacks++;
      continue;
    }
    const inBlock = !!e.block;
    const layerRaw = firstVal(e, 8, "0");
    const layer = o.layers && !o.layers.has(layerRaw) ? "0" : layerRaw;
    const color = synthesisedColour(e, layer, o.layerAci, inBlock);
    const inPaperSpace = numVal(e, 67, 0) === 1;
    const linetype = firstVal(e, 6, "") || null;
    const rows = [];
    const elements = parsed.elements > 0 ? parsed.elements : 0;
    if (elements > 0) {
      for (let k = 0; k < elements; k++) {
        const pts = [];
        for (let n = 0; n < verts.length; n++) {
          const v = verts[n];
          const off = Number.isFinite(v.offs[k]) ? v.offs[k] : 0;
          /* 12/22 是**路径方向**，元素偏移垂直于它（实测 管道250：偏移 ±125 → 250 宽）。
           * 方向缺失时用 13/23（斜接方向）兜底，再不行用相邻顶点求法向。 */
          let nx = 0;
          let ny = 0;
          const dirLen = Number.isFinite(v.dx) && Number.isFinite(v.dy) ? Math.hypot(v.dx, v.dy) : 0;
          const mitLen = Number.isFinite(v.mx) && Number.isFinite(v.my) ? Math.hypot(v.mx, v.my) : 0;
          if (dirLen > 1e-12) {
            nx = -v.dy / dirLen;
            ny = v.dx / dirLen;
          } else if (mitLen > 1e-12) {
            nx = -v.my / mitLen;
            ny = v.mx / mitLen;
          } else {
            const a = verts[Math.max(0, n - 1)];
            const b = verts[Math.min(verts.length - 1, n + 1)];
            const l = Math.hypot(b.x - a.x, b.y - a.y);
            if (l > 1e-12) {
              nx = -(b.y - a.y) / l;
              ny = (b.x - a.x) / l;
            }
          }
          const d = off * parsed.scale;
          pts.push([v.x + nx * d, v.y + ny * d]);
        }
        rows.push(
          ...polylineRows((h++).toString(16).toUpperCase(), layer, color, pts, {
            inPaperSpace,
            linetype,
          })
        );
        mlineElements++;
      }
    }
    if (!elements) {
      // 解析不到元素参数 → 退回中心线（仍按原层原色）
      const pts = verts.map((v) => [v.x, v.y]);
      rows.push(
        ...polylineRows((h++).toString(16).toUpperCase(), layer, color, pts, {
          inPaperSpace,
          linetype,
        })
      );
      mlineFallbacks++;
    }
    repl.set(e.start, { end: e.end, text: rows.join(eol) });
    mlinesConverted++;
  }

  return {
    text: applyEntityReplacements(s, repl),
    used: h - startHandle,
    mlinesConverted,
    mlineElements,
    mlineFallbacks,
  };
}


/**
 * 把 SHX 文字整段替换成 LWPOLYLINE（v18）：
 *   · ENTITIES 顶层的 TEXT / MTEXT；
 *   · 尺寸标注预渲染块（DIMENSION 组码 2 引用，或名字形如 `*D...`）里的 TEXT / MTEXT。
 *
 * 安全性：按"实体行区间"替换（与 collectAttribLines / collectBlockTextLines 同一套机制），
 * 不碰组码结构，不会像"在字符串中间插行"那样把 0/ENDSEC 弄错位。
 * 位置/字高/旋转/宽度因子/对齐全部从原实体组码读，focus 已在调用前涂过色，因此颜色照搬 62；
 * 块内文字没有 62 时不写 62（保持 BYLAYER/BYBLOCK，由插入块/图层解析颜色）。
 *
 * 标注块里的坐标**原样使用**：dxf-viewer 的 `_DecomposeDimension` 用 (0,0) 的 dummy INSERT
 * 整块渲染，块内文字与块内其它几何共用同一套块坐标，所以笔画也必须留在块坐标系里。
 *
 * @returns {{text:string,texts:number,mtext:number,polylines:number,missing:number,
 *            dimTexts:number,dimMtext:number,dimPolylines:number,used:number}}
 */
/**
 * 一条文字能否安全地用 SHX 笔画替换。
 *
 * v39：SHX 字体缺字形时旧逻辑只跳过缺的那个字（renderShxText 里 missing++ / continue），
 * 屏幕上就是"字被吃掉"。这里把判定抽出来：只要缺一个字，就整条不转、保留原 TEXT/MTEXT，
 * 交给引擎的 TTF 字体（Noto Sans SC）画全。单测见 dxf-web.test.mjs「缺字形」。
 *
 * @param {?{polylines: any[], missing: number}} rendered
 * @returns {boolean}
 */
export function shxTextIsComplete(rendered) {
  return !!rendered && rendered.polylines.length > 0 && !(rendered.missing > 0);
}

export function convertShxTexts(s, ctx, startHandle, layers, emitOpts = null) {
  const eol = s.includes("\r\n") ? "\r\n" : "\n";
  const lines = s.split(/\r?\n/);
  // 全文只切一次实体区间（大图 23MB 上跑两遍 pairLines 会很贵）
  const pairs = pairLines(lines);
  const ents = collectEntityRanges(lines, pairs);
  const eo = emitOptions(ctx, emitOpts);
  const solidsBefore = eo.state.solids;
  const fallbackBefore = eo.state.fallback;

  /* 标注块名：DIMENSION 的组码 2（预渲染块）+ 所有 `*D` 块。
   * 后者是 AutoCAD 的命名习惯，实测可用；不在 DIMENSION 引用里的 *D 块不会渲染，
   * 但一起转掉也不会影响正确的块（且能让"*D 块内文字"统计口径保持一致）。 */
  const dimBlocks = new Set();
  for (const e of ents) {
    if (e.type !== "DIMENSION") continue;
    const p2 = e.pairs.find((p) => p.c === 2);
    if (p2 && p2.v.trim()) dimBlocks.add(p2.v.trim());
  }
  for (const e of ents) {
    if (e.blockName && /^\*D/i.test(e.blockName)) dimBlocks.add(e.blockName);
  }

  let handle = startHandle;
  let texts = 0;
  let mtext = 0;
  let polylines = 0;
  let missing = 0;
  let missingTexts = 0;
  let dimTexts = 0;
  let dimMtext = 0;
  let dimPolylines = 0;
  const repl = new Map();

  for (const e of ents) {
    if (e.type !== "TEXT" && e.type !== "MTEXT") continue;
    const isTop = e.section === "ENTITIES" && !e.block;
    const isDim = e.section === "BLOCKS" && !!e.blockName && dimBlocks.has(e.blockName);
    if (!isTop && !isDim) continue;
    /* 图纸空间（67=1）的文字也要转，但笔画必须同样写 67=1（见 lwpolylineEntity），
     * 否则标题栏文字会按图纸空间坐标画到模型空间原点附近。 */
    const inPaperSpace = numVal(e, 67, 0) === 1;
    const h = numVal(e, 40, 0);
    if (!(h > 0)) continue;

    const layerRaw = firstVal(e, 8, "0");
    const layer = layers.has(layerRaw) ? layerRaw : "0";
    const p62 = e.pairs.find((p) => p.c === 62);
    const aciRaw = p62 ? Number(p62.v) : NaN;
    const aci = Number.isFinite(aciRaw) && aciRaw > 0 && aciRaw < 256 ? aciRaw : 7;
    /* 块内文字常常没有 62（BYLAYER）——刻意不写 62，让 dxf-viewer 按插入块/图层解析，
     * 否则标注数字会被强制成 7 号色，和标注线不一个颜色。 */
    const outColor = isDim ? (p62 && Number.isFinite(aciRaw) ? aciRaw : null) : aci;
    const styleRaw = firstVal(e, 7, "STANDARD");
    /* 顶层/标注块文字：组码 7 缺失即 STANDARD（早已如此）。这里不再把"图里不存在的样式名"
     * 归一成 STANDARD —— 保持 auto 模式旧路径逐条行为不变。 */
    const style = styleRaw || "STANDARD";

    let item = null;
    if (e.type === "MTEXT") {
      /* 组码 3 是前导分块、组码 1 是末段；按文件里的顺序拼接即原文。
       * 内联码（\A1; / \H2.5; / 分组括号…）由 shx-text.js 抽成纯文本；
       * 组码 41 是 MTEXT 的**折行宽度**（不是宽度因子），下面按 width 传下去。 */
      const text = mtextToPlainText(
        e.pairs.filter((p) => p.c === 1 || p.c === 3).map((p) => p.v).join("")
      );
      if (!text) continue;
      const x = numVal(e, 10, 0);
      const y = numVal(e, 20, 0);
      const { halign, valign } = mtextAttachToAlign(numVal(e, 71, 1));
      item = {
        text,
        x,
        y,
        h,
        rot: numVal(e, 50, 0),
        wf: 1,
        /* 组码 41 = MTEXT 折行宽度。AutoCAD 按它自动折行（本图"数据机架"
         * 225 字高 / 248 宽 → 一字一行，看起来就是竖排）。 */
        width: numVal(e, 41, 0),
        halign,
        valign,
        ax: x, // 附着点就是插入点；renderShxText 用 11/21 这套锚点语义
        ay: y,
        layer,
        aci,
        style,
      };
    } else {
      const text = firstVal(e, 1);
      if (!text) continue;
      item = {
        text,
        x: numVal(e, 10, 0),
        y: numVal(e, 20, 0),
        h,
        rot: numVal(e, 50, 0),
        wf: numVal(e, 41, 1) || 1,
        halign: numVal(e, 72, 0),
        valign: numVal(e, 73, 0),
        layer,
        aci,
        style,
        ax: e.pairs.some((p) => p.c === 11) ? numVal(e, 11, 0) : null,
        ay: e.pairs.some((p) => p.c === 21) ? numVal(e, 21, 0) : null,
      };
    }

    const rendered = renderShxText(item, ctx);
    if (!rendered || !rendered.polylines.length) continue; // 非 SHX / 字体缺失 → 原实体不动
    /* 有缺字形：不要用"缺几个字"的笔画去替换原文（那等于把字吃掉）。保持原 TEXT/MTEXT，
     * 让引擎用 TTF 字体（Noto Sans SC）画完整内容；missing 仍计入统计。 */
    if (!shxTextIsComplete(rendered)) {
      missing += rendered.missing;
      missingTexts++;
      continue;
    }
    const width = eo.thick ? strokeWidthFor(h, eo) : 0;
    const rows = [];
    for (const pl of rendered.polylines) {
      const r = strokeEntityTexts(pl, handle, {
        thick: eo.thick,
        width,
        maxSolids: eo.maxSolids,
        state: eo.state,
        layer,
        color: outColor,
        inPaperSpace,
      });
      for (const row of r.rows) rows.push(row);
      handle = r.nextHandle;
    }
    repl.set(e.start, { end: e.end, text: rows.join("\r\n") });

    if (isDim) {
      dimTexts++;
      if (e.type === "MTEXT") dimMtext++;
      dimPolylines += rendered.polylines.length;
    } else {
      texts++;
      if (e.type === "MTEXT") mtext++;
    }
    polylines += rendered.polylines.length;
    missing += rendered.missing;
  }

  if (!repl.size) {
    return {
      text: s, texts: 0, mtext: 0, polylines: 0, missing: 0,
      dimTexts: 0, dimMtext: 0, dimPolylines: 0, used: 0,
      missingTexts: 0,
      thickStrokeSolids: 0, thickStrokeFallback: 0,
    };
  }

  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const r = repl.get(i);
    if (r) {
      out.push(r.text);
      i = r.end - 1;
      continue;
    }
    out.push(lines[i]);
  }
  return {
    text: out.join(eol),
    texts,
    mtext,
    polylines,
    missing,
    missingTexts,
    dimTexts,
    dimMtext,
    dimPolylines,
    used: handle - startHandle,
    thickStrokeSolids: eo.state.solids - solidsBefore,
    thickStrokeFallback: eo.state.fallback - fallbackBefore,
  };
}

/** 展开出来的块内文字 → 顶层 TEXT 实体（SHX 样式改注 LWPOLYLINE） */
export function buildBlockTextEntities(items, layers, startHandle, focus, shxCtx = null, shxStats = null, injectedStats = null, emitOpts = null, skipLayers = null) {
  const out = [];
  let h = startHandle;
  const eo = emitOptions(shxCtx, emitOpts);
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
    // 文字原始所在图层被关闭/冻结：不要展开注回（否则会"复活"隐藏图层内容）
    if (skipLayers && it.layer && skipLayers.has(it.layer)) {
      if (injectedStats) injectedStats.skippedHidden++;
      continue;
    }
    const rawText = String(it.text || "");
    /* MTEXT 保留段落换行（renderShxText 按 \n 分行）；TEXT 仍是单行。
     * 兜底注回 TEXT 时下面再压平，保持 v20 的字节行为。 */
    const text = it.mtext
      ? rawText.replace(/\r\n?/g, "\n").trim()
      : rawText.replace(/[\r\n]+/g, " ").trim();
    if (!text || !(it.h > 0)) continue;
    const layer = layers.has(it.layer) ? it.layer : "0";
    let color = Number.isFinite(it.aci) && it.aci > 0 && it.aci < 256 ? it.aci : 7;
    // 注入文字按"原始所属图块"归属（block-text.js 的 flattenTexts 已带 block 字段）
    if (focus) {
      const keep =
        focus.kind === "mute"
          ? false // 对比模式：所有展开文字同样灰显
          : focus.kind === "block"
            ? focusNames.has(it.block)
            : layer === focus.name;
      if (!keep) color = FOCUS_MUTED_COLOR;
    }
    const align = Number(it.halign) || 0;
    const valign = Number(it.valign) || 0;
    // 非左/基线对齐时，DXF 用 11/21 的第二点定位；没有就用第一点
    const ax = Number.isFinite(it.ax) ? it.ax : it.x;
    const ay = Number.isFinite(it.ay) ? it.ay : it.y;
    // SHX 样式：转成笔画折线（layer/color 已按 focus 处理，直接沿用）
    if (shxCtx) {
      /* v21：MTEXT 的组码 41（wrapWidth）必须以 item.width 传进去 ——
       * shx-text.js 的 wrapByWidth 靠它复现 AutoCAD 的折行（竖排就是这么来的）。 */
      const wrapWidth = Number(it.wrapWidth) > 0 ? Number(it.wrapWidth) : 0;
      const rendered = renderShxText(
        {
          ...it,
          text,
          style: resolveStyleName(it.style),
          width: wrapWidth,
          ax,
          ay,
        },
        shxCtx
      );
      if (rendered && shxTextIsComplete(rendered)) {
        const width = eo.thick ? strokeWidthFor(Number(it.h), eo) : 0;
        for (const pl of rendered.polylines) {
          const r = strokeEntityTexts(pl, h, {
            thick: eo.thick,
            width,
            maxSolids: eo.maxSolids,
            state: eo.state,
            layer,
            color,
          });
          for (const row of r.rows) out.push(row);
          h = r.nextHandle;
        }
        if (shxStats) {
          shxStats.texts++;
          shxStats.polylines += rendered.polylines.length;
          shxStats.missing += rendered.missing;
        }
        if (injectedStats) {
          injectedStats.strokes++;
          if (it.mtext && wrapWidth > 0 && rendered.lineCount > 1) injectedStats.mtextWrapped++;
        }
        continue;
      }
      if (rendered && rendered.polylines.length && rendered.missing > 0) {
        /* 缺字：整条退回 TEXT，交给引擎的 TTF 字体画全（不能只画"有的那几个字"）。 */
        if (shxStats) shxStats.missing += rendered.missing;
        if (injectedStats) injectedStats.missingGlyphTexts = (injectedStats.missingGlyphTexts || 0) + 1;
      }
    }
    if (injectedStats) injectedStats.fallback++;
    // 兜底仍是单行 TEXT：把 MTEXT 的段落换行压回空格（TEXT 不能带换行）
    // 镜像块（it.mirror）在 SHX 不可用时无法镜像字形：位置/角度仍按累计矩阵给对，
    // 只是字形是正的（stats.mirroredTexts 已计数）。真正镜像依赖 renderShxText。
    const flatText = text.replace(/[\r\n]+/g, " ");
    const rows = [
      "0", "TEXT",
      "5", (h++).toString(16).toUpperCase(),
      "100", "AcDbEntity",
      "8", layer,
      "62", String(color),
      "100", "AcDbText",
      "10", f(it.x), "20", f(it.y), "30", "0.0",
      "40", f(it.h),
      "1", flatText,
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

/**
 * 样式名归一：**只**处理"没有样式名"的情况（组码 7 缺失/空串）→ STANDARD。
 *
 * 不把"图里不存在/当前模式没注册的样式名"强行改成 STANDARD：auto 模式下
 * 宋体/黑体这些 TTF 样式本来就不在 ctx 里，硬落到 STANDARD 会把 TTF 文字也转成笔画，
 * 等于把 auto 模式改坏。always 模式下所有 STYLE 表条目都已注册，正常的样式名都能查到。
 */
function resolveStyleName(name) {
  const n = String(name ?? "").trim();
  return n || "STANDARD";
}

/** 图纸主体范围（同目录 meta.json 里 cadcraft 算好的 contentBox）；拿不到就返回 null */
function contentBoxOf(srcPath) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(path.dirname(srcPath), "meta.json"), "utf8"));
    return m?.stats?.contentBox ?? null;
  } catch {
    return null;
  }
}

/** meta.json 的 stats.layers（只在 DXF 缺 62 时给隐藏图层过滤兜底；读不到返回 null） */
function metaLayersOf(srcPath) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(path.dirname(srcPath), "meta.json"), "utf8"));
    const ls = m?.stats?.layers;
    return Array.isArray(ls) ? ls : null;
  } catch {
    return null;
  }
}

/* ─────────────────── 图外散点过滤（v61）───────────────────
 *
 * 背景（2026-11-10 实测 `施工005-车库消防.dwg` / cache `7a75a89eebe1`）：
 *   converted.dxf 里有 5 个 HATCH 的边界顶点落在 x≈7.8e11、y≈-1.08e11（正常图面
 *   x 649k..1258k、y -123k..120k），另有一个 INSERT 插在 x≈-5.69e6。这些"游离图元"
 *   只有几个，却把引擎的硬 bounds 撑大 5~6 个数量级：默认取景 / 「全图」后整张图缩成
 *   一个点，用户看到的是"空白"。前端 `sceneRobustBox` 只是**取景**兜底，几何仍然
 *   被上传/解析/绘制，大图里还拖慢渲染；服务端直接不产出才是根治。
 *
 * 判据刻意保守：只有**实体自身（或块实例）的完整包围盒**都落在
 *   contentBox 各向外扩 `factor × 对角线`（默认 10 倍，理由见下方常量）之外才删。
 *   · 用"落在外面"而不是"中心点离得远"：横跨图面的长线、标题栏、图框都不会被误删；
 *   · 10 倍对角线是实测阈值：`施工005` 对角线 655k → 外扩 6.55M。同一张图里另有一套
 *     完整平面图在 x≈6.7e6（8.3×），3 倍阈值会误删；10 倍保留它，而真正损坏的
 *     HATCH（x≈7.8e11，差距 5 个数量级）仍然删除；
 *   · **图纸空间（67=1）一律不参与**：布局的纸张坐标与模型 contentBox 根本不是一个
 *     坐标系，用模型盒子筛布局会把整张图框/标题栏删光；
 *   · 块定义（BLOCKS 段）本身不删，只删 ENTITIES 里的顶层实例；块实例的包围盒
 *     由块定义几何递归算出（含嵌套 INSERT、块基点、缩放/旋转）；
 *   · 任何**算不出包围盒**的实体一律保留（DIMENSION/VIEWPORT/未知自定义对象等），
 *     宁可漏删也不误删。
 *
 * 开关：`options.strayFilter === false` 或环境变量 `CADVIEWER_STRAY_FILTER=0`
 * 关闭；关闭时本函数不会被调用，产物与 v59 **逐字节一致**（单测用 SHA256 锁）。
 */

/** contentBox 外扩倍数（× contentBox 对角线）。
 *
 * 最初按"3 倍"实现，实测 `施工005` 时发现会删掉**另一张完整的平面图**：
 * 该图在 x≈6.7e6/y≈3.9e5 处还有一套墙/窗/门/文字（udo-dump 里 399 段墙 + 106 个洞口，
 * 顶层 LWPOLYLINE 4,792 条），离 contentBox 只有 8.3 个对角线；3 倍阈值把它当散点删了，
 * 属于真实内容误删。放宽到 10 倍后：
 *   · 那张平面图（8.3×）保留；
 *   · 真正的损坏图元（5 个 HATCH 在 x≈7.8e11）仍然删除，余量仍有 5 个数量级；
 *   · 机柜图/智能化图在 10× 下 0 条被删（没有损坏图元）。
 * 另有绝对上限 {@link STRAY_ABS_LIMIT} 兜底：坐标超过 ±1e9（≈1000 km）一律视为损坏。
 */
export const STRAY_FILTER_FACTOR = 10;

/** 绝对坐标上限（与前端 `robustBox.ts` 的 ABS_LIMIT 同一口径）：超过即视为坐标损坏 */
export const STRAY_ABS_LIMIT = 1e9;

/** 单测/排查时最多带回多少条被删样本（避免 stats 膨胀） */
const STRAY_SAMPLE_LIMIT = 40;

/** 实体包围盒：[minX, minY, maxX, maxY]；null = 算不出（调用方必须保留） */
function strayUnionBox(a, b) {
  if (!a) return b;
  if (!b) return a;
  return [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[2], b[2]),
    Math.max(a[3], b[3]),
  ];
}

/** 从一组 (x,y) 点算包围盒；空/非有限值返回 null */
function strayBoxOfPoints(pts) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return x0 === Infinity ? null : [x0, y0, x1, y1];
}

/** 记录里所有"重复 10/20 点对"（LWPOLYLINE 顶点 / SPLINE 控制点 / LEADER 顶点） */
function strayPairsToPoints(rec, skipFirst = false) {
  const pts = [];
  let seen10 = 0;
  for (let i = 0; i < rec.pairs.length; i++) {
    const [c, v] = rec.pairs[i];
    if (c !== "10") continue;
    seen10++;
    if (skipFirst && seen10 === 1) continue;
    const ny = rec.pairs[i + 1];
    if (!ny || ny[0] !== "20") continue;
    pts.push([Number(v), Number(ny[1])]);
  }
  return pts;
}

/** 单条记录的包围盒（块内实体用块坐标；INSERT 由块定义递归展开） */
function strayEntityBox(rec, blocks, depth = 0, seen = null) {
  const t = rec.type;
  const num = (code, dflt = NaN) => {
    const v = recordPair(rec, code);
    return v == null || v === "" ? dflt : Number(v);
  };
  switch (t) {
    case "LINE":
    case "SOLID":
    case "TRACE":
    case "3DFACE": {
      const pts = [];
      for (const [xc, yc] of [["10", "20"], ["11", "21"], ["12", "22"], ["13", "23"]]) {
        const x = num(xc);
        const y = num(yc);
        if (Number.isFinite(x) && Number.isFinite(y)) pts.push([x, y]);
      }
      return strayBoxOfPoints(pts);
    }
    case "POINT":
    case "TEXT":
    case "MTEXT":
    case "ATTRIB":
    case "ATTDEF":
    case "DIMENSION": {
      const x = num("10");
      const y = num("20");
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      /* 文字/标注的锚点 + 字高留一点余量；不尝试精确字宽（10 倍对角线阈值下无意义）。
       * 关键：只用于"整盒落在图外"判断，锚点在图内就一定保留。 */
      const h = Math.abs(num("40", 0));
      const pad = Number.isFinite(h) && h > 0 ? h * 2 : 0;
      return [x - pad, y - pad, x + pad, y + pad];
    }
    case "CIRCLE":
    case "ARC": {
      const x = num("10");
      const y = num("20");
      const r = Math.abs(num("40", 0));
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(r)) return null;
      return [x - r, y - r, x + r, y + r];
    }
    case "ELLIPSE": {
      const cx = num("10");
      const cy = num("20");
      const mx = num("11");
      const my = num("21");
      if (![cx, cy, mx, my].every(Number.isFinite)) return null;
      const r = Math.hypot(mx, my);
      return [cx - r, cy - r, cx + r, cy + r];
    }
    case "LWPOLYLINE":
      return strayBoxOfPoints(strayPairsToPoints(rec));
    case "SPLINE":
    case "LEADER":
      return strayBoxOfPoints(strayPairsToPoints(rec));
    case "HATCH":
      /* HATCH 的第一对 10/20 是 elevation（通常 0,0），不是边界；
       * 若把它算进去，远处的坏 HATCH 包围盒会横跨整个图面而逃过过滤。 */
      return strayBoxOfPoints(strayPairsToPoints(rec, true));
    case "IMAGE":
    case "WIPEOUT": {
      const pts = [];
      for (const [xc, yc] of [["10", "20"], ["11", "21"]]) {
        const x = num(xc);
        const y = num(yc);
        if (Number.isFinite(x) && Number.isFinite(y)) pts.push([x, y]);
      }
      return strayBoxOfPoints(pts);
    }
    case "INSERT": {
      const name = (recordPair(rec, "2") || "").trim();
      const ix = num("10");
      const iy = num("20");
      if (!name || !Number.isFinite(ix) || !Number.isFinite(iy)) return null;
      /* 阵列插入（70/71 > 1）的副本间距不展开：算出的盒子会偏小 → 直接保留。 */
      if ((num("70", 1) > 1) || (num("71", 1) > 1)) return null;
      const child = strayBlockBox(name, blocks, depth + 1, seen);
      if (!child) return null;
      const sx = num("41", 1);
      const sy = num("42", 1);
      if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx === 0 || sy === 0) return null;
      const rot = ((Number.isFinite(num("50")) ? num("50") : 0) * Math.PI) / 180;
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      const out = [];
      for (const [px, py] of [
        [child[0], child[1]],
        [child[2], child[1]],
        [child[2], child[3]],
        [child[0], child[3]],
      ]) {
        const ax = px * sx;
        const ay = py * sy;
        out.push([ix + ax * cos - ay * sin, iy + ax * sin + ay * cos]);
      }
      return strayBoxOfPoints(out);
    }
    default:
      return null; // 未知实体：保留
  }
}

/** 块定义的内容包围盒（已减去块基点，供 INSERT 变换直接使用）；null = 不可靠 */
function strayBlockBox(name, blocks, depth = 0, seen = null) {
  const blk = blocks.get(name);
  if (!blk) return null;
  if (blk.box !== undefined) return blk.box; // 缓存（null 也缓存）
  if (depth > 8) return null;
  const mark = seen || new Set();
  if (mark.has(name)) return null; // 循环引用
  mark.add(name);

  let box = null;
  let ok = true;
  for (const rec of blk.ents) {
    if (rec.type === "SEQEND" || rec.type === "VERTEX") continue;
    if (rec.type === "POLYLINE") {
      let poly = null;
      for (const v of rec.vertices || []) {
        const bx = strayEntityBox(v, blocks, depth, mark);
        poly = strayUnionBox(poly, bx);
      }
      if (!poly) ok = false;
      else box = strayUnionBox(box, poly);
      continue;
    }
    const b = strayEntityBox(rec, blocks, depth, mark);
    if (!b) ok = false;
    else box = strayUnionBox(box, b);
  }
  mark.delete(name);
  if (box) {
    const [bx, by] = blk.base;
    box = [box[0] - bx, box[1] - by, box[2] - bx, box[3] - by];
  }
  blk.box = ok ? box : null;
  return blk.box;
}

/**
 * 判断一个包围盒是否完全落在阈值盒之外。
 * @param {number[]} box [minX, minY, maxX, maxY]
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} limit
 */
const strayOutside = (box, limit) =>
  box[2] < limit.minX ||
  box[0] > limit.maxX ||
  box[3] < limit.minY ||
  box[1] > limit.maxY ||
  /* 绝对兜底：整个实体都在 ±1e9 之外（坐标已经损坏，与 contentBox 大小无关） */
  box[0] > STRAY_ABS_LIMIT ||
  box[2] < -STRAY_ABS_LIMIT ||
  box[1] > STRAY_ABS_LIMIT ||
  box[3] < -STRAY_ABS_LIMIT;

/** 阈值盒：contentBox 各向外扩 factor × 对角线；contentBox 无效返回 null */
export function strayLimitBox(cbox, factor = STRAY_FILTER_FACTOR) {
  if (!cbox) return null;
  const w = Number(cbox.width);
  const h = Number(cbox.height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || !(w > 0) || !(h > 0)) return null;
  const diag = Math.hypot(w, h);
  const pad = diag * (Number.isFinite(factor) ? factor : STRAY_FILTER_FACTOR);
  return {
    minX: cbox.minX - pad,
    maxX: cbox.maxX + pad,
    minY: cbox.minY - pad,
    maxY: cbox.maxY + pad,
    pad,
    diag,
  };
}

/** 开关解析：options 显式优先，其次环境变量；默认开 */
export function resolveStrayFilter(options = {}, env = process.env) {
  if (options?.strayFilter === false) return false;
  if (options?.strayFilter === true) return true;
  const v = String(env?.CADVIEWER_STRAY_FILTER ?? "").trim().toLowerCase();
  if (v === "0" || v === "off" || v === "false" || v === "no") return false;
  return true;
}

/**
 * 解析 DXF 并收集 BLOCKS（块名 → 基点 + 实体记录，POLYLINE 的 VERTEX 挂到父记录上）。
 * filterStrayEntities / countEntitiesInBox 共用，避免两遍块解析逻辑漂移。
 */
function collectStrayContext(text) {
  const { records, orphan, eol } = parseDxfRecords(text);
  const blocks = new Map();
  let curBlock = null;
  for (const rec of records) {
    if (rec.section !== "BLOCKS") continue;
    if (rec.type === "BLOCK") {
      const name = (recordPair(rec, "2") || "").trim();
      curBlock = {
        base: [Number(recordPair(rec, "10")) || 0, Number(recordPair(rec, "20")) || 0],
        ents: [],
      };
      blocks.set(name, curBlock);
      continue;
    }
    if (rec.type === "ENDBLK") {
      curBlock = null;
      continue;
    }
    if (!curBlock) continue;
    if (rec.type === "VERTEX") {
      const last = curBlock.ents[curBlock.ents.length - 1];
      if (last && last.type === "POLYLINE") last.vertices.push(rec);
      continue;
    }
    if (rec.type === "POLYLINE") {
      rec.vertices = [];
      curBlock.ents.push(rec);
      continue;
    }
    if (rec.type === "SEQEND") continue;
    curBlock.ents.push(rec);
  }
  /* VERTEX 已在上面挂到父 POLYLINE，不会作为独立实体参与包围盒计算。 */
  return { records, orphan, eol, blocks };
}

/**
 * 删除"整体落在图幅阈值盒之外"的顶层实体（ENTITIES 段）。
 *
 * 只删顶层实例，不碰 BLOCKS 段结构；图纸空间（67=1）完全不参与；算不出包围盒的
 * 实体保留。返回 `{ text, removed, samples, byKind, limit }`。
 *
 * @param {string} text 当前 DXF 文本（已解码、已注入）
 * @param {{minX:number,minY:number,maxX:number,maxY:number,width:number,height:number}|null} cbox
 * @param {{factor?:number, sampleLimit?:number}} [options]
 */
export function filterStrayEntities(text, cbox, options = {}) {
  const limit = strayLimitBox(cbox, options.factor);
  const empty = {
    text,
    removed: 0,
    samples: [],
    byKind: {},
    limit,
    skipped: !limit ? "no-content-box" : null,
  };
  if (!limit) return empty;

  const { records, orphan, eol, blocks } = collectStrayContext(text);

  /* ② 遍历 ENTITIES，按"实体 + 可能的 VERTEX/ATTRIB 链"整体判定 */
  const byKind = {};
  const samples = [];
  const sampleLimit = Number.isFinite(options.sampleLimit) ? options.sampleLimit : STRAY_SAMPLE_LIMIT;
  let removed = 0;
  const out = [...orphan];

  const kill = (rec, box, extra) => {
    removed++;
    const layer = (recordPair(rec, "8") || "0").trim();
    const kind = `${layer}|${rec.type}`;
    byKind[kind] = (byKind[kind] || 0) + 1;
    if (samples.length < sampleLimit) {
      samples.push({
        handle: (recordPair(rec, "5") || "").trim(),
        type: rec.type,
        layer,
        block: extra || null,
        at: [
          Math.round(Number(recordPair(rec, "10")) * 1000) / 1000 || 0,
          Math.round(Number(recordPair(rec, "20")) * 1000) / 1000 || 0,
        ],
        box: box.map((v) => Math.round(v * 1000) / 1000),
      });
    }
  };

  let i = 0;
  while (i < records.length) {
    const rec = records[i];
    if (rec.section !== "ENTITIES" || rec.type === "SECTION" || rec.type === "ENDSEC") {
      out.push(...recordAllPairs(rec));
      i++;
      continue;
    }
    /* 图纸空间一律保留（模型 contentBox 不适用于纸张坐标） */
    if (recordIsPaper(rec)) {
      out.push(...recordAllPairs(rec));
      i++;
      continue;
    }

    if (rec.type === "POLYLINE") {
      const verts = [];
      let j = i + 1;
      while (j < records.length && records[j].type === "VERTEX") {
        verts.push(records[j]);
        j++;
      }
      /* SEQEND 也属于这条 POLYLINE 链 */
      let end = j;
      if (end < records.length && records[end].type === "SEQEND") end++;
      let box = null;
      for (const v of verts) {
        const x = Number(recordPair(v, "10"));
        const y = Number(recordPair(v, "20"));
        if (Number.isFinite(x) && Number.isFinite(y)) {
          box = strayUnionBox(box, [x, y, x, y]);
        }
      }
      if (box && strayOutside(box, limit)) {
        kill(rec, box, null);
        i = end; // 整条链一起删
        continue;
      }
      for (let k = i; k < end; k++) out.push(...recordAllPairs(records[k]));
      i = end;
      continue;
    }

    const box = strayEntityBox(rec, blocks);
    if (box && strayOutside(box, limit)) {
      const extra = rec.type === "INSERT" ? (recordPair(rec, "2") || "").trim() : null;
      kill(rec, box, extra);
      i++;
      /* INSERT 的 ATTRIB / SEQEND 跟着删（v60 起原 ATTRIB 已清，这里兜底） */
      if (rec.type === "INSERT") {
        while (
          i < records.length &&
          records[i].section === "ENTITIES" &&
          (records[i].type === "ATTRIB" || records[i].type === "SEQEND")
        ) {
          i++;
        }
      }
      continue;
    }
    out.push(...recordAllPairs(rec));
    i++;
  }

  return { text: pairsToText(out, eol), removed, samples, byKind, limit, skipped: null };
}

/**
 * 统计 ENTITIES 里与给定盒子**相交**的顶层实体数（排查/验收用；不改文本）。
 *
 * 与过滤共用同一套包围盒算法：过滤只删"整盒在阈值盒之外"的实体，因此
 * `countEntitiesInBox(过滤前).inside === countEntitiesInBox(过滤后).inside` 必须成立。
 * 图纸空间（67=1）不计入；算不出包围盒的实体计入 `unknown`（它们永远保留）。
 *
 * @param {string} text
 * @param {{minX:number,minY:number,maxX:number,maxY:number}|null} box
 */
export function countEntitiesInBox(text, box) {
  if (!box) return { total: 0, inside: 0, outside: 0, unknown: 0, paper: 0 };
  const { records, blocks } = collectStrayContext(text);
  let total = 0;
  let inside = 0;
  let unknown = 0;
  let paper = 0;
  const hit = (b) =>
    b[2] >= box.minX && b[0] <= box.maxX && b[3] >= box.minY && b[1] <= box.maxY;
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (rec.section !== "ENTITIES" || rec.type === "SECTION" || rec.type === "ENDSEC") continue;
    if (recordIsPaper(rec)) {
      paper++;
      continue;
    }
    let b = null;
    if (rec.type === "POLYLINE") {
      for (let j = i + 1; j < records.length && records[j].type === "VERTEX"; j++) {
        const x = Number(recordPair(records[j], "10"));
        const y = Number(recordPair(records[j], "20"));
        if (Number.isFinite(x) && Number.isFinite(y)) b = strayUnionBox(b, [x, y, x, y]);
      }
    } else {
      b = strayEntityBox(rec, blocks);
    }
    total++;
    if (!b) unknown++;
    else if (hit(b)) inside++;
  }
  return { total, inside, outside: total - inside - unknown, unknown, paper };
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
export function filterFlatTexts(items, cbox, stats = null) {
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

  /* ② 文字自身分布给出的第二个容忍区（v35，2026-11-08 实测勿删）。
   *
   * contentBox 只统计**顶层锚点**（scanner.js 不收集 BLOCKS 段坐标），因此"图面内容几乎
   * 全在块里"的图纸会得到一个小得多的 contentBox。实测 `机柜图纸.dwg`（e532f3d279cb）：
   * contentBox y -344,766..-195,520，而图纸实际从 y=53,648 排到 -679,866（上 1 张 + 中 8 张
   * + 下 2 张）。下方两张图里的 3,694 条文字（新增设备 3028 / 空调 472 / 走线架编号 94 /
   * AXIS_TEXT 34 …）全部落在 oy0 之外，被当成"垃圾"丢弃 —— 用户看到的"房间名/标注/轴号
   * 大量缺失"就是这一条。
   *
   * 修法不去猜 contentBox，而是用**文字自己的分布**再做一层：每轴 Q1/Q3 ± 3·IQR
   * （k=3 比 1.5 宽松；这里 47% 的文字都在下方两张图上，本来就不是离群点）。
   * 两个容忍区取并集：contentBox 区内的照旧保留，contentBox 外的只要在文字分布区内也保留；
   * 只有两个区都够不着的才是真垃圾（本图实测丢弃 3,694 → 0）。
   */
  const xs = [];
  const ys = [];
  for (const it of items) {
    if (Number.isFinite(it.x) && Number.isFinite(it.y)) {
      xs.push(it.x);
      ys.push(it.y);
    }
  }
  const fence = (arr) => {
    if (arr.length < 8) return null;
    const s = [...arr].sort((a, b) => a - b);
    const q = (p) => s[Math.floor((s.length - 1) * p)];
    const q1 = q(0.25);
    const q3 = q(0.75);
    const iqr = q3 - q1;
    if (!(iqr > 0)) return [s[0], s[s.length - 1]];
    return [q1 - 3 * iqr, q3 + 3 * iqr];
  };
  const fx = fence(xs);
  const fy = fence(ys);
  const inTextZone = (x, y) =>
    !fx || !fy ? false : x >= fx[0] && x <= fx[1] && y >= fy[0] && y <= fy[1];
  const plausibleByTexts = (x, y, h) => inTextZone(x, y) && hOk(h);

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
    if (plausibleByTexts(it.x, it.y, it.h)) {
      out.push(it); // contentBox 太小、但落在文字自身分布里：保留
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
    // 两个容忍区都够不着、raw 也一样，才当垃圾丢弃
    if (posFar(it.x, it.y) && !inTextZone(it.x, it.y) && (r ? posFar(r.x, r.y) : true)) {
      dropped++;
      continue;
    }
    out.push(it); // 其余（如字高偏小的属性标注）保守保留变换后的候选
    kept++;
  }
  done(kept, raw, dropped);
  return out;
}

/* ─────────────────── 模型 / 布局空间（v34）───────────────────
 *
 * 背景（实测 `施工005-车库消防.dwg` / cache `7a75a89eebe1`）：
 *   · ENTITIES 段同时写了模型空间实体（组码 67 缺省/0）与图纸空间实体（67=1）。
 *     图纸坐标 x≈1000..2900 / y≈-1600..950，模型坐标约 ±1,200,000 —— 差 3 个数量级，
 *     同场景渲染就是"一大片空白里漂着图框"。
 *   · VIEWPORT 实体引擎不认识，所以布局视口里该显示的模型内容完全没画。
 *
 * LAYOUT 表实测结构（**别被组码 2 骗了**，例：`7a75a89eebe1` 的 `平面图`）：
 *   0/LAYOUT 5/5BC0C 330/5BBD5 100/AcDbPlotSettings 1/(空) 2/pdfFactory Pro.pc3 …
 *   100/AcDbLayout 1/平面图 70/1 71/1 … 330/5B9DB
 *   → 组码 2 是**打印机/绘图仪名**（none_device / pdfFactory Pro.pc3），不是块名；
 *   → 布局名是 `AcDbLayout` 子类里的**组码 1**；
 *   → 关联的图纸空间块由 `AcDbLayout` 里的 **330（BLOCK_RECORD 句柄）** 给出：
 *     5B9DB → BLOCK_RECORD/2 = `*Paper_Space`（5B9DA → `*Model_Space`）；
 *   → 本文件两个 LAYOUT 的 70 都是 1，**不能**用 70 区分 Model，只能看布局名/块名。
 */

/** 视口矩形裁剪后允许的数值误差（模型单位） */
const SPACE_EPS = 1e-9;

/** 每个视口注入内容时，圆弧离散角度（越大顶点越少、文件越小） */
const SPACE_ARC_STEP_DEG = 20;

/**
 * 解析 `space` 查询串：`model` | `layout:<布局名>`。
 * 非法串返回 null（上层当作"没传"，保持旧的合并渲染）。
 */
export function parseSpace(spec) {
  if (typeof spec !== "string") return null;
  const s = spec.trim();
  if (s === "model") return { kind: "model", spec: "model", name: "模型" };
  if (s.startsWith("layout:")) {
    const name = s.slice("layout:".length);
    if (!name) return null;
    return { kind: "layout", spec: `layout:${name}`, name };
  }
  return null;
}

/**
 * 解析 DXF 文本的 LAYOUT 表（OBJECTS 段）。只做一次轻量顺序扫描，不建完整记录表。
 * @returns {Array<{name:string, blockName:string|null, recordHandle:string, order:number|null}>}
 */
export function parseLayouts(text) {
  const lines = text.split(/\r?\n/);
  const blockRecords = new Map(); // BLOCK_RECORD 句柄 → 块名
  const layouts = [];
  let curType = null;
  let inAcDbLayout = false;
  let recHandle = null;
  let recName = null;
  let lay = null;

  const flush = () => {
    if (curType === "BLOCK_RECORD" && recHandle && recName) blockRecords.set(recHandle, recName);
    if (curType === "LAYOUT" && lay && lay.recordHandle) layouts.push(lay);
    curType = null;
    lay = null;
    inAcDbLayout = false;
    recHandle = null;
    recName = null;
  };

  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i].trim();
    const value = lines[i + 1];
    if (code === "0") {
      flush();
      curType = value.trim();
      if (curType === "LAYOUT") lay = { name: null, recordHandle: null, order: null };
      continue;
    }
    if (curType === "BLOCK_RECORD") {
      if (code === "5") recHandle = value.trim();
      else if (code === "2") recName = value.trim();
      continue;
    }
    if (curType === "LAYOUT" && lay) {
      if (code === "100" && value.trim() === "AcDbLayout") {
        inAcDbLayout = true;
        continue;
      }
      if (!inAcDbLayout) continue; // AcDbPlotSettings 里的 1/2/330 一概不采信
      if (code === "1") lay.name = value.trim();
      else if (code === "330") lay.recordHandle = value.trim();
      else if (code === "71") lay.order = Number(value);
    }
  }
  flush();

  return layouts
    .filter((l) => l.name)
    .map((l) => ({
      name: decodeUnicodeEscapes(l.name),
      blockName: blockRecords.get(l.recordHandle) ?? null,
      recordHandle: l.recordHandle,
      order: l.order,
    }));
}

/** 布局是否就是"模型"页（Model 布局 / *Model_Space 块），不进页签列表 */
function isModelLayout(layout) {
  return (
    layout.name === "Model" ||
    (layout.blockName != null && /^\*model_space/i.test(layout.blockName))
  );
}

/** 从 DXF 文本生成页签列表：`模型` + 每个 LAYOUT。 */
export function listSpaces(text) {
  const layouts = parseLayouts(text);
  const seen = new Set();
  const spaces = [{ id: "model", name: "模型" }];
  // 按 LAYOUT 的 71（页签顺序）排；缺省排到最后
  const ordered = [...layouts].sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9));
  for (const l of ordered) {
    if (isModelLayout(l) || seen.has(l.name)) continue;
    seen.add(l.name);
    spaces.push({ id: `layout:${l.name}`, name: l.name });
  }
  return spaces;
}

/**
 * 从 DXF 源文件生成页签列表（供 `/api/open` 用）。
 * 读不到/解析失败时只返回"模型"，绝不影响开图。
 */
export function spacesForFile(srcPath) {
  try {
    const { s } = decodeDxfBuffer(fs.readFileSync(srcPath));
    return listSpaces(decodeUnicodeEscapes(s));
  } catch {
    return [{ id: "model", name: "模型" }];
  }
}

/** 编码自适应解码（buildWebDxf 与 spacesForFile 共用，逻辑见 buildWebDxf 内注释） */
function decodeDxfBuffer(buf) {
  try {
    return { s: new TextDecoder("utf-8", { fatal: true }).decode(buf), encoding: "utf-8" };
  } catch {
    const legacy = resolveLegacyEncoding(buf);
    try {
      return { s: new TextDecoder(legacy).decode(buf), encoding: legacy };
    } catch {
      return { s: buf.toString("utf8"), encoding: "utf-8(loose)" };
    }
  }
}

/**
 * 把 DXF 拆成「组码对 + 记录」两层视图。
 * record = { type, section, block, pairs:[[code,value]...] }；
 * `block` 是记录所属的 BLOCK 定义名（顶层实体为 null）。
 * 重建时按 records 顺序拼回 pairs，能保证原字节语义不变（只丢行首缩进）。
 */
function parseDxfRecords(text) {
  const lines = text.split(/\r?\n/);
  const pairs = [];
  const records = [];
  const orphan = []; // 首个 0 组码之前的内容（注释等）
  let section = null;
  let pendingSection = false;
  let block = null;
  let cur = null;

  const flush = () => {
    if (!cur) return;
    records.push(cur);
    if (cur.type === "BLOCK") {
      const p2 = cur.pairs.find((p) => p[0] === "2");
      block = p2 ? p2[1].trim() : null;
    } else if (cur.type === "ENDBLK") {
      block = null;
    }
    cur = null;
  };

  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i].trim();
    const value = lines[i + 1];
    const idx = pairs.length;
    pairs.push([code, value]);
    if (code === "0") {
      flush();
      const type = value.trim();
      cur = { type, section, block, pairs: [], start: idx, end: idx };
      if (type === "SECTION") pendingSection = true;
      if (type === "ENDSEC") section = null;
      continue;
    }
    if (pendingSection && code === "2") {
      section = value.trim();
      if (cur) cur.section = section;
      pendingSection = false;
    }
    if (!cur) {
      orphan.push([code, value]);
      continue;
    }
    cur.pairs.push([code, value]);
    cur.end = idx;
  }
  flush();

  return { pairs, records, orphan, eol: text.includes("\r\n") ? "\r\n" : "\n" };
}

const recordPair = (rec, code) => {
  const key = String(code);
  const p = rec.pairs.find((x) => x[0] === key);
  return p ? p[1] : null;
};
const recordNumber = (rec, code) => {
  const v = recordPair(rec, code);
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const recordIsPaper = (rec) => String(recordPair(rec, "67") ?? "").trim() === "1";

/** pairs → 文本 */
function pairsToText(pairs, eol = "\n") {
  const out = [];
  for (const [c, v] of pairs) out.push(c, v);
  return out.join(eol) + eol;
}

/** 记录的完整组码对：记录对象用 `.type` 保存了"0 组码"的值，重建时必须补回 */
const recordAllPairs = (rec) => [["0", rec.type], ...rec.pairs];

/**
 * `space=model`：删掉所有图纸空间（67=1）实体。
 * ENTITIES 段整条删除；BLOCKS 段只删显式 67=1 的子实体，保留 BLOCK/ENDBLK 结构
 * （否则块记录会残缺）。图纸空间 INSERT 后面的 ATTRIB/SEQEND 一并删除。
 */
export function filterModelSpace(text) {
  const { records, orphan, eol } = parseDxfRecords(text);
  let removed = 0;
  let dropAttrib = false;
  const out = [...orphan];

  for (const rec of records) {
    const structural = rec.type === "SECTION" || rec.type === "ENDSEC" || rec.type === "EOF";
    if (structural || (rec.section !== "ENTITIES" && rec.section !== "BLOCKS")) {
      out.push(...recordAllPairs(rec));
      if (rec.type === "ENDBLK" || rec.type === "SECTION" || rec.type === "ENDSEC") dropAttrib = false;
      continue;
    }
    if (rec.section === "BLOCKS" && (rec.type === "BLOCK" || rec.type === "ENDBLK")) {
      out.push(...recordAllPairs(rec));
      continue;
    }

    let paper = recordIsPaper(rec);
    if (rec.type === "ATTRIB" || rec.type === "SEQEND") paper = dropAttrib;
    if (rec.type === "INSERT") dropAttrib = paper;
    else if (rec.type !== "ATTRIB" && rec.type !== "SEQEND") dropAttrib = false;

    if (paper) {
      removed++;
      continue;
    }
    out.push(...recordAllPairs(rec));
  }
  return { text: pairsToText(out, eol), removed };
}

/** 视口记录 → 参数（组码含义见 DXF 规范 AcDbViewport） */
function parseViewport(rec) {
  return {
    handle: recordPair(rec, "5") || "",
    layer: recordPair(rec, "8") || "0",
    cx: recordNumber(rec, 10),
    cy: recordNumber(rec, 20),
    w: recordNumber(rec, 40),
    h: recordNumber(rec, 41),
    status: recordNumber(rec, 68) ?? 0,
    vx: recordNumber(rec, 12),
    vy: recordNumber(rec, 22),
    vh: recordNumber(rec, 45),
    twist: recordNumber(rec, 51) ?? 0,
  };
}

/** 线段按矩形裁剪（Liang–Barsky），返回 [t0,t1] 或 null */
function clipSegment(a, b, rect) {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const ps = [-dx, dx, -dy, dy];
  const qs = [a[0] - rect.minX, rect.maxX - a[0], a[1] - rect.minY, rect.maxY - a[1]];
  for (let i = 0; i < 4; i++) {
    const p = ps[i];
    const q = qs[i];
    if (Math.abs(p) < SPACE_EPS) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  return [t0, t1];
}

const samePoint = (a, b) =>
  Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;

const lerpPoint = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/**
 * 多段线按矩形裁剪 → 若干连续可见段（每条是一串点）。
 * 整条在矩形内时调用方会直接保留原实体，不走这里；
 * 跨边界时 bulge（组码 42）会退化成直线 —— 见报告里的已知限制。
 */
function clipPolylineRuns(points, closed, rect) {
  const runs = [];
  let cur = null;
  const addSeg = (a, b) => {
    const t = clipSegment(a, b, rect);
    if (!t) {
      cur = null;
      return;
    }
    const p0 = lerpPoint(a, b, t[0]);
    const p1 = lerpPoint(a, b, t[1]);
    if (cur && samePoint(cur[cur.length - 1], p0)) {
      if (!samePoint(cur[cur.length - 1], p1)) cur.push(p1);
    } else {
      cur = [p0, p1];
      runs.push(cur);
    }
    // 出了矩形：下一段要重新开一条
    if (t[1] < 1 - 1e-12) cur = null;
  };
  for (let i = 0; i + 1 < points.length; i++) addSeg(points[i], points[i + 1]);
  if (closed && points.length > 2) addSeg(points[points.length - 1], points[0]);
  return runs.filter((r) => r.length >= 2);
}

/**
 * 生成某个布局的 DXF：只保留该布局的图纸空间实体，并把每个 VIEWPORT 内的模型内容
 * 按视口参数变换、裁剪后注回。
 *
 * 变换：paper = C + k·R(twist)·(model - V)
 *   C = 视口中心（10/20，纸张坐标）  V = 视图中心（12/22，模型坐标）
 *   k = 视口高（41）/视图高（45）    R = 扭转角（51）
 * 做法：不是逐点改写模型实体，而是把它们放进一个新块 `*CV_VP_*`，再在图纸空间放一个
 * INSERT（位置/缩放/旋转即为上式）—— 块内文字、块嵌套、线宽会由引擎一起正确变换。
 *
 * @returns {{text:string, stats:object}|null} 布局不存在时返回 null（上层回落模型空间）
 */
function buildLayoutSpace(srcText, layoutName, blockSpaceViewportClip = false) {
  const { records, orphan, eol } = parseDxfRecords(srcText);
  const layouts = parseLayouts(srcText);
  const layout = layouts.find((l) => l.name === layoutName && !isModelLayout(l));
  if (!layout) return null;

  const recordHandle = layout.recordHandle;

  /* ① 该布局的图纸空间实体：优先按 owner(330)=BLOCK_RECORD 句柄区分（多布局时唯一可靠） */
  const kept = new Set();
  const viewportRecords = [];
  let paperInsert = false;
  for (const rec of records) {
    if (rec.section !== "ENTITIES" || rec.type === "SECTION" || rec.type === "ENDSEC") continue;
    let paper = recordIsPaper(rec);
    if (rec.type === "ATTRIB" || rec.type === "SEQEND") paper = paperInsert;
    if (rec.type === "INSERT") paperInsert = paper;
    else if (rec.type !== "ATTRIB" && rec.type !== "SEQEND") paperInsert = false;
    if (!paper) continue;
    const owner = recordPair(rec, "330");
    // 老文件可能不写 330：此时认为所有 67=1 实体都属于这个（唯一）布局
    if (recordHandle && owner && owner !== recordHandle) continue;
    if (rec.type === "VIEWPORT") {
      viewportRecords.push(rec);
      continue;
    }
    kept.add(rec);
  }

  const viewports = viewportRecords
    .map(parseViewport)
    .filter(
      (v) =>
        v.status >= 0 &&
        Number.isFinite(v.cx) && Number.isFinite(v.cy) &&
        Number.isFinite(v.vx) && Number.isFinite(v.vy) &&
        Number.isFinite(v.vh) && v.vh > 0 &&
        Number.isFinite(v.w) && v.w > 0 &&
        Number.isFinite(v.h) && v.h > 0
    );

  /* ② 模型空间实体（dxf-parser 视角：几何/嵌套块/尺寸块都已摊平到 WCS） */
  let dxf = null;
  try {
    dxf = new DxfParser().parseSync(srcText);
  } catch {
    dxf = null;
  }
  const paperOwners = new Set();
  for (const [name, b] of Object.entries(dxf?.blocks || {})) {
    if (!b) continue;
    if ((b.paperSpace === true || /^\*paper_space/i.test(name)) && b.ownerHandle) {
      paperOwners.add(String(b.ownerHandle));
    }
  }
  const rawModel = (dxf?.entities || []).filter(
    (e) =>
      e && e.type &&
      e.inPaperSpace !== true &&
      !(e.ownerHandle && paperOwners.has(String(e.ownerHandle)))
  );
  const geomCtx = {
    blocks: dxf?.blocks || {},
    warnings: new Set(),
    maxDepth: 24,
    includeHatch: false,
    arcStepDeg: SPACE_ARC_STEP_DEG,
  };

  /* 顶层实体记录（按句柄），用于"完全落在视口内就原样拷贝"的路径 */
  const recordsByHandle = new Map();
  const attribRecords = [];
  for (const rec of records) {
    if (rec.section !== "ENTITIES" || rec.type === "SECTION" || rec.type === "ENDSEC") continue;
    if (recordIsPaper(rec)) continue;
    if (rec.type === "ATTRIB") attribRecords.push(rec);
    const h = recordPair(rec, "5");
    if (h) recordsByHandle.set(String(h).trim(), rec);
  }

  let hnext = maxHandle(srcText) + 1;
  const nextHandle = () => (hnext++).toString(16).toUpperCase();

  const newBlocks = [];
  const newEntities = [];

  /* ── 超大块定义拆分（v57）──────────────────────────────────────────────
   * dxf-viewer 的单次 `Merge()` 上限是 65 536 顶点，超了整条 INSERT 被丢弃
   * （实测施工005：块 `A$C29980DFE` 单块约 169 000 顶点 → 4 个视口 INSERT 全被跳过，
   * 布局页只剩零星线条、文字全无）。这个块是**一个** INSERT，拆视口内容解决不了，
   * 必须把它引用的块定义按实体切成多个子块，再用同样的变换克隆 INSERT。
   * 子块沿用原块的基点/坐标系，所以几何完全不变；原 XDATA（XCLIP）随 INSERT 一起复制。 */
  const blockRecords = new Map(); // 块名 -> { headerPairs, entityRecords }
  {
    let cur = null;
    for (const rec of records) {
      if (rec.section !== "BLOCKS" || rec.type === "SECTION" || rec.type === "ENDSEC") continue;
      if (rec.type === "BLOCK") {
        cur = { headerPairs: [], entityRecords: [] };
        blockRecords.set(String(recordPair(rec, "2") ?? "").trim(), cur);
        for (const [c, v] of rec.pairs) {
          if (c === "2" || c === "3" || c === "1") continue;
          cur.headerPairs.push([c, v]);
        }
        continue;
      }
      if (rec.type === "ENDBLK") { cur = null; continue; }
      if (cur) cur.entityRecords.push(rec);
    }
  }
  const recordVertices = (rec) => {
    let n = 0;
    for (const [c] of rec.pairs) if (c === "10" || c === "11" || c === "13" || c === "14") n++;
    return Math.max(2, n);
  };
  /** 估算一条块内记录（含嵌套块）的顶点数 */
  const entityRecordVertices = (rec, depth = 0) => {
    if (rec.type === "INSERT") {
      const name = String(recordPair(rec, "2") ?? "").trim();
      const sub = blockRecords.get(name);
      if (!sub || depth > 4) return 64;
      let n = 0;
      for (const r of sub.entityRecords) n += entityRecordVertices(r, depth + 1);
      return Math.max(64, n);
    }
    if (rec.type === "ATTRIB" || rec.type === "SEQEND" || rec.type === "ATTDEF") return 32;
    return recordVertices(rec);
  };
  /** 把一条超大块定义拆成若干子块，返回子块名（失败返回空数组） */
  const splitOversizedBlock = (blockName, budget) => {
    const src = blockRecords.get(blockName);
    if (!src || src.entityRecords.length < 2) return [];
    const groups = [];
    let group = [];
    let verts = 0;
    for (const rec of src.entityRecords) {
      /* ATTRIB / SEQEND 必须留在他前面的 INSERT 所在的子块里 */
      if (rec.type === "ATTRIB" || rec.type === "SEQEND") {
        if (!group.length) group.push(rec);
        else group.push(rec);
        continue;
      }
      const v = entityRecordVertices(rec);
      if (group.length && verts + v > budget) {
        groups.push(group);
        group = [];
        verts = 0;
      }
      group.push(rec);
      verts += v;
    }
    if (group.length) groups.push(group);
    if (groups.length < 2) return [];
    const names = [];
    const cloneEntity = (rec) => {
      const newH = nextHandle();
      return [
        ["0", rec.type],
        ...rec.pairs.map(([c, v]) => (c === "5" ? [c, newH] : [c, v])),
      ];
    };
    for (let i = 0; i < groups.length; i++) {
      const name = `${blockName}__CV${i + 1}`;
      const pairs = [
        ["0", "BLOCK"],
        ["5", nextHandle()],
        ...src.headerPairs.map(([c, v]) => [c, v]),
        ["2", name],
        ["3", name],
        ["1", ""],
      ];
      for (const rec of groups[i]) for (const p of cloneEntity(rec)) pairs.push(p);
      pairs.push(["0", "ENDBLK"], ["5", nextHandle()], ["100", "AcDbEntity"], ["8", "0"], ["100", "AcDbBlockEnd"]);
      newBlocks.push(pairs);
      names.push(name);
    }
    return names;
  };

  const emitLwPolyline = (points, layer, colorIndex) => {
    const pairs = [
      ["0", "LWPOLYLINE"],
      ["5", nextHandle()],
      ["100", "AcDbEntity"],
      ["8", layer || "0"],
    ];
    if (colorIndex && colorIndex !== 0 && colorIndex !== 256) pairs.push(["62", String(colorIndex)]);
    pairs.push(["100", "AcDbPolyline"], ["90", String(points.length)], ["70", "0"]);
    for (const [x, y] of points) pairs.push(["10", f(x)], ["20", f(y)]);
    return pairs;
  };

  const emitText = (p, layer, colorIndex) => {
    const text = String(p.text ?? "").replace(/[\r\n]+/g, " ");
    if (!text) return null;
    const pairs = [
      ["0", "TEXT"],
      ["5", nextHandle()],
      ["100", "AcDbEntity"],
      ["8", p.layer || layer || "0"],
    ];
    if (colorIndex && colorIndex !== 0 && colorIndex !== 256) pairs.push(["62", String(colorIndex)]);
    pairs.push(
      ["100", "AcDbText"],
      ["10", f(p.x)],
      ["20", f(p.y)],
      ["40", f(Math.max(1e-9, p.height || 0))],
      ["1", text]
    );
    if (p.rotation) pairs.push(["50", f(p.rotation)]);
    return pairs;
  };

  /**
   * 视口内的文字**不进视口块**，直接变换到纸张空间写成 67=1 的顶层 TEXT（v57）。
   *
   * 原因（实测，不是猜的）：dxf-viewer 的 `Merge()` 按"单条 INSERT 一次合并"计数，
   * 上限 65 536 顶点；中文文字经 curveSubdivision=16 离散后每个字≈500–600 顶点，
   * 一个视口上千条标签就是 19 万顶点 → 整条视口 INSERT 被引擎丢弃
   * （控制台 `Vertices count exceeds chunk limit`，页面表现为"视口里只剩零星线条"）。
   * 纸张空间的顶层 TEXT 走另一条渲染路径（逐条 PushChunk），不会触发该上限，
   * 而且纸张空间本来就该放文字。几何仍然留在 `*CV_VP_*` 块里（可被 XCLIP 裁）。
   *
   * @returns {?Array<[string,string]>} 纸张坐标的 TEXT 记录
   */
  const emitViewportText = (p, layer, colorIndex, vp, k, cos, sin) => {
    const text = String(p.text ?? "").replace(/[\r\n]+/g, " ");
    if (!text) return null;
    const dx = p.x - vp.vx;
    const dy = p.y - vp.vy;
    const px = vp.cx + k * (cos * dx - sin * dy);
    const py = vp.cy + k * (sin * dx + cos * dy);
    const h = Math.max(1e-9, (p.height || 0) * k);
    const pairs = [
      ["0", "TEXT"],
      ["5", nextHandle()],
      ["100", "AcDbEntity"],
      ["67", "1"],
      ["8", p.layer || layer || "0"],
    ];
    if (colorIndex && colorIndex !== 0 && colorIndex !== 256) pairs.push(["62", String(colorIndex)]);
    pairs.push(
      ["100", "AcDbText"],
      ["10", f(px)],
      ["20", f(py)],
      ["40", f(h)],
      ["1", text]
    );
    const rot = (Number(p.rotation) || 0) + (vp.twist || 0);
    if (rot) pairs.push(["50", f(rot)]);
    return pairs;
  };

  /** 拷贝一条记录并换新句柄；同时登记旧→新句柄映射（供 ATTRIB 的 owner 330 改写） */
  const cloneRecord = (rec, idMap) => {
    const oldH = recordPair(rec, "5");
    const newH = nextHandle();
    if (oldH) idMap.set(String(oldH).trim(), newH);
    // ⚠️ record.pairs 不含 "0 组码"（记录类型放在 rec.type 上），拷贝时必须补回，
    //    否则新实体会粘在上一条实体尾部，解析器直接把它当上一条的组码。
    return [
      ["0", rec.type],
      ...rec.pairs.map(([c, v]) => (c === "5" ? [c, newH] : [c, v])),
    ];
  };

  /* dxf-viewer 的 `Merge()` 有**单次** 65 536 顶点上限（`PushChunk` 抛
   * "Vertices count exceeds chunk limit" 时整条 INSERT 被丢弃）。视口块是"一次 Merge"，
   * 施工005 的 4 个大视口每个约 19 万顶点 → 4 条 INSERT 全被引擎跳过，页面表现为
   * "视口里只剩零星线条、文字全无"。所以这里按顶点预算把视口内容切成多块，
   * 每块一个 `*CV_VP_*` 块 + INSERT（同一变换/同一裁剪盒），单次 Merge 就不会超限。
   * 实测预算 20 000 顶点留足余量（引擎上限 65 536，文字/圆弧的实际顶点数波动很大）。 */
  const VIEWPORT_VERTEX_BUDGET = 20000;
  const blockVertexCache = new Map();
  const splitBlockCache = new Map();
  const estimateBlockVertices = (name, depth = 0) => {
    if (!name) return 64;
    if (blockVertexCache.has(name)) return blockVertexCache.get(name);
    let n = 64;
    const b = dxf?.blocks?.[name];
    if (b && depth < 5) {
      n = 0;
      for (const e of b.entities || []) {
        if (!e) continue;
        if (e.type === "INSERT") n += estimateBlockVertices(e.name, depth + 1);
        else if (Array.isArray(e.vertices)) n += Math.max(2, e.vertices.length);
        else if (e.type === "CIRCLE" || e.type === "ARC") n += 96;
        else n += 16;
      }
    }
    blockVertexCache.set(name, n);
    return n;
  };
  /** 单条记录的顶点估算（只用于分块，宁可高估）。 */
  const estimateEntityVertices = (raw) => {
    if (!raw) return 256;
    switch (raw.type) {
      case "INSERT":
        return Math.max(64, estimateBlockVertices(raw.name));
      case "TEXT":
      case "MTEXT":
      case "ATTRIB":
      case "ATTDEF":
        /* 文字是顶点大户：dxf-viewer 用 curveSubdivision=16 把每个字形轮廓离散成三角形，
         * 实测施工005 一段 10 字左右的中文标签 ≈ 4–5 千顶点（41 条 TEXT 就 19 万）。
         * 估算按 600 顶点/字，宁高不低 —— 低估会让一个块在 Merge 时超限被整条丢弃。 */
        return Math.max(2000, String(raw.text ?? "").length * 600);
      case "CIRCLE":
      case "ARC":
        return 96;
      case "HATCH":
        return 512;
      case "DIMENSION":
        return 256;
      default:
        return Array.isArray(raw.vertices) ? Math.max(2, raw.vertices.length) : 32;
    }
  };

  /**
   * 超大 INSERT 的拆块：块定义的顶点数超过预算时，把块定义按实体切成子块，
   * 再用**同一个** INSERT 记录（同变换、同 XDATA/裁剪）克隆出 N 条指向子块。
   * 子块沿用原块基点，几何坐标不变；同一块只拆一次（`splitBlockCache`）。
   * @returns {boolean} true 表示已拆并写入 items（调用方 continue）
   */
  const splitOversizedInsert = (rec, raw, items, idMap, stats) => {
    if (estimateEntityVertices(raw) <= VIEWPORT_VERTEX_BUDGET) return false;
    const key = String(raw.name ?? "").trim();
    let subNames = splitBlockCache.get(key);
    if (subNames === undefined) {
      subNames = splitOversizedBlock(key, VIEWPORT_VERTEX_BUDGET);
      splitBlockCache.set(key, subNames);
    }
    if (!subNames.length) return false;
    for (const sub of subNames) {
      const pairs = cloneRecord(rec, idMap);
      for (const p of pairs) if (p[0] === "2") p[1] = sub;
      items.push({ pairs, verts: VIEWPORT_VERTEX_BUDGET, structured: true });
      stats.copied++;
    }
    stats.splitInserts = (stats.splitInserts || 0) + 1;
    stats.splitBlocks = (stats.splitBlocks || 0) + subNames.length;
    return true;
  };
  const stats = {
    space: `layout:${layout.name}`,
    layout: layout.name,
    layoutBlock: layout.blockName,
    paperEntities: kept.size,
    viewports: viewports.length,
    viewportsSkipped: viewportRecords.length - viewports.length,
    copied: 0,
    clipped: 0,
    clippedPolylines: 0,
    injectedTexts: 0,
    attribs: 0,
    skippedNoBBox: 0,
  };

  for (const vp of viewports) {
    const k = vp.h / vp.vh;
    const halfH = vp.vh / 2;
    const halfW = vp.vh * (vp.w / vp.h) / 2;
    const rect = {
      minX: vp.vx - halfW,
      maxX: vp.vx + halfW,
      minY: vp.vy - halfH,
      maxY: vp.vy + halfH,
    };
    const inRect = (x, y) => x >= rect.minX && x <= rect.maxX && y >= rect.minY && y <= rect.maxY;
    const insideRect = (b) =>
      b.minX >= rect.minX && b.maxX <= rect.maxX && b.minY >= rect.minY && b.maxY <= rect.maxY;
    const outsideRect = (b) =>
      b.minX > rect.maxX || b.maxX < rect.minX || b.minY > rect.maxY || b.maxY < rect.minY;

    const items = [];
    const idMap = new Map();
    /* 视口 → 纸张的变换参数：paper = C + k·R(twist)·(model − V) */
    const rad = (vp.twist * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const px = vp.cx - k * (cos * vp.vx - sin * vp.vy);
    const py = vp.cy - k * (sin * vp.vx + cos * vp.vy);

    for (const raw of rawModel) {
      let geom;
      try {
        geom = entityToPrimitives(raw, geomCtx);
      } catch {
        continue;
      }
      const bbox = geom.bbox;
      if (!bbox) {
        stats.skippedNoBBox++;
        continue;
      }
      if (outsideRect(bbox)) continue;

      /* 文字（TEXT/MTEXT/ATTRIB/ATTDEF）：不进视口块，直接变换成纸张空间的顶层 TEXT。
       * 见 emitViewportText 的说明 —— 文字是顶点大户，进块会把整条视口 INSERT 顶爆。 */
      if (raw.type === "TEXT" || raw.type === "MTEXT" || raw.type === "ATTRIB" || raw.type === "ATTDEF") {
        const tLayer = typeof raw.layer === "string" ? raw.layer : "0";
        const tColor = Number.isFinite(raw.colorIndex) ? raw.colorIndex : null;
        for (const prim of geom.primitives) {
          if (prim.kind !== "text") continue;
          if (!inRect(prim.x, prim.y)) continue;
          const pairs = emitViewportText(prim, tLayer, tColor, vp, k, cos, sin);
          if (!pairs) continue;
          newEntities.push(pairs);
          stats.paperTexts = (stats.paperTexts || 0) + 1;
        }
        continue;
      }

      const rec = recordsByHandle.get(String(raw.handle ?? "").trim());
      if (insideRect(bbox) && rec) {
        // 完全在视口内：原样拷贝，图层/颜色/块结构/文字样式全部保留
        if (raw.type === "INSERT" && splitOversizedInsert(rec, raw, items, idMap, stats)) continue;
        items.push({
          pairs: cloneRecord(rec, idMap),
          verts: estimateEntityVertices(raw),
          structured: raw.type === "INSERT" || raw.type === "DIMENSION" || raw.type === "HATCH",
        });
        stats.copied++;
        continue;
      }

      /* 跨边界但整块必须保留的类型：INSERT / DIMENSION / HATCH / ATTDEF。
       * 这几类实体一旦被摊平成图元，块内尺寸（DIMENSION）直接消失 —— `entityToPrimitives()`
       * 不产生尺寸几何，施工005 的 `A$C29980DFE` 整块跨视口，209 个 AXIS 尺寸在布局页
       * 全部丢失（实测 layout 只留 *D 块定义，没有任何实例）。做法是原样拷贝记录，
       * 再靠视口 INSERT 的 CADVIEWER_XCLIP（见下方 ④）把越界部分裁掉。 */
      const keepStructured = rec && (
        raw.type === "INSERT" || raw.type === "DIMENSION" ||
        raw.type === "HATCH" || raw.type === "ATTDEF"
      );
      if (keepStructured) {
        /* 超大块（> 顶点预算）拆成子块：一个 INSERT 变 N 个同变换的 INSERT。 */
        if (raw.type === "INSERT" && splitOversizedInsert(rec, raw, items, idMap, stats)) continue;
        items.push({
          pairs: cloneRecord(rec, idMap),
          verts: estimateEntityVertices(raw),
          structured: raw.type === "INSERT" || raw.type === "DIMENSION" || raw.type === "HATCH",
        });
        stats.copied++;
        stats.structuredKept = (stats.structuredKept || 0) + 1;
        continue;
      }

      // 跨边界（或找不到原始记录）：用摊平后的图元做真正裁剪
      stats.clipped++;
      const layer = typeof raw.layer === "string" ? raw.layer : "0";
      const colorIndex = Number.isFinite(raw.colorIndex) ? raw.colorIndex : null;
      for (const prim of geom.primitives) {
        if (prim.kind === "polyline") {
          const pts = prim.points || [];
          const runs = clipPolylineRuns(pts, prim.closed === true, rect);
          for (const run of runs) {
            items.push({ pairs: emitLwPolyline(run, layer, colorIndex), verts: Math.max(2, run.length) });
            stats.clippedPolylines++;
          }
        } else if (prim.kind === "text") {
          if (!inRect(prim.x, prim.y)) continue;
          const pairs = emitText(prim, layer, colorIndex);
          if (pairs) {
            items.push({ pairs, verts: Math.max(2000, String(prim.text ?? "").length * 600) });
            stats.injectedTexts++;
          }
        }
        // point：引擎默认不画（PDMODE=0），忽略
      }
    }

    // 块属性文字（ATTRIB 被 dxf-parser 丢弃，单独从原始记录里取；坐标本来就是 WCS）
    for (const rec of attribRecords) {
      const x = recordNumber(rec, 10);
      const y = recordNumber(rec, 20);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (!inRect(x, y)) continue;
      items.push({ pairs: cloneRecord(rec, idMap), verts: 64 });
      stats.attribs++;
    }

    // ATTRIB/SEQEND 的 330 是所属 INSERT 的句柄：INSERT 也被拷贝时同步换成新句柄
    if (idMap.size) {
      for (const item of items) {
        for (const p of item.pairs) {
          if (p[0] === "330" && idMap.has(String(p[1]).trim())) p[1] = idMap.get(String(p[1]).trim());
        }
      }
    }

    if (!items.length) continue;

    /* ④ 视口边框（VIEWPORT 实体引擎不认识，用一条灰色矩形代替；不参与打印）。
     * 边框与裁剪框共用同一组纸张角点，必须在写 INSERT XDATA 之前算好。 */
    const wx = vp.w / 2;
    const wy = vp.h / 2;
    const corner = (dx, dy) => [vp.cx + dx * cos - dy * sin, vp.cy + dx * sin + dy * cos];
    const corners = [
      corner(-wx, -wy),
      corner(wx, -wy),
      corner(wx, wy),
      corner(-wx, wy),
    ];

    /* 视口裁剪盒：引擎的 XDATA 约定是**块坐标**（与 SPATIAL_FILTER 的 M1/M2 结果同空间），
     * 所以把纸张视口矩形的 4 角用 INSERT 变换的逆变换换回模型/块坐标：
     *   model = V + R(-twist) · ((paper - C) / k)
     * 旧版直接写纸张坐标，v48 引擎按块坐标再乘一次 k，矩形被缩成 6×0.2，视口内容整片消失。
     * 写入 4 个角点（POLY）而不是对角两点：twist≠0 时矩形在块空间是旋转的。 */
    const blockCorner = (paperX, paperY) => {
      const dx = (paperX - vp.cx) / k;
      const dy = (paperY - vp.cy) / k;
      return [vp.vx + cos * dx + sin * dy, vp.vy - sin * dx + cos * dy];
    };

    /* ③ 视口内容按顶点预算分块：块内坐标就是模型坐标，INSERT 负责纸张变换。
     *    每块都能独立在一次 Merge 里画完（引擎单批上限 65 536 顶点，见上方注释）。 */
    const groups = [];
    let group = [];
    let groupVerts = 0;
    let groupBig = false;
    /* 顶点估算只用于分块，实际顶点数会偏差；再叠一层记录数上限（250 条/块）。
     * 单条就可能很大的 INSERT/DIMENSION/HATCH（估算 > 3 000 顶点）独占一块，
     * 小的块引用可以合在一起，避免动辄上千个块。 */
    const MAX_RECORDS_PER_GROUP = 250;
    const BIG_STRUCTURED_VERTICES = 3000;
    for (const item of items) {
      const v = item.verts || 32;
      const bigStructured = !!item.structured && v > BIG_STRUCTURED_VERTICES;
      if (group.length && (
        groupVerts + v > VIEWPORT_VERTEX_BUDGET ||
        group.length >= MAX_RECORDS_PER_GROUP ||
        bigStructured || groupBig
      )) {
        groups.push(group);
        group = [];
        groupVerts = 0;
        groupBig = false;
      }
      group.push(item);
      groupVerts += v;
      if (bigStructured) groupBig = true;
    }
    if (group.length) groups.push(group);

    const baseName = `*CV_VP_${(vp.handle || String(newBlocks.length)).replace(/[^\w$]/g, "_")}`;
    for (let gi = 0; gi < groups.length; gi++) {
      const blockName = gi === 0 ? baseName : `${baseName}_${gi}`;
      const blockPairs = [
        ["0", "BLOCK"],
        ["5", nextHandle()],
        ["100", "AcDbEntity"],
        ["8", "0"],
        ["100", "AcDbBlockBegin"],
        ["2", blockName],
        ["70", "0"],
        ["10", "0.0"],
        ["20", "0.0"],
        ["30", "0.0"],
        ["3", blockName],
        ["1", ""],
      ];
      /* 大图布局块可以有几万条组码：`push(...pairs)` 会直接爆栈（实测 v57 施工005），
       * 必须逐条 push。 */
      for (const item of groups[gi]) for (const p of item.pairs) blockPairs.push(p);
      blockPairs.push(
        ["0", "ENDBLK"],
        ["5", nextHandle()],
        ["100", "AcDbEntity"],
        ["8", "0"],
        ["100", "AcDbBlockEnd"]
      );
      newBlocks.push(blockPairs);

      newEntities.push([
        ["0", "INSERT"],
        ["5", nextHandle()],
        ["100", "AcDbEntity"],
        ["67", "1"],
        ["8", "0"],
        ["100", "AcDbBlockReference"],
        ["2", blockName],
        ["10", f(px)],
        ["20", f(py)],
        ["30", "0.0"],
        ["41", f(k)],
        ["42", f(k)],
        ["43", f(k)],
        ["50", f(vp.twist)],
        /* 视口裁剪盒：
         *  · 源图有 SPATIAL_FILTER（v48 新引擎路径）→ 写**块坐标**的 4 角多边形，引擎按
         *    当前 INSERT 变换回纸张坐标；
         *  · 源图没有 XCLIP → 保持旧的纸张坐标 RECT 两点（引擎的 legacy 分支按 WCS 处理），
         *    这样无 SPATIAL_FILTER 的图布局产物与改动前逐字节一致。 */
        ["1001", "CADVIEWER_XCLIP"],
        ...(blockSpaceViewportClip
          ? [
              ["1000", "POLY"],
              ...corners.flatMap(([x, y]) => {
                const [bx, by] = blockCorner(x, y);
                return [["1010", f(bx)], ["1020", f(by)], ["1030", "0.0"]];
              }),
            ]
          : [
              ["1000", "RECT"],
              ["1010", f(vp.cx - vp.w / 2)],
              ["1020", f(vp.cy - vp.h / 2)],
              ["1030", "0.0"],
              ["1010", f(vp.cx + vp.w / 2)],
              ["1020", f(vp.cy + vp.h / 2)],
              ["1030", "0.0"],
            ]),
      ]);
    }

    /* ⑤ 视口边框（灰色矩形，独立实体） */
    const border = [
      ["0", "LWPOLYLINE"],
      ["5", nextHandle()],
      ["100", "AcDbEntity"],
      ["67", "1"],
      ["8", "0"],
      ["62", String(FOCUS_MUTED_COLOR)],
      ["100", "AcDbPolyline"],
      ["90", "4"],
      ["70", "1"],
    ];
    for (const [x, y] of corners) border.push(["10", f(x)], ["20", f(y)]);
    newEntities.push(border);
  }

  /* ⑤ 重建：ENTITIES 只留该布局的图纸空间实体；BLOCKS 末尾插入视口块 */
  const out = [...orphan];
  /* 同上：大块内容不能 spread（栈溢出），统一逐条 append。 */
  const appendAll = (target, list) => {
    for (const x of list) target.push(x);
  };
  for (const rec of records) {
    if (rec.section === "ENTITIES") {
      if (rec.type === "ENDSEC") {
        for (const e of newEntities) appendAll(out, e);
        appendAll(out, recordAllPairs(rec));
      } else if (rec.type === "SECTION" || kept.has(rec)) {
        appendAll(out, recordAllPairs(rec));
      }
      continue;
    }
    if (rec.section === "BLOCKS" && rec.type === "ENDSEC") {
      for (const b of newBlocks) appendAll(out, b);
      appendAll(out, recordAllPairs(rec));
      continue;
    }
    appendAll(out, recordAllPairs(rec));
  }

  let text = pairsToText(out, eol);
  /* 块内 BYLAYER 颜色烘焙（dxf-viewer 的两条着色路径都处理不好，见 bakeBlockColours 说明） */
  try {
    const baked = bakeBlockColours(text);
    text = baked.text;
  } catch {
    /* 烘焙失败就用原文本（不影响几何） */
  }

  return { text, stats };
}

/**
 * 3×4 仿射矩阵（DXF 里 12 个 40 组码，列主序/行向量约定）：
 *   x' = m0·x + m1·y + m3
 *   y' = m4·x + m5·y + m7
 * 等价于 4×4 行向量布局 `[m0 m4 m8 0; m1 m5 m9 0; m2 m6 m10 0; m3 m7 m11 1]`。
 * 注意：**不能**按“12 个数 = 3×4 行主序”去读，否则平移会落到 m[2]/m[6] 上。
 * @param {number[]} m
 * @param {number} x
 * @param {number} y
 * @returns {?[number, number]}
 */
function applyAffine34(m, x, y) {
  if (!Array.isArray(m) || m.length < 12) return [x, y];
  const px = m[0] * x + m[1] * y + m[3];
  const py = m[4] * x + m[5] * y + m[7];
  return Number.isFinite(px) && Number.isFinite(py) ? [px, py] : null;
}

/** @param {number[]} m @returns {?number[]} 同布局的逆矩阵（只支持 2D 仿射） */
function invertAffine34(m) {
  if (!Array.isArray(m) || m.length < 12) return null;
  const a = m[0], b = m[1], tx = m[3], c = m[4], d = m[5], ty = m[7];
  const det = a * d - b * c;
  if (!(Math.abs(det) > 1e-12)) return null;
  const ia = d / det, ib = -b / det, ic = -c / det, id = a / det;
  return [ia, ib, 0, -(ia * tx + ib * ty), ic, id, 0, -(ic * tx + id * ty), 0, 0, 1, 0];
}

/** 去掉首尾重复点 / 连续重复点；保留顶点顺序。 */
function cleanBoundaryPolygon(points) {
  const out = [];
  for (const p of points) {
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev[0] - p[0]) < 1e-9 && Math.abs(prev[1] - p[1]) < 1e-9) continue;
    out.push([p[0], p[1]]);
  }
  while (out.length > 1) {
    const a = out[0], b = out[out.length - 1];
    if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) out.pop();
    else break;
  }
  return out;
}

/**
 * 把 SPATIAL_FILTER 的边界点换成**块实例父坐标系**里的多边形。
 *
 * 权威语义（DXF SPATIAL_FILTER / ObjectARX AcDbSpatialFilter / ezdxf）：
 *   p_block = M1 · M2⁻¹ · p_boundary
 *   p_wcs   = T_insert · p_block
 * 其中：
 *   · 10/20 是“裁剪坐标系”里的边界点；70=2 时是矩形**对角点**，须展开成 4 角；
 *   · M1 = 第一组 12×40，`OriginalInverseBlockTransform`，是块引用变换的**快照**，
 *     不保证等于当前 T_insert⁻¹（16F99/16F9D 就不同：插入点移动过）；
 *   · M2 = 第二组 12×40，WCS→裁剪坐标系的变换；
 *   · 71=1 才裁剪，71=0 整块显示；72 是前裁剪平面标志，不是开关。
 *
 * 这里只算到**块定义坐标**（p_block = M1·M2⁻¹·boundary）；顶层 INSERT 的 p_wcs 由渲染器
 * 在摊平时乘当前 T_insert 得到。不能把 M1 当成 T_insert⁻¹：16F99/16F9D 的插入点移动过，
 * M1 只是创建过滤器时的快照，直接用会算到图外。
 *
 * @param {{pts:number[][], pointCount:?number, matrix:number[]}} f
 * @returns {?number[][]} 多边形顶点（不重复首点）
 */
function spatialFilterBlockPolygon(f) {
  const pts = f.pts;
  if (!pts || pts.length < 2) return null;
  const pointCount = Number.isFinite(f.pointCount) ? f.pointCount : pts.length;

  let boundary;
  if (pointCount === 2 || pts.length === 2) {
    /* 70=2：两个点是矩形的对角点（不保证是左下/右上）。 */
    const [x0, y0] = pts[0];
    const [x1, y1] = pts[1];
    boundary = [
      [x0, y0], [x1, y0], [x1, y1], [x0, y1],
    ];
  } else {
    boundary = cleanBoundaryPolygon(pts);
  }
  boundary = cleanBoundaryPolygon(boundary);
  if (boundary.length < 3) return null;

  const m1 = f.matrix.length >= 12 ? f.matrix.slice(0, 12) : null;
  const m2 = f.matrix.length >= 24 ? f.matrix.slice(12, 24) : null;
  const invM2 = m2 ? invertAffine34(m2) : null;
  if (m2 && !invM2) return null;

  const out = [];
  for (const [bx, by] of boundary) {
    /* 行向量约定下 M1 · M2⁻¹ · p 的求值顺序：先 M2⁻¹，再 M1。 */
    let q = m2 ? applyAffine34(invM2, bx, by) : [bx, by];
    if (!q) return null;
    q = applyAffine34(m1, q[0], q[1]);
    if (!q) return null;
    out.push(q);
  }
  return cleanBoundaryPolygon(out);
}

/**
 * XCLIP / SPATIAL_FILTER 提取（v48：按权威矩阵语义重写）。
 *
 * 背景：施工005 的模型空间里有 1 个块实例被 XCLIP 裁过（INSERT 54169 / 块 A$C29980DFE）。
 * DXF 把裁剪对象写在 OBJECTS 段：
 *   INSERT 102 {ACAD_XDICTIONARY / 360 <dict>
 *   DICTIONARY 5=<dict> 330=<INSERT handle> 3=ACAD_FILTER 360=<filter>
 *   SPATIAL_FILTER 5=<filter> 70=<点数> 10/20=<点>… 71=<enabled>
 *                  40×12 = OriginalInverseBlockTransform，40×12 = WCS→裁剪坐标系
 * 引擎的解析器只读 ENTITIES，拿不到这条引用链，于是被裁的块整块画出来。
 *
 * 这里把**块定义坐标**里的完整多边形作为 XDATA 注回对应 INSERT：
 *   1001 CADVIEWER_XCLIP / 1000 POLY / 1010,1020,1030 ×N
 * 旧版只写两个角点（RECT），引擎再取 bbox；这会把 M2 旋转后的矩形、以及凹多边形
 * 都算错。现在写多边形，引擎按真裁剪处理。渲染器拿到的是 p_block，摊平时再乘当前
 * T_insert 得到 WCS（不能把 M1 快照当成 T_insert⁻¹，16F99/16F9D 两者不同）。
 *
 * @param {string} s DXF 文本
 * @param {?object} _cbox 兼容旧调用（v44 曾用它做“算错就别裁”的兜底，现已删）
 * @returns {Map<string, {points:number[][], minX:number,minY:number,maxX:number,maxY:number}>}
 *   INSERT handle → 裁剪多边形（块定义坐标）
 */
export function extractSpatialFilters(s, _cbox = null) {
  const out = new Map();
  if (!s.includes("SPATIAL_FILTER")) return out;
  const lines = s.split(/\r?\n/);
  let section = null;
  let pendingSection = false;
  let cur = null;
  const dictFilter = new Map(); // dict handle -> filter handle
  const dictOwner = new Map(); // dict handle -> owner (INSERT) handle
  const filters = new Map(); // filter handle -> {pts, pointCount, matrix, enabled}
  const saveFilter = (f) => {
    if (f.handle) {
      filters.set(f.handle, {
        pts: f.pts,
        pointCount: Number.isFinite(f.pointCount) ? f.pointCount : null,
        matrix: f.matrix,
        enabled: f.enabled ?? 0,
      });
    }
  };
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const c = parseInt(lines[i].trim(), 10);
    const v = lines[i + 1].trim();
    if (Number.isNaN(c)) continue;
    if (c === 2 && pendingSection) {
      section = v.toUpperCase();
      pendingSection = false;
      continue;
    }
    if (c === 0) {
      if (cur) {
        if (cur.type === "DICTIONARY" && cur.handle) {
          dictOwner.set(cur.handle, cur.owner || null);
          if (cur.filterHandle) dictFilter.set(cur.handle, cur.filterHandle);
        } else if (cur.type === "SPATIAL_FILTER") {
          saveFilter(cur);
        }
      }
      cur = null;
      const val = v.toUpperCase();
      if (val === "SECTION") { pendingSection = true; continue; }
      if (val === "ENDSEC") { section = null; continue; }
      if (section === "OBJECTS" && (val === "DICTIONARY" || val === "SPATIAL_FILTER")) {
        cur = {
          type: val, handle: null, owner: null, filterHandle: null,
          pts: [], pointCount: null, matrix: [], enabled: 0,
        };
      }
      continue;
    }
    if (!cur) continue;
    if (c === 5) cur.handle = v;
    else if (c === 330) cur.owner = v;
    else if (c === 360 && cur.type === "DICTIONARY") cur.filterHandle = v;
    /* 71 = 裁剪是否启用；72 是前裁剪平面，不是开关。
     * 施工005 的 3 个过滤器 71 全为 1 —— XCLIP 是开着的。 */
    else if (c === 71 && cur.type === "SPATIAL_FILTER") cur.enabled = parseInt(v, 10) || 0;
    else if (c === 70 && cur.type === "SPATIAL_FILTER") cur.pointCount = parseInt(v, 10);
    else if (c === 10 && cur.type === "SPATIAL_FILTER") cur.px = parseFloat(v);
    else if (c === 20 && cur.type === "SPATIAL_FILTER" && cur.px !== undefined) {
      cur.pts.push([cur.px, parseFloat(v)]);
      cur.px = undefined;
    } else if (c === 40 && cur.type === "SPATIAL_FILTER") cur.matrix.push(parseFloat(v));
  }
  if (cur) {
    if (cur.type === "DICTIONARY" && cur.handle) {
      dictOwner.set(cur.handle, cur.owner || null);
      if (cur.filterHandle) dictFilter.set(cur.handle, cur.filterHandle);
    } else if (cur.type === "SPATIAL_FILTER") {
      saveFilter(cur);
    }
  }

  /* 过滤器引用可能多一层（INSERT → 扩展字典 → ACAD_FILTER 字典 → SPATIAL_FILTER），
   * 顺着 360 链解析到真正的 SPATIAL_FILTER。 */
  const resolveFilter = (handle, depth = 0) => {
    if (depth > 4) return null;
    const f = filters.get(handle);
    if (f) return f;
    const next = dictFilter.get(handle);
    return next ? resolveFilter(next, depth + 1) : null;
  };

  for (const [dict, target] of dictFilter) {
    const insert = dictOwner.get(dict);
    /* 过滤对象自己也挂着一个 ACAD_FILTER 扩展字典（owner 是字典而非 INSERT）；
     * 只保留 owner 不是字典的那一条，否则会把过滤器记到错误的 handle 上。 */
    if (!insert || dictFilter.has(insert) || filters.has(insert)) continue;
    const f = resolveFilter(target);
    if (!f) continue;
    if (f.enabled !== 1) continue; // 71=0：裁剪未启用（XCLIP off），整块显示
    const points = spatialFilterBlockPolygon(f);
    if (!points) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of points) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (!(maxX > minX) || !(maxY > minY)) continue;
    out.set(insert.toUpperCase(), { points, minX, minY, maxX, maxY });
  }
  return out;
}

/** 6 元仿射矩阵 {a,b,c,d,e,f} 应用（block-text.js 的 insertMatrix 格式）。 */
function applyMatrix6(m, x, y) {
  if (!m) return [x, y];
  const px = m.a * x + m.c * y + m.e;
  const py = m.b * x + m.d * y + m.f;
  return Number.isFinite(px) && Number.isFinite(py) ? [px, py] : null;
}

/** 点是否在多边形内（边界算内）；用于块内展平文字的 XCLIP 过滤。 */
function pointInPolygon(x, y, polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return true;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j];
    const b = polygon[i];
    const cross = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
    if (Math.abs(cross) <= 1e-9 &&
        x >= Math.min(a[0], b[0]) - 1e-9 && x <= Math.max(a[0], b[0]) + 1e-9 &&
        y >= Math.min(a[1], b[1]) - 1e-9 && y <= Math.max(a[1], b[1]) + 1e-9) {
      return true;
    }
    if ((b[1] > y) !== (a[1] > y)) {
      const t = (y - b[1]) / (a[1] - b[1]);
      if (x < b[0] + t * (a[0] - b[0])) inside = !inside;
    }
  }
  return inside;
}

/**
 * 过滤 flattenTexts() 展平出来的块内文字/笔画。
 *
 * 背景：flattenTexts 把块内 TEXT/MTEXT 转成顶层 TEXT / 笔画 LWPOLYLINE 注入 ENTITIES。
 * 注入后这些实体已经不在块里，引擎的 `CADVIEWER_XCLIP` 只作用于 INSERT 摊平过程，
 * 裁不到它们 → 被裁块原本的文字会留在原地，变成“零零散散的点”。
 *
 * 关联方式：flattenTexts 给每条 item 带 `owners`（完整 INSERT 链，每层带
 * block→WCS 矩阵）、`owner`/`ownerMatrix`（最外层，兼容旧字段）和 `attrib`。这里：
 *   · 链上没有 SPATIAL_FILTER 的层直接跳过；其它 INSERT 的文字注入不受影响；
 *   · 有过滤器的层，把该层的 p_block 多边形乘该层矩阵得 WCS 多边形；
 *   · 文字插入点或对齐点必须落在**每一层**有过滤器的多边形内（交集）。
 *
 * 注意 ATTRIB：输出 DXF 里的原始 ATTRIB 已由 `collectAttribLines()` 删除，这里看到的
 * `attrib=true` 项是 flattenTexts 为“属性块里的字画不出来”而注入的**副本**。它属于
 * 被裁 INSERT 的块内容，必须和块内文字一起过滤；原始 ATTRIB 实体本身不参与 XCLIP。
 *
 * @param {object[]} items flattenTexts items
 * @param {Map<string,{points:number[][]}>} filters extractSpatialFilters 结果
 * @returns {{items:object[], removed:number, kept:number}}
 */
export function clipFlattenedTexts(items, filters) {
  if (!items?.length || !filters?.size) {
    return { items: items || [], removed: 0, kept: items?.length || 0 };
  }
  const byHandle = new Map();
  for (const [handle, filter] of filters) {
    byHandle.set(String(handle).toUpperCase(), filter);
  }
  const out = [];
  let removed = 0;
  for (const item of items) {
    const chain = Array.isArray(item.owners) && item.owners.length
      ? item.owners
      : (item.owner != null ? [{ handle: item.owner, matrix: item.ownerMatrix }] : []);
    let keep = true;
    for (const entry of chain) {
      const handle = entry?.handle != null ? String(entry.handle).toUpperCase() : null;
      const filter = handle ? byHandle.get(handle) : null;
      if (!filter || !filter.points?.length || !entry.matrix) continue;
      const polygon = filter.points
        .map(([x, y]) => applyMatrix6(entry.matrix, x, y))
        .filter(Boolean);
      const inside = (x, y) =>
        Number.isFinite(x) && Number.isFinite(y) && pointInPolygon(x, y, polygon);
      if (!inside(item.x, item.y) && !inside(item.ax, item.ay)) {
        keep = false;
        break;
      }
    }
    if (keep) out.push(item);
    else removed++;
  }
  return { items: out, removed, kept: out.length };
}

/**
 * 把裁剪多边形以 XDATA 写进对应 INSERT（放在实体末尾，解析器的 XDATA 分支会收进 entity.xdata）。
 *  `1000 POLY` + N 个 `1010/1020/1030` 点；点序就是边界顺序（v48）。
 *  旧版只写 `RECT` 的两个对角点，旋转/凹多边形都会失真，已淘汰；引擎仍兼容 RECT。 */
export function injectSpatialFilterXdata(s, filters) {
  if (!filters || !filters.size) return { text: s, injected: 0 };
  const eol = s.includes("\r\n") ? "\r\n" : "\n";
  const lines = s.split(/\r?\n/);
  const out = [];
  let section = null;
  let pendingSection = false;
  let cur = null; // {start, type, handle}
  let count = 0;
  const flush = () => {
    if (!cur) return;
    const filter = cur.type === "INSERT" && cur.handle
      ? filters.get(cur.handle.toUpperCase())
      : null;
    const points = filter?.points;
    if (points && points.length >= 3) {
      const p = (x, y) => ["1010", String(x), "1020", String(y), "1030", "0.0"];
      const xdata = ["1001", "CADVIEWER_XCLIP", "1000", "POLY"];
      for (const [x, y] of points) xdata.push(...p(x, y));
      out.push(...xdata);
      count++;
    }
    cur = null;
  };
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i];
    const value = lines[i + 1];
    const c = parseInt(code.trim(), 10);
    if (c === 2 && pendingSection) { section = value.trim().toUpperCase(); pendingSection = false; }
    if (c === 0) {
      flush();
      const val = value.trim().toUpperCase();
      if (val === "SECTION") pendingSection = true;
      else if (val === "ENDSEC") section = null;
      else if (section === "ENTITIES" || section === "BLOCKS") {
        cur = { type: val, handle: null };
      }
    } else if (cur && c === 5) {
      cur.handle = value.trim();
    }
    out.push(code, value);
  }
  if (lines.length % 2 === 1) out.push(lines[lines.length - 1]);
  flush();
  return { text: out.join(eol), injected: count };
}

/**
 * 文字笔画模式：`always`（默认，全部文字单线骨架）/ `auto`（只转真正的 SHX 样式）/
 * `never`（不额外映射 TTF 样式）。
 *
 * v47 用户硬要求：默认回到 `always`。v36 曾默认 auto，TTF 样式走 Noto 填充字形，
 * 同图出现“细单线 + 粗填充”混排，用户认为这是回退。保留环境变量与 options 覆盖，
 * 方便排查/回归旧行为。单测锁默认值，防止再次被静默改掉。
 *
 * @param {{textStroke?:string}} [options]
 * @param {Record<string,string|undefined>} [env]
 */
export function resolveTextStrokeMode(options = {}, env = process.env) {
  return String(options?.textStroke ?? env?.CADVIEWER_TEXT_STROKE ?? "always").toLowerCase();
}

/**
 * v51：自定义对象洞口几何注入（把 `udo-cli` 解出的 TCH_OPENING 变成 LWPOLYLINE）。
 *
 * 只有在 **dump 可用**（开图时已由 index.js 落盘到 `<cacheDir>/udo-dump.json`，
 * 或这里就地解码得到）时才动手；否则原样返回同一个字符串（逐字节不变）。
 *
 * @param {string} text 当前 DXF 文本（已解 `\U+XXXX`、已删隐藏图层）
 * @param {object} options buildWebDxf 的 options（读 `udoDumpPath` / `udoSourcePath`）
 * @param {string} outPath 产物路径（同名目录即派生缓存目录）
 * @param {Set<string>} hiddenLayers 被过滤掉的图层名（关闭/冻结；也可传 filterHiddenLayers 的 Map）
 * @returns {Promise<{text:string,detected:number,decoded:number,injected:number,skipped:number,missingLayer:number,hidden:number}>}
 */
async function applyUdoGeometry(text, options, outPath, hiddenLayers) {
  const zero = {
    text,
    detected: 0,
    decoded: 0,
    injected: 0,
    primitives: 0,
    skipped: 0,
    missingLayer: 0,
    hidden: 0,
    byKind: { opening: 0, wall: 0, text: 0, dimension: 0 },
    primitivesByKind: { opening: 0, wall: 0, text: 0, dimension: 0 },
    textHeight: null,
  };
  if (options.udo === false || process.env.CADVIEWER_NO_UDO === "1") return zero;

  let dump;
  try {
    dump = await loadUdoDump({
      dumpPath: options.udoDumpPath,
      sourcePath: options.udoSourcePath,
      cacheDir: outPath ? path.dirname(outPath) : null,
    });
  } catch {
    return zero; // 模块自己保证不抛，这里再兜一层
  }
  if (!dump?.ok) return zero;

  const res = injectUdoGeometry(text, dump.data, {
    startHandle: maxHandle(text) + 1,
    layers: layerNames(text),
    hiddenLayers,
    maxEntities: options.maxTchEntities,
    textHeight: options.udoTextHeight,
    /* v65：注入范围自检用服务端算出的 contentBox（buildWebDxf 的 options 已带）。 */
    contentBox: options.contentBox,
  });
  return {
    text: res.text,
    detected: res.detected,
    decoded: res.decoded,
    injected: res.injected,
    primitives: res.primitives,
    skipped: res.skipped,
    missingLayer: res.missingLayer,
    hidden: res.hidden,
    byKind: res.byKind,
    primitivesByKind: res.primitivesByKind,
    textHeight: res.textHeight,
  };
}

/**
 * 产出可直接给 dxf-viewer 吃的 DXF。
 *
 * v15 起是 async：SHX 笔画文字的字体定位/样式表读取需要动态 import `fonts.js`。
 * 调用方（dxf-web-worker.js）必须 `await`。
 *
 * @param {string} srcPath
 * @param {string} outPath
 * @param {{kind:string,name:string,spec:string,names?:string[]}|null} [focus]
 * @param {{shxText?:boolean, fontRoot?:string, space?:{kind:string,spec:string,name:string}|null, contentBox?:object|null,
 *          udoDumpPath?:string, udoSourcePath?:string}} [options]
 *   `shxText === false` 关闭 SHX 笔画转换（默认开）；
 *   `space` = 模型/布局空间（`parseSpace` 的结果），缺省保持旧的"模型+图纸同场"行为；
 *   `contentBox` = 调用方已知的图纸主体范围（`rec.stats.contentBox`）。DXF 直开时源文件
 *   在 `data/uploads/`，同目录没有 meta.json，`contentBoxOf(srcPath)` 拿不到值 →
 *   `filterFlatTexts` 会整段跳过（这曾让机柜 DXF 的放大字高漏过兜底）。传进来优先用它。
 *   `udoDumpPath` = `udo-cli dump` 的 JSON（v51），`udoSourcePath` = 源 DWG（缓存缺失时就地解码）；
 *   两者都缺/都失败 → 不做任何自定义对象处理（产出逐字节不变）。
 *   `strayFilter` = 图外散点过滤（v61，默认开）；传 `false` 或环境变量
 *   `CADVIEWER_STRAY_FILTER=0` 关闭，关闭时产物与 v59 逐字节一致。
 *   顶层环境变量 `CADVIEWER_NO_SHX_TEXT=1` 是无条件总开关。
 * @returns {Promise<object>}
 */
export async function buildWebDxf(srcPath, outPath, focus = null, options = {}) {
  const buf = fs.readFileSync(srcPath);

  /* 编码必须自适应（2026-10-18 实测，勿删）：
   *   cadcraft 的产出不统一 —— 小图是**纯 ASCII + `\U+XXXX` 转义**（9.4MB 那份 0 个高位字节、
   *   2024 条文字带转义），而 91MB 那份是**真的 UTF-8 中文**（93 万个高位字节、0 条转义）。
   *   原来一律按 latin1 读再按 UTF-8 写，会把后者二次编码成乱码。
   *   所以：先严格试 UTF-8；失败再按 `$DWGCODEPAGE` 选码页（ANSI_936→GBK、
   *   ANSI_950→Big5、ANSI_932→Shift-JIS、ANSI_949→EUC-KR），仍失败才松散解。
   */
  let { s, encoding } = decodeDxfBuffer(buf);

  const before = (s.match(/\\U\+[0-9A-Fa-f]{4}/g) || []).length;
  s = decodeUnicodeEscapes(s);

  /* `%%C`（直径控制码）统一字面：dxf-viewer 自带的 ParseSpecialChars 会把残余的 `%%C`
   * 映射成 U+2205（∅），而 U+2205 在它加载的 simfang.ttf 里**没有字形** → 实际画成 "?"；
   * 我们注入的表格/块内文字却用 φ，两处字面不一致（实测：原图 "?" vs 注入 φ）。
   * 交给 dxf-viewer 之前把整份文件里的 `%%C` 预替换成同一个字符 DIAMETER_CHAR(φ)，
   * 它就不会再走自己的映射。只碰 `%%C`，`%%D`/`%%P`/`%%%`/`\U+` 转义一概不动。 */
  const diameterFixed = (s.match(/%%C/gi) || []).length;
  if (diameterFixed) s = s.replace(/%%C/gi, DIAMETER_CHAR);

  /* ⓪ 隐藏图层过滤（v32）：关闭（LAYER 62<0）与冻结（70 bit1）图层上的实体整段删除。
   *    必须在 focus/烘焙/文字展开之前跑 —— 否则块内文字会被展开成世界坐标 TEXT 再"复活"。
   *    meta.json 的 stats.layers 只在 DXF 完全没写 62 时兜底（见 hiddenLayerTable 说明）。 */
  const hiddenResult = filterHiddenLayers(s, null, metaLayersOf(srcPath));
  s = hiddenResult.text;
  const hiddenLayers = hiddenResult.hidden;

  /* ⓪a 自定义对象洞口几何（v51）—— 注入点刻意放在这里，理由三条：
   *   ① **必须在 ⓪ 隐藏图层过滤之后**：否则关闭/冻结层上的洞口会被"复活"
   *      （本函数拿 `hiddenLayers` 自己跳过这些层，与 ⓪ 口径一致）。
   *   ② **必须在 ① ATTRIB 删除 / ② 块文字展开 / ③b 块内颜色烘焙 / ③bb 代理图形之前**：
   *      · `flattenTexts()` 读的是**原始文件** srcPath（不是当前字符串），行区间会错位；
   *      · `maxHandle()` 从这里往后被所有注入阶段（表格文字、块内文字、代理笔画）
   *        当作起点，先落我们的句柄才不会撞号；
   *      · `applyFocus()` 在后面跑，注入实体因此能像原生实体一样被正确涂灰/亮显；
   *      · `convertProxyGraphicsEntities()` 按行区间就地替换实体，先追加不会打乱区间。
   *   ③ **必须在 ⓪b 模型/布局空间处理之前**：布局路径把模型实体拷进 `*CV_VP_*` 块，
   *      在这之后注入的洞口不会进视口（布局页就看不到门洞）。
   * 没有 udo-cli 二进制 / 没检测到自定义对象 / dump 坏 → 原样返回，产出逐字节不变。 */
  const udoResult = await applyUdoGeometry(s, options, outPath, hiddenResult.hidden);
  s = udoResult.text;

  /* ⓪b 模型 / 布局空间（v34）。
   *  · space=layout:<名> → 只保留该布局的图纸空间实体 + 把视口内的模型内容变换后注回；
   *    布局不存在时**回落模型空间**（未知布局名不得让开图失败）。
   *  · space=model → 删掉全部 67=1 实体，避免纸张图框叠在模型坐标上。
   *  · 不传 space（旧链接 / 比对画布）保持原行为，模型+图纸同场。
   *
   * v57：布局**不再在这里提前 return**。旧实现在这里就 buildLayoutSpace + 写盘，
   *   跳过了下面模型侧的全部预处理（① ATTRIB 删除 / ② flattenTexts 块内文字 /
   *   ② SHX 单线笔画 / 表格注入 / ③bb 代理图形带笔画），于是布局页里
   *   · 块内文字、属性文字（ATTRIB 引擎不画）、天正 TEXT 注入全部消失；
   *   · 保留的原始 TEXT 走 TTF，和模型页的"全单线"观感不一致。
   *   施工005 实测：模型产物 119 202 条 LWPOLYLINE（文字笔画占大头），布局 4 个大视口
   *   块里只有 2 037 条 TEXT / 4 302 条 ATTRIB / 0 条笔画 —— 就是"布局页丢字"的来源。
   *   现在只在这里认布局（并要求它真实存在），buildLayoutSpace 挪到全部注入之后（见 ⓪c），
   *   这样视口块拿到的模型实体与模型页完全同一套。 */
  const space = options.space || null;
  const layoutSpace =
    space && space.kind === "layout" &&
    parseLayouts(s).some((l) => l.name === space.name && !isModelLayout(l))
      ? space
      : null;
  let spaceInfo = null;
  if (space && space.kind === "layout" && !layoutSpace) {
    // 布局查不到：按模型空间处理（并在 stats 里留痕，便于排查）
    const fallback = filterModelSpace(s);
    s = fallback.text;
    spaceInfo = { kind: "model", removed: fallback.removed, fallback: true };
  } else if (layoutSpace) {
    /* 布局的模型侧内容要和模型页一样先做预处理：这里什么都不做，
     * 等 ⓪c 统一 buildLayoutSpace。 */
  } else if (space && space.kind === "model") {
    const modelResult = filterModelSpace(s);
    s = modelResult.text;
    spaceInfo = { kind: "model", removed: modelResult.removed, fallback: false };
  }
  const modelSpaceOnly = !!spaceInfo && spaceInfo.kind === "model";
  /* v57：布局页也要丢掉"图纸空间被 flattenTexts 摊平到世界坐标"的文字 —— 那批文字
   * 在布局里既不属于视口内容（坐标是纸张坐标，永远落在视口矩形外），又和纸张空间
   * 自己的记录重复。模型页/布局页共用同一个口径。 */
  const dropPaperTexts = modelSpaceOnly || !!layoutSpace;

  /* ① 删掉全部原 ATTRIB（它们由 block-text.js 展开成世界坐标 TEXT 后重新注入）。
   *    不删的话引擎会按块内字高在原位置画一堆看不见的小点，纯垃圾。 */
  const attrLines = s.split(/\r?\n/);
  const { del: delAttr, count: attribRemoved } = collectAttribLines(attrLines);
  const { del: delBlkText, count: blockTextRemoved, keptDimText } = collectBlockTextLines(attrLines);
  for (const i of delBlkText) delAttr.add(i);
  if (delAttr.size) s = attrLines.filter((_, i) => !delAttr.has(i)).join("\r\n");

  /* ③ 聚焦涂灰（必须在注入之前：注入实体自己按 focus 决定颜色） */
  const focusResult = applyFocus(s, focus);
  s = focusResult.text;

  /* ③b 块内颜色烘焙（v31）：把 BLOCKS 段里的 BYLAYER 实体固化成显式 ACI。
   * 原因见 bakeBlockColours 上方说明 —— dxf-viewer 的两条着色路径都不能正确处理
   * "块内 0 层 + BYLAYER"（实例化 → 白色）和"块内任意层 + BYLAYER"（摊平 → INSERT 层色）。
   * 必须在 applyFocus 之后跑：已经涂灰的实体有显式 62，不会被二次覆盖。 */
  const bakeResult = bakeBlockColours(s);
  s = bakeResult.text;

  /* ③bb 自定义实体代理图形在 SHX 上下文建好之后处理（见下面 `convertProxyGraphicsEntities`
   * 调用）：代理文字要直接出单线笔画，必须先拿到 `activeShxCtx`。 */

  /* ③c 不支持实体的合成（v32）：LEADER / MULTILEADER / MLINE → 引擎认识的 LWPOLYLINE/SOLID/TEXT。
   * 就地替换原实体行区间：块坐标系、已涂灰的 62、图层/线型全部自然保留。
   * 放在 bake 之后、SHX 文字转换之前，句柄从当前最大值往后排。
   * 每类先用一次文本探测跳过（大图 90MB+：三趟 pairLines 不能白跑）。 */
  /* v50：优先用调用方传进来的 contentBox。DXF 直开时 srcPath 是 `data/uploads/*.dxf`，
   * 同目录没有 meta.json（meta 在 `server/cache/<id>/`），contentBoxOf 会返回 null，
   * 于是 filterFlatTexts 直接原样返回、整套"变换结果合理性"兜底失效。 */
  const cbox = options.contentBox ?? contentBoxOf(srcPath);
  const synthLayers = layerNames(s);
  const hasType = (t) => new RegExp("\\n" + t + "\\r?\\n").test(s);
  const needsSynth = hasType("LEADER") || hasType("MLINE") || hasType("MULTILEADER");
  /* 只有真需要合成时才读 DIMSTYLE / LAYER 颜色表（大图各多一趟 pairLines） */
  const synthOpts = needsSynth
    ? { cbox, layers: synthLayers, layerAci: layerAciTable(s), dimStyles: dimStyleTable(s) }
    : null;
  let synthHandle = maxHandle(s) + 1;
  let leaderResult = { text: s, used: 0, leadersConverted: 0, leaderFallbacks: 0, leaderArrows: 0, leaderAnnotations: 0 };
  let mlineResult = { text: s, used: 0, mlinesConverted: 0, mlineElements: 0, mlineFallbacks: 0 };
  let mleaderResult = { text: s, used: 0, multileadersConverted: 0, multileaderTexts: 0, leaderFallbacks: 0 };
  if (hasType("LEADER")) {
    leaderResult = convertLeaders(s, synthHandle, synthOpts);
    s = leaderResult.text;
    synthHandle += leaderResult.used;
  }
  if (hasType("MLINE")) {
    mlineResult = convertMLines(s, synthHandle, synthOpts);
    s = mlineResult.text;
    synthHandle += mlineResult.used;
  }
  if (hasType("MULTILEADER")) {
    mleaderResult = convertMultiLeaders(s, synthHandle, synthOpts);
    s = mleaderResult.text;
    synthHandle += mleaderResult.used;
  }

  /* ② 展开块内文字（这是"属性块里的字画不出来"的正解） */
  /* 样式名解码在所有"单线体"模式做（always / never 之外的组合）；always 下
   * 宋体/黑体等 TTF 样式也会映射到默认单线体，必须解码样式名才能找到它们。
   *
   * v47：默认**改回 always**（用户明确要求"全部文字单线骨架"）。
   *   v36 曾把默认从 always 改成 auto（TTF 样式交回 Noto 填充字形），但用户认为
   *   同一张图里"细单线 + 粗填充"混排就是回退，要求所有文字统一成 SHX 单线笔画。
   *   环境变量 CADVIEWER_TEXT_STROKE=auto 仍可覆盖回旧行为（只看真正的 SHX 样式）；
   *   =never 则完全不按单线体映射（仅保留 STYLE 表里本来就是 SHX 的文字）。
   *   `always` 只在能解析到默认单线字体（simplex/txt + hztxt/gbcbig）时生效；
   *   机器上没有这些字体时 createShxContext 会降级，不会把文字画丢。 */
  const textStrokeMode = resolveTextStrokeMode(options);
  const decodeStyle = textStrokeMode !== "auto" && textStrokeMode !== "never";
  const flat = flattenTexts(srcPath, { decodeStyle });
  const flatFilterStats = {};
  let blockTexts = filterFlatTexts(flat.items, cbox, flatFilterStats);
  /* v49：被 XCLIP 的块，其块内文字会被 flattenTexts 注到顶层 ENTITIES。
   * 注入后不在块里，引擎裁不到，必须在这里按同一个 SPATIAL_FILTER 多边形再过滤一次。
   * 只影响 owner（顶层 INSERT 句柄）有 71=1 过滤器的文字项；ATTRIB 保留。 */
  const clipFiltersForTexts = extractSpatialFilters(s);
  const clipTextStats = { removed: 0, kept: blockTexts.length };
  if (clipFiltersForTexts.size) {
    const filtered = clipFlattenedTexts(blockTexts, clipFiltersForTexts);
    blockTexts = filtered.items;
    clipTextStats.removed = filtered.removed;
    clipTextStats.kept = filtered.kept;
  }
  /* space=model：flattenTexts 读的是**原始文件**，图纸空间顶层的 TEXT/MTEXT（67=1）
   * 会在这里被摊平成世界坐标注入，必须再按空间标记滤一遍（见 block-text.js 的 item.paper）。
   * 本图实测 216 条（212 TEXT + 4 MTEXT），不滤就会在模型视图边缘出现漂浮文字。
   * v57：布局页同理（纸张文字由布局自己的 kept 记录负责，不能当模型实体再注一遍）。 */
  let paperTextsDropped = 0;
  if (dropPaperTexts) {
    const beforeLen = blockTexts.length;
    blockTexts = blockTexts.filter((t) => !t.paper);
    paperTextsDropped = beforeLen - blockTexts.length;
  }

  const tables = scanTables(srcPath);
  const layers = layerNames(s);

  /* SHX 笔画文字：默认开启，可被 options.shxText=false 或环境变量关掉。
   * fonts.js 由另一条 lane 提供，这里动态 import + try/catch —— 模块还没落地时
   * 只是"没有 SHX 样式"，绝不影响开图（hasAnyShx=false → 完全走旧路径）。 */
  const shxEnabled =
    options.shxText !== false && process.env.CADVIEWER_NO_SHX_TEXT !== "1";
  const shxStats = {
    texts: 0,
    polylines: 0,
    missing: 0,
    mtext: 0,
    dimTexts: 0,
    dimMtext: 0,
    dimPolylines: 0,
  };
  let activeShxCtx = null;
  /* v57：布局页不做 SHX 单线化。布局的视口块是"模型实体的副本"，
   * 一旦逐字出笔画，4 个大视口 × 上千条文字 → 文件从 13 MB 涨到 46 MB、
   * 浏览器解析/裁剪从 3 s 涨到 33 s（实测施工005）。布局页要的是"字别丢"，
   * 不是"字必须单线"，所以这里保留 TEXT，交给 TTF 渲染；模型页行为不变。 */
  if (shxEnabled && !layoutSpace) {
    try {
      const fonts = await import("./fonts.js").catch(() => null);
      const styleTable =
        fonts && typeof fonts.readStyleTable === "function" ? fonts.readStyleTable(srcPath) : null;
      const shxCtx = await createShxContext({
        root: options.fontRoot || path.dirname(srcPath),
        styleTable,
        codepage: encoding,
        /* 默认单线体：TTF 样式也映射到 simplex/txt + hztxt/gbcbig，避免同图里
         * "细单线 + 粗填充"混排（用户反馈的粗细不一）。设 CADVIEWER_TEXT_STROKE=auto 可恢复按样式。 */
        textStroke: textStrokeMode,
      });
      if (shxCtx?.hasAnyShx) activeShxCtx = shxCtx;
    } catch {
      activeShxCtx = null; // 任何异常都降级成"SHX 关闭"
    }
  }

  /* ③bb 自定义实体代理图形（v45 起；v46 起文字直接出单线笔画）：
   * 机柜图/施工图里的 IAEC_WALL、IAEC_TEXT、IAEC_OPENING、IAEC_ARROW 等是第三方
   * 插件的自定义对象，几何只存在 310 组码里，dxf-viewer 不认识类型会整条丢弃。
   * 这里按实测格式解码并就地替换成标准实体（LWPOLYLINE / TEXT / SOLID），保留原
   * handle、图层、颜色；解不出来的原样保留（宁可不动，也不能删）。
   *
   * 必须在 activeShxCtx 之后、`start` 之前：
   *   · 代理文字要复用 SHX 字体出笔画（`acad-cab.dxf` 的 250 条 IAEC_TEXT 全在
   *     BLOCKS 段的块定义里，convertShxTexts 只转顶层 ENTITIES/标注块，覆盖不到）；
   *   · 笔画是 LWPOLYLINE，句柄从当前最大值往后排，不能和后面的注入实体撞号。
   * 格式说明见 proxy-graphics.js 顶部。 */
  const proxyResult =
    options.proxyGraphics === false || process.env.CADVIEWER_NO_PROXY_GRAPHICS === "1"
      ? {
          text: s,
          converted: 0,
          primitives: 0,
          unsupported: 0,
          kind33: 0,
          approximated: 0,
          byType: {},
          textsStroked: 0,
          textsKept: 0,
          strokePolylines: 0,
        }
      : convertProxyGraphicsEntities(s, maxHandle(s) + 1, { shxCtx: activeShxCtx });
  s = proxyResult.text;

  const start = maxHandle(s) + 1;

  /* CJK 笔画加粗（v25）：只写给**填充四边形**，因为 dxf-viewer 无视线宽
   * （见 strokeEntityTexts 上方说明）。只在单线体模式启用 —— 加粗不得改变 auto
   * 模式的任何输出字节。线宽/上限/图幅都从 options 传下去，三个发射点共用同一个
   * strokeState，保证 SOLID 上限是**全文件**口径。 */
  const strokeState = { solids: 0, fallback: 0 };
  const emitOpts = {
    /* 默认**不加粗**（保留 CAD 的单线观感）；只有 options.thickenStrokes === true
     * 或环境变量 CADVIEWER_STROKE_THICK=1 才生成 SOLID。 */
    thick: thickenAllowed(activeShxCtx, {
      thick:
        options.thickenStrokes === true
          ? true
          : options.thickenStrokes === false
            ? false
            : undefined,
    }),
    strokeWidth: options.strokeWidth,
    strokeWidthMult: options.strokeWidthMult,
    drawingSize:
      cbox && Number.isFinite(cbox.width) && Number.isFinite(cbox.height)
        ? Math.max(cbox.width, cbox.height)
        : 0,
    maxSolids: options.maxSolids,
    state: strokeState,
  };

  /* 顶层 TEXT/MTEXT + 尺寸标注块内文字先按行区间整段替换
   *（最安全：不碰组码结构），再排注入实体的句柄。 */
  let shxUsed = 0;
  let shxMissingTexts = 0;
  if (activeShxCtx) {
    const conv = convertShxTexts(s, activeShxCtx, start, layers, emitOpts);
    s = conv.text;
    shxStats.texts += conv.texts;
    shxStats.polylines += conv.polylines;
    shxStats.missing += conv.missing;
    shxStats.mtext += conv.mtext;
    shxStats.dimTexts += conv.dimTexts;
    shxStats.dimMtext += conv.dimMtext;
    shxStats.dimPolylines += conv.dimPolylines;
    shxMissingTexts = conv.missingTexts || 0;
    shxUsed = conv.used;
  }

  const base = start + shxUsed;
  /* v21：注入文字（表格单元格 + 块内展开文字）统一走笔画转换，并与"留在 TEXT 的兜底"
   * 分开计数。旧的"无 ctx / 无字形"路径仍然逐字节产出 TEXT。 */
  const injectedStats = { strokes: 0, fallback: 0, mtextWrapped: 0, skippedHidden: 0, missingGlyphTexts: 0 };
  const tablePart = buildTableEntities(
    tables, layers, base, focus, activeShxCtx, injectedStats, emitOpts, hiddenLayers
  );
  const ents = tablePart.entities;
  /* 注意：不能写成 ents.push(...buildBlockTextEntities(...))。
   * 大图纸（实测 87MB DXF）会产生上万条注入实体，展开成实参直接
   * "Maximum call stack size exceeded"，导致整张图 500 渲染失败。 */
  for (const e of buildBlockTextEntities(
    blockTexts,
    layers,
    tablePart.nextHandle,
    focus,
    activeShxCtx,
    shxStats,
    injectedStats,
    emitOpts,
    hiddenLayers
  )) {
    ents.push(e);
  }
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

  /* v37：把 XCLIP / SPATIAL_FILTER 的矩形边界以 XDATA 写回对应 INSERT，供引擎裁剪。
   * 必须放在所有重写/注入之后（插入实体、模型空间过滤都会增删 INSERT）。
   * ⚠️ v57：注入点现在在布局构建之前 —— 布局的视口块靠拷贝 INSERT 记录来继承 XDATA。
   * 注入是幂等的：已有同一条 XDATA 的 INSERT 不会重复写（见 injectSpatialFilterXdata），
   * 布局分支因此可以安全地再用一次结果。 */
  /* ③d 图外散点过滤（v61）：整盒落在 contentBox 外扩 3× 对角线之外的顶层实体不产出。
   * 必须在所有注入之后：这样块内展开文字、代理图形、表格、天正几何都按同一口径处理；
   * 必须在布局构建之前：布局的视口块拷贝的就是这里过滤后的模型实体，两个空间行为一致。
   * 图纸空间（67=1）由函数内部跳过，图框/标题栏不受影响。关闭时 s 原样返回。 */
  const strayEnabled = resolveStrayFilter(options);
  const strayResult = strayEnabled
    ? filterStrayEntities(s, cbox)
    : { text: s, removed: 0, samples: [], byKind: {}, limit: null, skipped: "disabled" };
  s = strayResult.text;

  const clipFilters = extractSpatialFilters(s, cbox);
  let clipInjected = 0;
  if (clipFilters.size) {
    const injected = injectSpatialFilterXdata(s, clipFilters);
    s = injected.text;
    clipInjected = injected.injected;
  }

  /* ⓪c 布局空间（v57）：到这里 `s` 已经过与模型页完全相同的预处理 —— ⓪ 隐藏层、
   * ⓪a 天正注入、① ATTRIB 删除、② 块内文字摊平 + SHX 单线笔画、表格、③bb 代理图形、
   * ③c LEADER/MLINE 合成、XCLIP。现在才把视口内的模型实体拷进 `*CV_VP_*` 块，
   * 布局页因此不会再出现"模型有、布局没有"的文字/属性/天正对象。
   * 布局里的筛选对象有两类，必须在 buildLayoutSpace **之前**注入 XDATA：
   *   ① 该布局的纸张空间 INSERT（施工005 的 16F99/16F9D，G-GRID-DIMS 轴网尺寸带）；
   *   ② 视口内被原样拷贝进 `*CV_VP_*` 块的模型 INSERT（例如 54169）。
   * 拷贝记录时 XDATA 会跟着 old handle 一起复制 —— 所以直接用上面那一次注入的结果。 */
  if (layoutSpace) {
    const layoutResult = buildLayoutSpace(s, layoutSpace.name, clipFilters.size > 0);
    if (layoutResult) {
      fs.writeFileSync(outPath, Buffer.from(layoutResult.text, "utf8"));
      return {
        bytes: fs.statSync(outPath).size,
        entities: layoutResult.stats.copied,
        tables: tables.length,
        cells,
        decoded: before,
        diameterFixed,
        encoding,
        attribRemoved,
        blockTextRemoved,
        keptDimText,
        blockTexts: blockTexts.length,
        flatTotal: flat.items.length,
        flatStats: flat.stats,
        focus: null,
        focusMuted: 0,
        focusKept: 0,
        space: layoutResult.stats.space,
        spaceFallback: false,
        proxyConverted: proxyResult.converted,
        proxyPrimitives: proxyResult.primitives,
        proxyUnsupported: proxyResult.unsupported,
        proxyKind33: proxyResult.kind33,
        proxyApproximated: proxyResult.approximated,
        proxyByType: proxyResult.byType,
        proxyTextsStroked: proxyResult.textsStroked || 0,
        proxyTextsKept: proxyResult.textsKept || 0,
        /* v51：天正洞口注入统计（无 dump 时全为 0，产出与 v50 一致） */
        udoDetected: udoResult.detected,
        udoDecoded: udoResult.decoded,
        udoInjected: udoResult.injected,
        udoSkipped: udoResult.skipped,
        udoOpenings: udoResult.byKind.opening,
        udoWalls: udoResult.byKind.wall,
        udoTexts: udoResult.byKind.text,
        udoDimensions: udoResult.byKind.dimension,
        udoPrimitives: udoResult.primitives,
        ...layoutResult.stats,
        /* v61：图外散点过滤（布局页与模型页同一口径） */
        strayFilter: strayEnabled,
        strayRemoved: strayResult.removed,
        strayByKind: strayResult.byKind,
        straySamples: strayResult.samples,
        strayLimit: strayResult.limit
          ? {
              minX: strayResult.limit.minX,
              minY: strayResult.limit.minY,
              maxX: strayResult.limit.maxX,
              maxY: strayResult.limit.maxY,
              pad: strayResult.limit.pad,
            }
          : null,
        clipFilters: clipFilters.size,
        clipInjected,
        paperTextsDropped,
        warnings: [],
      };
    }
    /* 预处理之后仍构建不出布局（理论上走不到）：回落模型空间，绝不让开图失败。 */
    const fallback = filterModelSpace(s);
    s = fallback.text;
    spaceInfo = { kind: "model", removed: fallback.removed, fallback: true };
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
    /** 因是尺寸标注预渲染块而**保留**的块内文字数（v16 起） */
    keptDimText,
    blockTexts: blockTexts.length,
    flatTotal: flat.items.length,
    /* v30：块内/顶层 MTEXT 走 mtextToPlainText 的条数（应为解析到的全部 MTEXT）。 */
    flatMtext: flat.stats.mtext ?? 0,
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
    /* ── v34：模型 / 布局空间 ── */
    space: spaceInfo ? (spaceInfo.fallback ? "model" : spaceInfo.kind) : null,
    spaceRemoved: spaceInfo?.removed ?? 0,
    spaceFallback: !!(spaceInfo && spaceInfo.fallback),
    paperTextsDropped,
    // v31：块内颜色烘焙统计（0 表示没有可安全烘焙的实体，产出与 v30 一致）
    blockColourBaked: bakeResult.baked,
    blockColourLayerZeroBaked: bakeResult.layerZeroBaked,
    blockColourAmbiguous: bakeResult.ambiguous,
    blockColourLayerZeroSkipped: bakeResult.layerZeroSkipped,
    blockColourUnknownLayer: bakeResult.unknownLayer,
    // v45：自定义实体代理图形（310）转换
    proxyConverted: proxyResult.converted,
    proxyPrimitives: proxyResult.primitives,
    proxyUnsupported: proxyResult.unsupported,
    proxyKind33: proxyResult.kind33,
    proxyApproximated: proxyResult.approximated,
    proxyByType: proxyResult.byType,
    /* v46：代理文字改为单线笔画（与 SHX 文字同一套字形）后的条数统计 */
    proxyTextsStroked: proxyResult.textsStroked,
    proxyTextsKept: proxyResult.textsKept,
    proxyStrokePolylines: proxyResult.strokePolylines,
    /* ── v51：天正几何注入（没有 dump 时全为 0，产出与 v50 逐字节一致）──
     * udoDetected = udo-cli 看到的自定义对象实体总数（含没有解码器的类）
     * udoDecoded  = 其中 status=decoded 的个数（= 前端"已尝试解析 N 个"）
     * udoInjected = 真正注入的自定义对象实体数（opening/wall/text/dimension 四类之和）
     * udoPrimitives = 写进 DXF 的实体条数（墙体一面墙两条线，所以 ≥ udoInjected）
     * udoOpenings/udoWalls/udoTexts/udoDimensions = 四类各自的注入数
     * udoSkipped  = udoDetected - udoInjected（未解码/无解码器/隐藏层/退化几何） */
    udoDetected: udoResult.detected,
    udoDecoded: udoResult.decoded,
    udoInjected: udoResult.injected,
    udoPrimitives: udoResult.primitives,
    udoOpenings: udoResult.byKind.opening,
    udoWalls: udoResult.byKind.wall,
    udoTexts: udoResult.byKind.text,
    udoDimensions: udoResult.byKind.dimension,
    udoSkipped: udoResult.skipped,
    udoMissingLayer: udoResult.missingLayer,
    udoHidden: udoResult.hidden,
    /* 文字没有自带字高时用的兜底值（$TEXTSIZE / UDO_TEXT_HEIGHT）；有自带字高则为 null */
    udoTextHeight: udoResult.textHeight,
    // v15：SHX 笔画文字统计（无 SHX 字体时全为 0，文件产出与 v14 一致）
    shxTexts: shxStats.texts,
    shxPolylines: shxStats.polylines,
    shxMissingGlyphs: shxStats.missing,
    /* v39：因缺字形整条回退给 TTF 的文字数（按"条"计，不是字符数） */
    shxMissingGlyphTexts: shxMissingTexts + (injectedStats.missingGlyphTexts || 0),
    shxStyles: activeShxCtx ? activeShxCtx.styles.size : 0,
    // v18：MTEXT 与尺寸标注预渲染块内文字（同样在无 SHX 字体时全为 0）
    mtextConverted: shxStats.mtext + shxStats.dimMtext,
    dimBlockTexts: shxStats.dimTexts,
    dimBlockPolylines: shxStats.dimPolylines,
    // v21：注入文字（表格单元格 + 块内展开）的笔画/兜底统计
    injectedTextStrokes: injectedStats.strokes,
    injectedTextFallback: injectedStats.fallback,
    blockMtextWrapped: injectedStats.mtextWrapped,
    // v25：CJK 加粗（填充 SOLID）统计；auto 模式恒为 0（加粗不改变 auto 输出）
    thickStrokeSolids: strokeState.solids,
    thickStrokeFallback: strokeState.fallback,

    /* ── v32：隐藏图层过滤 ── */
    skippedOffLayerEntities: hiddenResult.off,
    skippedFrozenLayerEntities: hiddenResult.frozen,
    skippedHiddenLayerEntities: hiddenResult.skipped,
    hiddenLayers: hiddenResult.layers.map((l) => l.name),
    hiddenLayerDetails: hiddenResult.layers,
    skippedHiddenInjectedTexts: injectedStats.skippedHidden,
    /* ── v37：XCLIP / SPATIAL_FILTER ── */
    clipFilters: clipFilters.size,
    clipInjected,
    /* ── v61：图外散点过滤 ── */
    strayFilter: strayEnabled,
    strayRemoved: strayResult.removed,
    strayByKind: strayResult.byKind,
    straySamples: strayResult.samples,
    strayLimit: strayResult.limit
      ? {
          minX: strayResult.limit.minX,
          minY: strayResult.limit.minY,
          maxX: strayResult.limit.maxX,
          maxY: strayResult.limit.maxY,
          pad: strayResult.limit.pad,
        }
      : null,
    /* v49：块内展平文字/笔画按同一过滤器裁掉的条数（ATTRIB 不计） */
    clipTextsRemoved: clipTextStats.removed,
    clipTextsKept: clipTextStats.kept,
    /* ── v32：LEADER / MULTILEADER / MLINE 合成 ── */
    leadersConverted: leaderResult.leadersConverted,
    leaderArrows: leaderResult.leaderArrows,
    leaderAnnotations: leaderResult.leaderAnnotations,
    multileadersConverted: mleaderResult.multileadersConverted,
    multileaderTexts: mleaderResult.multileaderTexts,
    leaderFallbacks: leaderResult.leaderFallbacks + mleaderResult.leaderFallbacks,
    mlinesConverted: mlineResult.mlinesConverted,
    mlineElements: mlineResult.mlineElements,
    mlineFallbacks: mlineResult.mlineFallbacks,
    /** 警告（供前端/排查用）：被隐藏的图层 + 解析失败的合成实体 */
    warnings: [
      ...hiddenResult.layers.map((l) => ({
        code: l.reason === "off" ? "off-layer-filtered" : "frozen-layer-filtered",
        layer: l.name,
        reason: l.reason,
        source: l.source,
        entities: l.entities,
      })),
      ...(leaderResult.leaderFallbacks + mleaderResult.leaderFallbacks
        ? [{
            code: "leader-fallback",
            count: leaderResult.leaderFallbacks + mleaderResult.leaderFallbacks,
          }]
        : []),
      ...(mlineResult.mlineFallbacks
        ? [{ code: "mline-fallback", count: mlineResult.mlineFallbacks }]
        : []),
    ],
  };
}

/* ─────────────────── 导出 XCLIP 几何裁剪（v67）───────────────────
 *
 * 为什么导出必须自己裁：屏幕链路把 SPATIAL_FILTER 转成 `CADVIEWER_XCLIP` XDATA 交给
 * WebGL 引擎按 INSERT 裁剪；导出链路下游是 cadcraft（PDF）和第三方 CAD，
 *   · cadcraft 不读 SPATIAL_FILTER → PDF 里被裁块的整块内容都画出来；
 *   · 只写 XDATA 也没用（不是标准 DXF 语义）。
 * 所以导出 DXF 必须在**几何层**把裁剪范围外的实体真正去掉，PDF 与 DXF 才能和屏幕一致。
 *
 * 实测（施工005 / cache ee60118fd8f1 / converted.dxf）：3 个 SPATIAL_FILTER，
 * 其中 INSERT 54169（块 A$C29980DFE）有 7356 条块内实体，只有 59 条完整落在裁剪范围内，
 * 33 条跨越边界，**4854 条完全在外**——这些就是 PDF 里多画出来的墙/门/文字。
 *
 * 实现策略（刻意保守，宁可少裁也不能生成非法 DXF）：
 *   · 只处理**顶层 ENTITIES 里、且块定义只被引用一次**的被裁 INSERT —— 这样可以
 *     原地重写块定义，不必新增 BLOCK 记录 / 重新分配 handle / 修 330 owner 链；
 *   · 块内实体递归看嵌套 INSERT：完全在内保留、完全在外删除、跨界的 INSERT 保留整块并计数；
 *   · LINE/LWPOLYLINE 精确裁成多段；CIRCLE/ARC 跨界时转成 LWPOLYLINE 近似；
 *     TEXT/MTEXT/ATTRIB 按插入/对齐点判定；HATCH/DIMENSION 等高阶实体按顶点判定（保守）。
 *
 * 统计写进 buildExportDxf 的返回值（clipped*），报告与单测都据此验收。
 */

/** 点的多边形内判定（边界算内），与屏幕链路同一实现。 */
function pointInsidePolygon(x, y, polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return true;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j];
    const b = polygon[i];
    const cross = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
    if (
      Math.abs(cross) <= 1e-9 &&
      x >= Math.min(a[0], b[0]) - 1e-9 &&
      x <= Math.max(a[0], b[0]) + 1e-9 &&
      y >= Math.min(a[1], b[1]) - 1e-9 &&
      y <= Math.max(a[1], b[1]) + 1e-9
    ) {
      return true;
    }
    if ((b[1] > y) !== (a[1] > y)) {
      const t = (y - b[1]) / (a[1] - b[1]);
      if (x < b[0] + t * (a[0] - b[0])) inside = !inside;
    }
  }
  return inside;
}

/** 线段参数区间 [t0,t1]（0..1），落在多边形内的部分；空数组=完全在外。 */
function segmentIntervalsInside(p, q, polygon) {
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const ts = [0, 1];
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j];
    const b = polygon[i];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((a[0] - p[0]) * ey - (a[1] - p[1]) * ex) / den;
    const u = ((a[0] - p[0]) * dy - (a[1] - p[1]) * dx) / den;
    if (t > 1e-9 && t < 1 - 1e-9 && u >= -1e-9 && u <= 1 + 1e-9) ts.push(t);
  }
  ts.sort((x, y) => x - y);
  const at = (t) => [p[0] + dx * t, p[1] + dy * t];
  const out = [];
  for (let i = 0; i + 1 < ts.length; i++) {
    const t0 = ts[i];
    const t1 = ts[i + 1];
    if (t1 - t0 < 1e-9) continue;
    const mid = at((t0 + t1) / 2);
    if (pointInsidePolygon(mid[0], mid[1], polygon)) out.push([t0, t1]);
  }
  return out;
}

/**
 * 折线按多边形裁剪成若干连续段。
 * @returns {number[][][]} 每段是点数组（≥2 点）
 */
function clipPolylineToPolygonRuns(points, closed, polygon) {
  if (!points.length) return [];
  const path = closed && points.length > 1 ? [...points, points[0]] : points;
  const runs = [];
  let cur = [];
  const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
  for (let i = 0; i + 1 < path.length; i++) {
    const p = path[i];
    const q = path[i + 1];
    const intervals = segmentIntervalsInside(p, q, polygon);
    if (!intervals.length) {
      if (cur.length >= 2) runs.push(cur);
      cur = [];
      continue;
    }
    for (const [t0, t1] of intervals) {
      const a = [p[0] + (q[0] - p[0]) * t0, p[1] + (q[1] - p[1]) * t0];
      const b = [p[0] + (q[0] - p[0]) * t1, p[1] + (q[1] - p[1]) * t1];
      if (cur.length && same(cur[cur.length - 1], a)) {
        if (!same(cur[cur.length - 1], b)) cur.push(b);
      } else {
        if (cur.length >= 2) runs.push(cur);
        cur = [a, b];
      }
    }
  }
  if (cur.length >= 2) runs.push(cur);
  return runs;
}

/** DXF 组码快照：只取与外观相关的，几何组码由调用方重写。 */
const EXPORT_KEEP_CODES = [8, 6, 62, 370, 48, 60, 39, 38, 67, 410, 210, 220, 230];
function keptGroups(rec) {
  const out = [];
  for (const [code, value] of rec.groups) {
    if (EXPORT_KEEP_CODES.includes(code)) out.push([code, String(value)]);
  }
  return out;
}

/**
 * 生成实体文本行（不带行尾换行符）。
 * 结构照抄本文件既有写法（polylineRows / solidRows）：
 *   0/<TYPE> 5/<handle> [330/<owner>] 100/AcDbEntity 8/<layer> [62/…] 100/AcDbLine|AcDbPolyline 几何
 */
function emitEntityLines(type, meta, geom) {
  const rows = ["0", type, "5", meta.handle];
  if (meta.owner) rows.push("330", meta.owner);
  rows.push("100", "AcDbEntity");
  for (const [code, value] of meta.groups) rows.push(String(code), value);
  rows.push("100", type === "LINE" ? "AcDbLine" : "AcDbPolyline");
  if (geom.kind === "LINE") {
    rows.push("10", fmtCoord(geom.a[0]), "20", fmtCoord(geom.a[1]), "30", "0.0");
    rows.push("11", fmtCoord(geom.b[0]), "21", fmtCoord(geom.b[1]), "31", "0.0");
  } else {
    rows.push("90", String(geom.points.length), "70", geom.closed ? "1" : "0");
    for (const [x, y] of geom.points) rows.push("10", fmtCoord(x), "20", fmtCoord(y));
  }
  return rows;
}

/** 坐标格式化：保留 6 位小数，去掉尾零（比转换前的 1e-4 更稳，不引入可见误差）。 */
function fmtCoord(n) {
  if (!Number.isFinite(n)) return "0.0";
  const r = Math.round(n * 1e6) / 1e6;
  return String(r === 0 ? 0 : r);
}

/** 从实体记录里取可测点（LWPOLYLINE 取顶点，LINE 取两端，其它取 10/20/11/21/13/23/14/24）。 */
function recordPoints(rec) {
  const g = rec.groups;
  const pairs = [];
  if (rec.type === "LWPOLYLINE") {
    let x = null;
    for (const [code, value] of g) {
      if (code === 10) x = Number(value);
      else if (code === 20 && x !== null) {
        pairs.push([x, Number(value)]);
        x = null;
      }
    }
    return { points: pairs, closed: (Number(firstGroup(g, 70)) || 0) & 1 ? true : false };
  }
  if (rec.type === "LINE") {
    return {
      points: [
        [Number(firstGroup(g, 10)), Number(firstGroup(g, 20))],
        [Number(firstGroup(g, 11)), Number(firstGroup(g, 21))],
      ],
      closed: false,
    };
  }
  for (const [xCode, yCode] of [[10, 20], [11, 21], [13, 23], [14, 24], [15, 25], [16, 26]]) {
    const x = Number(firstGroup(g, xCode));
    const y = Number(firstGroup(g, yCode));
    if (Number.isFinite(x) && Number.isFinite(y)) pairs.push([x, y]);
  }
  return { points: pairs, closed: false };
}

function firstGroup(groups, code) {
  for (const [c, v] of groups) if (c === code) return v;
  return undefined;
}

/** 块内容包围盒（块坐标，递归含嵌套 INSERT；带 memo）。 */
function blockBBox(name, blocks, memo = new Map(), depth = 0) {
  if (memo.has(name)) return memo.get(name);
  if (depth > 12) return null;
  const ents = blocks.get(name)?.recs;
  if (!ents) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  for (const rec of ents) {
    if (rec.type === "INSERT") {
      const child = blockBBox(firstGroup(rec.groups, 2), blocks, memo, depth + 1);
      if (!child) continue;
      const m = insertMatrixFromGroups(rec.groups);
      for (const [cx, cy] of [
        [child.minX, child.minY],
        [child.maxX, child.minY],
        [child.maxX, child.maxY],
        [child.minX, child.maxY],
      ]) {
        const p = applyMatrix6(m, cx, cy);
        if (p) add(p[0], p[1]);
      }
      continue;
    }
    const { points } = recordPoints(rec);
    for (const [x, y] of points) add(x, y);
    if (rec.type === "CIRCLE" || rec.type === "ARC") {
      const cx = Number(firstGroup(rec.groups, 10));
      const cy = Number(firstGroup(rec.groups, 20));
      const r = Number(firstGroup(rec.groups, 40));
      if (Number.isFinite(r)) {
        add(cx - r, cy - r);
        add(cx + r, cy + r);
      }
    }
  }
  const box = Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
  memo.set(name, box);
  return box;
}

/** INSERT 的 6 元矩阵（与 block-text.js 的 insertMatrix 同口径）。 */
function insertMatrixFromGroups(groups) {
  const x = Number(firstGroup(groups, 10) || 0);
  const y = Number(firstGroup(groups, 20) || 0);
  const sx = Number(firstGroup(groups, 41) || 1);
  const sy = Number(firstGroup(groups, 42) || 1);
  const rot = Number(firstGroup(groups, 50) || 0) * (Math.PI / 180);
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  return { a: sx * cos, b: sx * sin, c: -sy * sin, d: sy * cos, e: x, f: y };
}

/**
 * 在 ENTITIES / BLOCKS 文本里裁剪被 XCLIP 的块。
 * @param {string} s DXF 文本
 * @param {Map<string,{points:number[][]}>} filters extractSpatialFilters 结果
 * @returns {{text:string, stats:object}}
 */
export function clipExportXclipBlocks(s, filters) {
  const stats = {
    clippedInserts: 0,
    clippedBlocks: 0,
    droppedEntities: 0,
    clippedEntities: 0,
    splitEntities: 0,
    keptCrossing: 0,
    skippedMultiRef: 0,
    skippedMissingBlock: 0,
    byLayer: {},
  };
  if (!filters || !filters.size) return { text: s, stats };

  const eol = s.includes("\r\n") ? "\r\n" : "\n";
  const lines = s.split(/\r?\n/);
  const sections = findSections(lines);
  if (!sections.BLOCKS || !sections.ENTITIES) return { text: s, stats };

  const entRecords = scanRecords(lines, sections.ENTITIES.from, sections.ENTITIES.to);
  const blockRecords = scanRecords(lines, sections.BLOCKS.from, sections.BLOCKS.to);
  const blocks = new Map(); // name -> {recs, header, hasEnd}
  let cur = null;
  for (const rec of blockRecords) {
    if (rec.type === "BLOCK") {
      cur = { name: decodeUnicodeEscapes(firstGroup(rec.groups, 2) || "*?"), recs: [], header: rec };
      blocks.set(cur.name, cur);
    } else if (rec.type === "ENDBLK") {
      cur = null;
    } else if (cur) {
      cur.recs.push(rec);
    }
  }

  /* INSERT handle → 顶层记录 */
  const insertByHandle = new Map();
  for (const rec of entRecords) {
    if (rec.type !== "INSERT") continue;
    const h = String(firstGroup(rec.groups, 5) || "").toUpperCase();
    if (h) insertByHandle.set(h, rec);
  }

  /* 块名 → 引用次数（ENTITIES + 所有块定义） */
  const refCount = new Map();
  const bumpRef = (recs) => {
    for (const rec of recs) {
      if (rec.type !== "INSERT") continue;
      const n = decodeUnicodeEscapes(firstGroup(rec.groups, 2) || "");
      refCount.set(n, (refCount.get(n) || 0) + 1);
    }
  };
  bumpRef(entRecords);
  for (const b of blocks.values()) bumpRef(b.recs);

  const edits = []; // {from, to, lines}
  let handleSeq = maxHandle(s) + 1;
  const nextHandle = () => (handleSeq++).toString(16).toUpperCase();

  for (const [handle, filter] of filters) {
    const rec = insertByHandle.get(handle);
    if (!rec) continue;
    const blockName = decodeUnicodeEscapes(firstGroup(rec.groups, 2) || "");
    const block = blocks.get(blockName);
    if (!block) {
      stats.skippedMissingBlock++;
      continue;
    }
    const polygon = filter.points;
    if (!Array.isArray(polygon) || polygon.length < 3) continue;
    if ((refCount.get(blockName) || 0) > 1) {
      /* 块被多处引用：原地重写会影响其它 INSERT。保守跳过（PDF 仍是整块，但不产生非法 DXF）。 */
      stats.skippedMultiRef++;
      continue;
    }
    stats.clippedInserts++;
    stats.clippedBlocks++;

    const out = [];
    let dropChain = false;
    for (const r of block.recs) {
      /* INSERT 的 ATTRIB/SEQEND 跟随链：所属 INSERT 被删时整条链一起删，
       * 否则 SEQEND 指向一个不存在的 handle（非法 DXF）。 */
      if (dropChain) {
        if (r.type === "SEQEND") dropChain = false;
        continue;
      }
      const res = clipRecord(r, polygon, {
        blocks,
        nextHandle,
        stats,
      });
      if (res.action === "drop") {
        stats.droppedEntities++;
        const key = `${decodeUnicodeEscapes(firstGroup(r.groups, 8) || "0")}|${r.type}`;
        stats.byLayer[key] = (stats.byLayer[key] || 0) + 1;
        if (r.type === "INSERT" && (Number(firstGroup(r.groups, 66)) || 0) === 1) {
          dropChain = true;
        }
        continue;
      }
      if (res.action === "split") {
        stats.splitEntities++;
        for (const piece of res.pieces) out.push(...piece);
        continue;
      }
      if (res.action === "clip") stats.clippedEntities++;
      out.push(...res.lines);
    }

    /* 用新内容替换块定义里的实体区（BLOCK 头与 ENDBLK 保留，handle/owner 不变）。 */
    const first = block.recs[0];
    const last = block.recs[block.recs.length - 1];
    if (first) {
      edits.push({ from: first.start, to: last.end, lines: out });
    } else if (block.header) {
      // 空块：不动
    }
  }

  for (const e of edits.sort((a, b) => b.from - a.from)) {
    lines.splice(e.from, e.to - e.from, ...e.lines);
  }
  return { text: lines.join(eol), stats };

  /* ── 内部工具 ── */
  function rawRecord(rec) {
    const out = ["0", rec.type];
    for (const [code, value] of rec.groups) out.push(String(code), String(value));
    return out;
  }

  /**
   * 单条实体的裁剪。
   * @returns {{action:"keep"|"drop"|"clip"|"split", lines?:string[], pieces?:string[][]}}
   */
  function clipRecord(r, poly, ctx) {
    const { points, closed } = recordPoints(r);
    const type = r.type;

    /* 跟随链 / 无几何实体：保持原样，交给所属 INSERT 的处理结果 */
    if (type === "SEQEND" || type === "ATTRIB" || type === "ATTDEF") {
      if (!points.length) return { action: "keep", lines: rawRecord(r) };
    }

    if (type === "INSERT") {
      const childName = decodeUnicodeEscapes(firstGroup(r.groups, 2) || "");
      const box = blockBBox(childName, ctx.blocks);
      if (!box) return { action: "keep", lines: rawRecord(r) };
      const m = insertMatrixFromGroups(r.groups);
      const corners = [
        [box.minX, box.minY],
        [box.maxX, box.minY],
        [box.maxX, box.maxY],
        [box.minX, box.maxY],
      ]
        .map(([x, y]) => applyMatrix6(m, x, y))
        .filter(Boolean);
      if (!corners.length) return { action: "keep", lines: rawRecord(r) };
      const inCount = corners.filter(([x, y]) => pointInsidePolygon(x, y, poly)).length;
      if (inCount === corners.length) return { action: "keep", lines: rawRecord(r) };
      if (inCount === 0 && !bboxOverlapsPolygon(corners, poly)) {
        return { action: "drop" };
      }
      /* 跨界嵌套块：保留整块（不生成派生块，避免 handle/owner 链风险）。 */
      stats.keptCrossing++;
      stats.clippedEntities++;
      return { action: "keep", lines: rawRecord(r) };
    }

    if (!points.length) return { action: "keep", lines: rawRecord(r) };

    /* 圆/弧：按 64 段采样点判定，不能用圆心一个点（圆心在裁剪框内、圆却伸到框外很常见）。 */
    if (type === "CIRCLE" || type === "ARC") {
      const cx = Number(firstGroup(r.groups, 10));
      const cy = Number(firstGroup(r.groups, 20));
      const rr = Number(firstGroup(r.groups, 40));
      if (![cx, cy, rr].every(Number.isFinite) || rr <= 0) {
        return { action: "keep", lines: rawRecord(r) };
      }
      let a0 = 0;
      let a1 = Math.PI * 2;
      if (type === "ARC") {
        a0 = (Number(firstGroup(r.groups, 50) || 0) * Math.PI) / 180;
        a1 = (Number(firstGroup(r.groups, 51) || 360) * Math.PI) / 180;
        while (a1 <= a0) a1 += Math.PI * 2;
      }
      const n = 64;
      const pts = [];
      for (let i = 0; i <= n; i++) {
        const a = a0 + ((a1 - a0) * i) / n;
        pts.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]);
      }
      const circFlags = pts.map(([x, y]) => pointInsidePolygon(x, y, poly));
      if (circFlags.every(Boolean)) return { action: "keep", lines: rawRecord(r) };
      if (!circFlags.some(Boolean) && !anySegmentCrosses(pts, type === "CIRCLE", poly)) {
        return { action: "drop" };
      }
      const runs = clipPolylineToPolygonRuns(pts, type === "CIRCLE", poly);
      if (!runs.length) return { action: "drop" };
      const pieces = runs.map((run, idx) =>
        emitEntityLines("LWPOLYLINE", entityMeta(r, ctx, idx), {
          kind: "LWPOLYLINE",
          points: run,
          closed: false,
        })
      );
      return pieces.length === 1
        ? { action: "clip", lines: pieces[0] }
        : { action: "split", pieces };
    }

    const inFlags = points.map(([x, y]) => pointInsidePolygon(x, y, poly));
    const allIn = inFlags.every(Boolean);
    const noneIn = !inFlags.some(Boolean);

    if (allIn) return { action: "keep", lines: rawRecord(r) };
    if (noneIn && !anySegmentCrosses(points, closed, poly)) {
      return { action: "drop" };
    }

    if (type === "LINE") {
      const runs = clipPolylineToPolygonRuns(points, false, poly);
      if (!runs.length) return { action: "drop" };
      const pieces = runs.map((run, idx) =>
        emitEntityLines("LINE", entityMeta(r, ctx, idx), {
          kind: "LINE",
          a: run[0],
          b: run[run.length - 1],
        })
      );
      return pieces.length === 1
        ? { action: "clip", lines: pieces[0] }
        : { action: "split", pieces };
    }

    if (type === "LWPOLYLINE") {
      const runs = clipPolylineToPolygonRuns(points, closed, poly);
      if (!runs.length) return { action: "drop" };
      const pieces = runs.map((run, idx) =>
        emitEntityLines("LWPOLYLINE", entityMeta(r, ctx, idx), {
          kind: "LWPOLYLINE",
          points: run,
          closed: false,
        })
      );
      return pieces.length === 1
        ? { action: "clip", lines: pieces[0] }
        : { action: "split", pieces };
    }

    /* TEXT/MTEXT/HATCH/DIMENSION/...：嘴上保守——任一点在内就整条保留 */
    stats.clippedEntities++;
    return { action: "keep", lines: rawRecord(r) };
  }

  /** 复制原实体的 handle（第一片）与 owner；后续分片才申请新 handle。 */
  function entityMeta(rec, ctx, pieceIndex = 0) {
    const h = firstGroup(rec.groups, 5);
    const owner = firstGroup(rec.groups, 330);
    return {
      handle: h && pieceIndex === 0 ? String(h) : ctx.nextHandle(),
      owner: owner ? String(owner) : "",
      groups: keptGroups(rec),
    };
  }

  function anySegmentCrosses(points, closed, poly) {
    const path = closed && points.length > 1 ? [...points, points[0]] : points;
    for (let i = 0; i + 1 < path.length; i++) {
      if (segmentIntervalsInside(path[i], path[i + 1], poly).length) return true;
    }
    return false;
  }

  function bboxOverlapsPolygon(corners, poly) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of corners) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    let px0 = Infinity;
    let py0 = Infinity;
    let px1 = -Infinity;
    let py1 = -Infinity;
    for (const [x, y] of poly) {
      if (x < px0) px0 = x;
      if (x > px1) px1 = x;
      if (y < py0) py0 = y;
      if (y > py1) py1 = y;
    }
    return !(maxX < px0 || minX > px1 || maxY < py0 || minY > py1);
  }
}

/** 找 SECTION 段的行号范围（不含 0/SECTION 与 0/ENDSEC）。 */
function findSections(lines) {
  const out = {};
  let pending = false;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i].trim();
    const value = lines[i + 1].trim();
    if (code === "0" && value === "SECTION") {
      pending = true;
      continue;
    }
    if (pending && code === "2") {
      const name = value.toUpperCase();
      const from = i + 2;
      let to = from;
      while (to + 1 < lines.length) {
        if (lines[to].trim() === "0" && lines[to + 1].trim() === "ENDSEC") break;
        to += 2;
      }
      out[name] = { from, to };
      pending = false;
      i = to - 2;
    }
  }
  return out;
}

/** 在一个行区间里按 0/<TYPE> 分条。 */
function scanRecords(lines, from, to) {
  const recs = [];
  let i = from;
  while (i + 1 < to) {
    if (lines[i].trim() !== "0") {
      i++;
      continue;
    }
    const type = lines[i + 1].trim().toUpperCase();
    let j = i + 2;
    const groups = [];
    while (j + 1 < to && lines[j].trim() !== "0") {
      const code = parseInt(lines[j].trim(), 10);
      if (!Number.isNaN(code)) groups.push([code, lines[j + 1].trim()]);
      j += 2;
    }
    recs.push({ type, start: i, end: j, groups });
    i = j;
  }
  return recs;
}

/* ─────────────────── 导出专用 DXF（v66）───────────────────
 * 为什么需要单独一份（2026-11-11 实测，勿删）：
 *
 * cadcraft 把 DWG 转成 converted.dxf 时会**静默丢掉天正自定义对象**。实测 `智能化图纸`
 * （cache 747038e18a12）的 converted.dxf 里 DOOR_FIRE / WINDOW / LATRINE 三层各只有
 * LAYER 表记录、**0 条实体**；而 udo-dump 里这三层有 199 / 248 / 27 个自定义对象。
 * 屏幕链路（buildWebDxf）早已把 udo-cli 解出的洞口/墙体/文字/尺寸注回去，但导出
 * （`?raw=1` 下载 与 PDF）一直直接吃 converted.dxf → 门、窗、墙、房间名整段缺失。
 *
 * 管线只保留「让导出看见屏幕上那些东西」必需的步骤：
 *   ① 解码 `\U+XXXX` + `%%C` → φ（与屏幕同一份字面；cadcraft 对转义/UTF-8 产物逐字节相同，
 *      已实测 施工005：解码前后 SVG SHA-256 完全一致）；
 *   ② 关闭图层过滤（与屏幕可见性同一口径）；
 *   ③ 天正注入（applyUdoGeometry：洞口/墙/门扇+开启弧/文字/尺寸）；
 *   ④ 310 代理图形 → 标准实体（IAEC_* 等第三方自定义对象，文字保持 TEXT，不做单线化）；
 *   ⑤ ACAD_TABLE **只补单元格文字**（cadcraft 画网格不画字），网格不重复注入；
 *   ⑥ XCLIP / SPATIAL_FILTER 的**几何级**裁剪（v67；见 clipExportXclipBlocks）。
 *
 * 刻意**跳过**的步骤（都是只服务 dxf-viewer 的重处理，导出端 cadcraft 自己能画）：
 *   · 块内文字展开（flattenTexts）—— 实测删掉 施工005 的 1835 条块内 TEXT/MTEXT 后，
 *     cadcraft 的 SVG 从 150.0MB 掉到 119.5MB，说明它本来就画了；再展开会重复；
 *   · ATTRIB 删除 + 重新注入 —— 同上（4013 条 ATTRIB 贡献 1.2MB SVG）；
 *   · SHX 单线笔画化 —— 导出端有自己的文字渲染，转成折线只会让文字变细线、体积暴涨；
 *   · 块内颜色烘焙 / 聚焦涂灰 / 布局空间裁剪 / 图外散点过滤 —— 纯 WebGL 场景需要。
 *   ⚠️ 布局空间裁剪 与 XCLIP 不是一回事：前者是布局视口取景（纯展示），后者是块几何语义。
 *
 * @param {string} srcPath 源 DXF（DWG 输入传 converted.dxf）
 * @param {string} outPath export-v<DXF_WEB_VERSION>.dxf
 * @param {object} [options] 透传给 applyUdoGeometry（udoDumpPath/udoSourcePath/contentBox）
 * @returns {Promise<object>} 统计
 */
export async function buildExportDxf(srcPath, outPath, options = {}) {
  const buf = fs.readFileSync(srcPath);
  let { s, encoding } = decodeDxfBuffer(buf);

  const escaped = (s.match(/\\U\+[0-9A-Fa-f]{4}/g) || []).length;
  s = decodeUnicodeEscapes(s);
  const diameterFixed = (s.match(/%%C/gi) || []).length;
  if (diameterFixed) s = s.replace(/%%C/gi, DIAMETER_CHAR);

  /* ⓪ 关闭图层过滤：屏幕上看不见的实体（LAYER 62<0）导出里也不该出现。
   *    meta.json 的 off 只在 DXF 完全没写 62 时兜底，口径与 buildWebDxf 完全一致。 */
  const hiddenResult = filterHiddenLayers(s, null, metaLayersOf(srcPath));
  s = hiddenResult.text;

  /* ⓪a 天正几何注入：必须在天正文字/洞口 dump 可用时；dump 缺失/损坏时
   *     applyUdoGeometry 原样返回（产出只差 ①② 两步，不影响可用性）。 */
  const udoResult = await applyUdoGeometry(s, options, outPath, hiddenResult.hidden);
  s = udoResult.text;

  /* ③bb 代理图形：只做 310 → 标准实体的解码，不传 shxCtx → 文字保持 TEXT。 */
  const proxyResult =
    options.proxyGraphics === false || process.env.CADVIEWER_NO_PROXY_GRAPHICS === "1"
      ? { text: s, converted: 0, primitives: 0, unsupported: 0 }
      : convertProxyGraphicsEntities(s, maxHandle(s) + 1, { shxCtx: null });
  s = proxyResult.text;

  /* ⑤ 表格单元格文字（只补字，不补网格）。没有 ACAD_TABLE 时 scanTables 返回 []。 */
  let tables = 0;
  let cells = 0;
  let tableTexts = 0;
  if (options.tableText !== false) {
    /* scanTables 读的是**原始**源文件，层名可能还是 `\U+XXXX` 转义；这里统一解码，
     * 否则 `layers.has(t.layer)` 不命中，整张表的字会掉到 0 层。 */
    const list = scanTables(srcPath).map((t) => ({
      ...t,
      layer: decodeUnicodeEscapes(t.layer || "0"),
    }));
    tables = list.length;
    if (list.length) {
      const layers = layerNames(s);
      const tableStats = { strokes: 0, fallback: 0, mtextWrapped: 0, skippedHidden: 0, missingGlyphTexts: 0 };
      const part = buildTableEntities(
        list, layers, maxHandle(s) + 1, null, null, tableStats, null,
        hiddenResult.hidden, { grid: false }
      );
      for (const t of list) cells += t.cells.filter((c) => cleanCellText(c.text || "")).length;
      if (part.entities.length) s = insertEntitiesBeforeEndsec(s, part.entities);
      tableTexts = tableStats.fallback; // shxCtx=null → 每条文字都是 TEXT
    }
  }

  /* ⑥ XCLIP / SPATIAL_FILTER 几何裁剪（v67）：导出下游是 cadcraft（PDF）和第三方 CAD，
   * 都不吃屏幕用的 `CADVIEWER_XCLIP` XDATA，必须在几何层真删。
   * 裁剪在多边形是**块定义坐标**（extractSpatialFilters 的输出），原地重写块定义。 */
  let clipStats = {
    clippedInserts: 0, clippedBlocks: 0, droppedEntities: 0, clippedEntities: 0,
    splitEntities: 0, keptCrossing: 0, skippedMultiRef: 0, skippedMissingBlock: 0, byLayer: {},
  };
  let clipFilters = 0;
  if (options.exportXclip !== false) {
    const filters = extractSpatialFilters(s, null);
    clipFilters = filters.size;
    if (filters.size) {
      const clipped = clipExportXclipBlocks(s, filters);
      s = clipped.text;
      clipStats = { ...clipStats, ...clipped.stats };
    }
  }

  fs.writeFileSync(outPath, Buffer.from(s, "utf8"));
  return {
    bytes: fs.statSync(outPath).size,
    encoding,
    escaped,
    diameterFixed,
    skippedHiddenLayerEntities: hiddenResult.skipped,
    hiddenLayers: hiddenResult.layers.map((l) => l.name),
    udoDetected: udoResult.detected,
    udoDecoded: udoResult.decoded,
    udoInjected: udoResult.injected,
    udoPrimitives: udoResult.primitives,
    udoOpenings: udoResult.byKind.opening,
    udoWalls: udoResult.byKind.wall,
    udoTexts: udoResult.byKind.text,
    udoDimensions: udoResult.byKind.dimension,
    proxyConverted: proxyResult.converted,
    proxyPrimitives: proxyResult.primitives,
    tables,
    cells,
    tableTexts,
    clipFilters,
    ...clipStats,
  };
}

/** 把注入实体插到 ENTITIES 段的 `0 / ENDSEC` 之前（与 buildWebDxf 同一口径）。 */
function insertEntitiesBeforeEndsec(s, rows) {
  const e0 = s.indexOf("\nENTITIES");
  if (e0 < 0) return s;
  const m = /(\r?\n)[ \t]*0\r?\nENDSEC/.exec(s.slice(e0));
  if (!m) return s;
  const at = e0 + m.index + m[1].length;
  return s.slice(0, at) + rows.join("\r\n") + "\r\n" + s.slice(at);
}

/**
 * 导出 DXF 构建的**安全包装**：任何异常都回退到 fallbackPath（通常是 converted.dxf /
 * 原始 DXF），绝不把导出打成 500。
 *
 * @param {{srcPath:string, outPath:string, fallbackPath:string|null, options?:object,
 *          onWarning?:(e:Error)=>void}} a
 * @returns {Promise<{path:string|null, built:boolean, stats?:object, error?:string}>}
 */
export async function buildExportDxfSafe({ srcPath, outPath, fallbackPath, options = {}, onWarning = null }) {
  try {
    const stats = await buildExportDxf(srcPath, outPath, options);
    return { path: outPath, built: true, stats };
  } catch (e) {
    // 半成品绝不能留在缓存里：下次请求会误当"已就绪"
    try {
      if (outPath && fs.existsSync(outPath)) fs.rmSync(outPath, { force: true });
    } catch {
      /* ignore */
    }
    const err = e instanceof Error ? e : new Error(String(e));
    if (onWarning) {
      try {
        onWarning(err);
      } catch {
        /* ignore */
      }
    }
    return { path: fallbackPath || null, built: false, error: err.message };
  }
}

