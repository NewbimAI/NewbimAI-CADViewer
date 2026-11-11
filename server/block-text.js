/**
 * 块内文字展开（把 INSERT 内部的 TEXT / MTEXT / ATTRIB 展平成世界坐标的 TEXT）。
 *
 * 为什么必须做（2026-10-18 实测定位，勿删）：
 * dxf-viewer 1.0.50 的 `_DecomposeText()` / `_DecomposeMText()` / `_DecomposeAttribute()`
 * **收到 blockCtx 却完全不用它** —— 位置直接取 `entity.startPoint`，字高直接取
 * `entity.textHeight`。也就是说块内文字永远按"块内单位 + 块内坐标"画：
 *   · 把标注做成属性块/图块的图纸很常见，块内字高是 0.012、坐标在块基点附近，
 *     插入缩放 600 倍后本该是 7.2 世界单位、落在实际设备旁边；
 *   · 实际渲染出来是**一个 0.012 高的点堆在世界原点附近**，肉眼看就是"文字丢了"。
 *
 * 本图实测（系统图模板_t8）：
 *   顶层 TEXT 4,212 条 → 画得出来（这也是画面上仅剩的那几个字）；
 *   块内 TEXT 1,194 + MTEXT 719 + ATTRIB 2,680 → 全部画不出来。
 *   337 个块定义被 1,802 个 INSERT 引用，展开后约 1.2 万条 —— 正是用户说"缺"的那批。
 *
 * 做法：纯 DXF 解析（不依赖引擎），按 INSERT 链累乘 2D 仿射矩阵，把块内文字变换到
 * 世界坐标，产出**顶层 TEXT** 交给 dxf-viewer 原生渲染。属性 ATTRIB 单独处理：
 * 组码 70 的 bit0（invisible）默认尊重原值 **除非**该 ATTRIB 的 70 与其所属块内同 tag 的
 * ATTDEF 模板完全一致 —— 那是导出时复制的模板标志而非用户意图，此时清掉 bit0 保留文字
 * （见 emit() 内说明）。
 *
 * ── v29：块内文字 = 整块的一部分（唯一正确的变换） ─────────────────────────
 * 每条文字沿 INSERT 链累乘出完整矩阵 M（平移 · 旋转 · 缩放 · 块基点偏移，嵌套逐级 mul）：
 *   · 位置：p_world = M · p_block
 *   · 旋转：rot_world = rot_text + atan2(M.b, M.a)   （DXF 组码 50 是 **CCW 正角**，用 +）
 *   · 字高：h_world = h_block × s，s = hypot(M.a, M.b)（均匀缩放）；
 *           非均匀缩放取两轴平均并记 stats.warnings（字高本身无唯一解）
 *   · 宽度因子 wf 是文字属性，不随块缩放变化
 *   · det(M) < 0（镜像块）：item.mirror = true，shx-text 在本地空间再 (x,y)→(x,-y)，
 *     与 rot_world 合成后严格等于完整矩阵 M（真镜像字形，不是只搬位置）
 *
 * 历史坑（勿回退）：insertMatrix 曾误读 `ins.rotation`（解析器实际存 `ins.rot`），
 * 导致块旋转被静默当成 0；随后用"忽略块旋转 / 把角度取反"两个环境变量去补症状，
 * 二者都已删除。cadcraft 基准图（Drawing1-4「假机柜」rot_text=90 + INSERT rot=90
 * → 世界 180°，落在机柜格内）验证了上面的公式。
 *
 * ── v30：块内 MTEXT 的内联码统一走 shx-text.js 的 `mtextToPlainText()` ──────────
 * 本模块以前自带一份 `cleanText(raw, true)`，只删「`\X…;`（带分号）」的码；
 * MTEXT 的无参数开关码 `\o`（上划线）/ `\l`（下划线）/ `\k`（删除线）会原样留下，
 * 于是标题被画成 `\o\l数据机房通道…`，并且多出的 4 个字符把自然宽度从
 * 6462.99 撑到 7325.53 → 触发组码 41 折行，标题变两行。
 * 现在**所有** MTEXT 都走同一份清理器（顶层由 dxf-web.js 调，块内由这里调），
 * TEXT / ATTRIB / ATTDEF 仍用下面的 `cleanText`（它们没有内联排版码）。
 *
 * ── v50：顶层 ATTRIB 无 ATTDEF 模板时，字高一律用组码 40 原值 ─────────────
 * ATTRIB 在 ENTITIES 段是独立实体，位置和字高都已按插入变换烘焙成 WCS；
 * 只有块里存在同 tag 的 ATTDEF 模板时，才需要保留"h 是块内值还是世界值"的二选一。
 * 以前没模板时默认再乘一次 INSERT 缩放，机柜图的门窗库块（无 ATTDEF）因此把
 * 297.5 的字高乘成 2,023,000。详见 emit 调用点上方 `hScale` 分支。
 */
import fs from "node:fs";

import { mtextToPlainText } from "./shx-text.js";

/* ⚠️ 循环依赖（有意为之，勿拆）：shx-text.js 从本模块取 `DIAMETER_CHAR`，本模块从
 * shx-text.js 取 `mtextToPlainText`。两边的符号都只在**函数体内**使用，模块求值阶段
 * 谁都不读对方的绑定，ESM 的 live binding 足够；拆开反而会让"MTEXT 内联码清理"出现
 * 第二份实现 —— 上一版就是这么漏掉 `\o` / `\l` 的（见下方 flush()）。 */

/** 单张图展开后的文字上限：超过就只保留顶层文字，避免超大图把内存打爆 */
const MAX_OUT = 400_000;

/**
 * `%%C`（直径控制码）统一映射字符。
 *
 * 为什么是 φ（U+03C6，不是 AutoCAD 标准的 ⌀ U+2300）——2026-10-19 实测：
 *   用 opentype.js 解析 dxf-viewer 实际加载的字体（`/api/font/simfang.ttf` →
 *   `%WINDIR%\Fonts\simfang.ttf`），按 dxf-viewer `TextRenderer` 建 charMap 的同一口径
 *   （遍历 glyph.unicodes）判定字形是否存在：
 *     · U+2300 ⌀ —— **缺字形**；· U+2205 ∅ —— **也缺字形**；
 *     （两者都会掉进 `fallbackChar` = "�?"，而 U+FFFD 同样缺字形 → 最终画成 "?"）
 *     · U+03C6 φ —— 有字形，正常渲染。
 *   所以整个 Web DXF 一律把 `%%C` 预替换成 φ，让原始文字与注入文字字面一致（见 dxf-web.js）。
 */
/** `%%C`（直径）在 Web DXF 里统一替换成这个字符。
 *  字体是 Noto Serif SC：它有 **U+2205（∅，圆圈+斜杠，与 cadcraft/PDF 画的直径符视觉一致）**，
 *  但**没有** U+2300（真正的 ⌀）——所以取 ∅，不取 ⌀（否则会掉进 fallbackChar 画成 `?`）。
 *  ⚠️ 以后换字体前，先确认新字体有该字形。 */
export const DIAMETER_CHAR = "\u2205";

/* ───────────────────────── 矩阵 ───────────────────────── */

const IDENT = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** m1 ∘ m2（先 m2 后 m1） */
function mul(m1, m2) {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  };
}

const applyM = (m, x, y) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];

/**
 * 线性部分的缩放分解。
 *
 * DXF 的 INSERT 只有 41/42（块内 x / y 缩放）两个自由度，所以线性部分的两列
 * 长度就是 |sx| / |sy|：`hypot(a,b)` / `hypot(c,d)`（旋转不改变列长）。
 * 文字是"整块"的一部分，字高必须乘这个缩放；**旋转**由 `atan2(b,a)` 单独给出。
 *
 * 均匀缩放（|sx|≈|sy|）→ 用 hypot(a,b)，与 cadcraft/AutoCAD 完全一致；
 * 非均匀缩放（镜像块以外的斜切/拉伸）→ 字高无唯一解，取两轴平均并在 stats 里告警。
 * @returns {{s:number, sx:number, sy:number, uniform:boolean}}
 */
function scaleOf(m) {
  const sx = Math.hypot(m.a, m.b);
  const sy = Math.hypot(m.c, m.d);
  const uniform = Math.abs(sx - sy) <= 1e-4 * Math.max(1, sx, sy);
  return { s: uniform ? sx : (sx + sy) / 2, sx, sy, uniform };
}

/** 矩阵里的旋转角（弧度，CCW，与 DXF 组码 50 同一口径） */
const rotOf = (m) => Math.atan2(m.b, m.a);

/** 线性部分的行列式；< 0 表示这一串 INSERT 里发生了镜像 */
const detOf = (m) => m.a * m.d - m.b * m.c;

/** INSERT 的变换矩阵：先平移到块基点、缩放、旋转，再移到插入点 */
function insertMatrix(ins, blockBase) {
  /* 组码 50 在 parseDrawing 里存成 `ins.rot`（老代码误读 `ins.rotation` ——
   * 结果块旋转被静默当成 0，正是"块内文字角度/位置不对"的根因之一）。 */
  const r = (((ins.rot ?? ins.rotation) || 0) * Math.PI) / 180;
  const sx = ins.sx ?? 1;
  const sy = ins.sy ?? 1;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const bx = blockBase[0];
  const by = blockBase[1];
  const m = {
    a: sx * cos,
    b: sx * sin,
    c: -sy * sin,
    d: sy * cos,
    e: 0,
    f: 0,
  };
  m.e = ins.x - (m.a * bx + m.c * by);
  m.f = ins.y - (m.b * bx + m.d * by);
  return m;
}

/* ───────────────────────── DXF 解析 ───────────────────────── */

/** 逐行吐 [code, valueBuffer]（DXF 是"码行/值行"交替的文本） */
function* pairs(buf, from, to) {
  let i = from;
  while (i < to) {
    let e = buf.indexOf(10, i);
    if (e < 0 || e > to) e = to;
    const ce = e > i && buf[e - 1] === 13 ? e - 1 : e;
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

/** 严格 UTF-8 → 失败回落 GBK（cadcraft 两种产物都见过） */
const utf8Strict = new TextDecoder("utf-8", { fatal: true });
const gbk = new TextDecoder("gbk", { fatal: false });
const dec = (vb) => {
  try {
    return utf8Strict.decode(vb);
  } catch {
    return gbk.decode(vb);
  }
};

/** `\U+XXXX`（cadcraft 导出的非 ASCII 写法）→ 真字符 */
const decodeEscapes = (s) =>
  String(s ?? "").replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

/**
 * MTEXT 里的 `\U+XXXX` 与格式码清理（保留可见字符）—— **只给 TEXT / ATTRIB / ATTDEF 用**。
 * MTEXT 一律交给 shx-text.js 的 `mtextToPlainText()`（见 flush()）。
 */
function cleanText(raw) {
  let t = decodeEscapes(raw);
  for (let prev = null; prev !== t; ) {
    prev = t;
    t = t.replace(/\{[^{}]*;/g, "");
  }
  t = t.replace(/\\P/g, " ").replace(/\\~/g, " ");
  t = t.replace(/\\[A-Za-z][^;\\]*;/g, "");
  t = t.replace(/[{}]/g, "");
  t = t
    .replace(/%%C/gi, DIAMETER_CHAR)
    .replace(/%%D/gi, "°")
    .replace(/%%P/gi, "±")
    .replace(/%%%/g, "%");
  /* TEXT 是单行，多行 MTEXT 压成一行；连续空白折叠 */
  return t.replace(/[\r\n]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

/** 抽一个文字类实体的公共字段 */
function textEntity(type) {
  return {
    type,
    text: "",
    x: 0,
    y: 0,
    ax: null,
    ay: null,
    h: 0,
    rot: 0,
    wf: 1,
    halign: 0,
    valign: 0,
    layer: "0",
    aci: 7,
    style: "STANDARD",
    invisible: false,
    attach: 1,
    width: 0,
    paper: false,
  };
}

/**
 * 解析整张图：块定义表 + 顶层实体表。
 * @returns {{blocks: Map<string,{base:[number,number], ents:object[]}>, tops: object[], mtextCount:number}}
 */
function parseDrawing(buf) {
  const blocks = new Map();
  const tops = [];
  const n = buf.length;
  let mtextCount = 0; // 走 mtextToPlainText 抽取的 MTEXT 条数（含块内与顶层）

  /* 段边界：BLOCKS / ENTITIES。只在 ENTITIES 里收顶层实体，避免把块定义里的当成顶层 */
  const iBlocks = buf.indexOf(Buffer.from("\nBLOCKS", "latin1"));
  const iEnts = buf.indexOf(Buffer.from("\nENTITIES", "latin1"));
  const iEnd = buf.indexOf(Buffer.from("\nEOF", "latin1"));

  let cur = null; // 当前解析中的实体
  let curBlock = null; // 当前块定义
  let pendingType = null;

  const flush = () => {
    if (!cur || !cur.type) {
      cur = null;
      return;
    }
    const e = cur;
    cur = null;
    if (e.type === "BLOCK") {
      const name = e.name;
      if (name) {
        curBlock = { base: [e.bx || 0, e.by || 0], ents: [], paper: e.paper === true };
        blocks.set(name, curBlock);
      }
      return;
    }
    if (e.type === "ENDBLK") {
      curBlock = null;
      return;
    }
    const t = e.type;
    if (t === "TEXT" || t === "MTEXT" || t === "ATTRIB" || t === "ATTDEF") {
      /* MTEXT 必须走 shx-text.js 的**同一份**内联码清理（`mtextToPlainText`）：
       * 曾经的 `cleanText(raw, true)` 只删「`\X…;` 带分号」的码，`\o`（上划线）/
       * `\l`（下划线）这类**无参数开关码**会原样留下来，于是标题被画成
       * `\o\l数据机房通道…`，而且多出的 4 个字符把自然宽度从 6462.99 撑到 7325.53，
       * 触发 MTEXT 折行 —— 用户看到的"内联码泄漏"和"标题折成两行"是同一个根因。
       * `\P` → 换行、`\U+XXXX`、`%%C/D/P` 的语义全由 mtextToPlainText 负责。 */
      e.textVal = t === "MTEXT" ? mtextToPlainText(e.text || "") : cleanText(e.text || "");
      if (t === "MTEXT") mtextCount++; // 统计：块内 MTEXT 条数（走纯文本抽取的那批）
      if (t === "ATTDEF") e.invisible = !!(e.flags & 1);
      if (curBlock) curBlock.ents.push(e);
      else if (inEntities) tops.push(e);
      return;
    }
    if (t === "INSERT") {
      if (curBlock) curBlock.ents.push(e);
      else if (inEntities) tops.push(e);
    }
  };

  let inEntities = false;
  for (const [code, vb] of pairs(buf, 0, n)) {
    if (code === "2" && pendingType === "SECTION") {
      const sec = vb.toString("latin1").trim();
      inEntities = sec === "ENTITIES";
      pendingType = null;
      continue;
    }
    if (code === "0") {
      const v = vb.toString("latin1").trim();
      flush();
      if (v === "SECTION") {
        pendingType = "SECTION";
        continue;
      }
      if (v === "ENDSEC") {
        inEntities = false;
        continue;
      }
      if (v === "EOF") break;
      cur = { type: v };
      continue;
    }
    if (!cur) continue;

    const s = () => dec(vb).trim();
    const num = () => Number(dec(vb));

    /* 组码 67=1 = 图纸空间实体。v34 起带出去：`space=model` 要按它剔除图纸空间文字，
     * 否则 flattenTexts 读原始文件时会把纸张坐标的 TEXT 注入到模型场景里。 */
    if (code === "67") {
      cur.paper = dec(vb).trim() === "1";
      continue;
    }

    switch (cur.type) {
      case "BLOCK":
        switch (code) {
          case "2":
            cur.name = s();
            break;
          case "3":
            if (!cur.name) cur.name = s();
            break;
          case "10":
            cur.bx = num();
            break;
          case "20":
            cur.by = num();
            break;
          default:
            break;
        }
        break;

      case "INSERT":
        switch (code) {
          case "5":
            cur.handle = s();
            break;
          case "330":
            cur.owner = s();
            break;
          case "2":
            cur.name = s();
            break;
          case "10":
            cur.x = num();
            break;
          case "20":
            cur.y = num();
            break;
          case "41":
            cur.sx = num();
            break;
          case "42":
            cur.sy = num();
            break;
          case "43":
            cur.sz = num();
            break;
          case "50":
            cur.rot = num();
            break;
          default:
            break;
        }
        break;

      case "TEXT":
      case "ATTRIB":
      case "ATTDEF":
        switch (code) {
          case "5":
            cur.handle = s();
            break;
          case "330":
            cur.owner = s();
            break;
          case "1":
            cur.text = dec(vb);
            break;
          case "2":
            cur.tag = s();
            break;
          case "7":
            cur.style = s();
            break;
          case "8":
            cur.layer = s();
            break;
          case "62":
            cur.aci = num();
            break;
          case "10":
            cur.x = num();
            break;
          case "20":
            cur.y = num();
            break;
          case "11":
            cur.ax = num();
            break;
          case "21":
            cur.ay = num();
            break;
          case "40":
            cur.h = num();
            break;
          case "41":
            cur.wf = num() || 1;
            break;
          case "50":
            cur.rot = num();
            break;
          case "70":
            cur.flags = num();
            if (cur.type === "ATTRIB") cur.invisible = !!(cur.flags & 1);
            break;
          case "72":
            cur.halign = num();
            break;
          case "73":
            cur.valign = num();
            break;
          default:
            break;
        }
        break;

      case "MTEXT":
        switch (code) {
          case "5":
            cur.handle = s();
            break;
          case "330":
            cur.owner = s();
            break;
          case "1":
            cur.text = (cur.text || "") + dec(vb);
            break;
          case "3":
            cur.text = (cur.text || "") + dec(vb);
            break;
          case "7":
            cur.style = s();
            break;
          case "8":
            cur.layer = s();
            break;
          case "62":
            cur.aci = num();
            break;
          case "10":
            cur.x = num();
            break;
          case "20":
            cur.y = num();
            break;
          case "40":
            cur.h = num();
            break;
          case "41":
            cur.width = num();
            break;
          case "50":
            cur.rot = num();
            break;
          case "71":
            cur.attach = num() || 1;
            break;
          default:
            break;
        }
        break;

      default:
        break;
    }
  }
  flush();

  void iBlocks;
  void iEnts;
  void iEnd;
  return { blocks, tops, mtextCount };
}

/* ───────────────────────── 展开 ───────────────────────── */

/** MTEXT 附着点 → TEXT 的 72/73 */
function attachToAlign(a) {
  const n = a || 1;
  const halign = (n - 1) % 3; // 0 left, 1 center, 2 right
  const valign = n <= 3 ? 3 : n <= 6 ? 2 : 1; // 3 top, 2 middle, 1 bottom
  return { halign, valign };
}

/**
 * 把一张 DXF 里的所有文字（含块内、含属性）展平成世界坐标的 TEXT 列表。
 * @param {string} dxfPath
 * @param {{includeInvisibleAttrib?: boolean}} [opts]
 */
export function flattenTexts(dxfPath, opts = {}) {
  let buf;
  try {
    buf = fs.readFileSync(dxfPath);
  } catch {
    return { items: [], stats: { blocks: 0, inserts: 0, tops: 0, fromBlocks: 0, mtext: 0 } };
  }

  const { blocks, tops, mtextCount } = parseDrawing(buf);
  const out = [];
  /* 样式名里的 `\U+XXXX` 只有单线体模式需要解码（auto 模式保持旧行为，见 dxf-web.js）。 */
  const decodeStyle = opts.decodeStyle !== false;

  /* 块内 ATTDEF 模板标志表：blockName → (tag → 组码 70)。
   * 用来判定一条不可见 ATTRIB 到底是"用户真的隐藏"还是"cadcraft 导出时复制的模板标志"。 */
  const attdefFlags = new Map();
  for (const [name, b] of blocks) {
    let m = null;
    for (const e of b.ents) {
      if (e.type === "ATTDEF" && e.tag) {
        if (!m) m = new Map();
        m.set(e.tag, e.flags ?? 0);
      }
    }
    if (m) attdefFlags.set(name, m);
  }

  let invisibleAttrib = 0; // 带 bit0（不可见）的 ATTRIB 条数
  let rescuedAttrib = 0; // 其中"标志与模板一致"被救回的条数
  let nonUniformTexts = 0; // 处在非均匀缩放块里的文字（字高只能取平均，天然有歧义）
  let mirroredTexts = 0; // 处在镜像块（det < 0）里的文字
  const warnings = []; // 诊断信息（上限 20 条，避免超大图刷屏）

  const warn = (msg) => {
    if (warnings.length < 20) warnings.push(msg);
  };

  const emit = (e, m, hScale = null, blockName = null, owner = null, ownerMatrix = null, owners = null) => {
    /* 不可见 ATTRIB 的取舍 —— 2026-10-18 实测：cadcraft 从 DWG 导出时会把块内 ATTDEF 的
     * 组码 70 原样复制到 ATTRIB 上（实测本图 1885 条不可见，bit0 全部来自模板），并非用户
     * 主动把属性设成不可见。判据：**该 ATTRIB 的 70 与所属块内同 tag 的 ATTDEF 的 70 完全一致**
     * → 判为导出产物，清掉 bit0 保留这条文字；不一致（或找不到模板）→ 尊重用户的不可见设置丢弃。
     * includeInvisibleAttrib=true 时无条件保留全部（显式覆盖）。 */
    if (e.type === "ATTRIB" && e.invisible) {
      invisibleAttrib++;
      let keep = opts.includeInvisibleAttrib === true;
      if (!keep) {
        const tplMap = blockName ? attdefFlags.get(blockName) : null;
        const tpl = tplMap ? tplMap.get(e.tag) : undefined;
        keep = tpl !== undefined && tpl === (e.flags ?? 0);
        if (keep) rescuedAttrib++;
      }
      if (!keep) return;
    }

    const [x, y] = applyM(m, e.x, e.y);
    const sc = scaleOf(m);
    const s = hScale ?? sc.s;
    const h = e.h > 0 ? e.h * s : 0;
    if (!h || !e.textVal) return;
    const mirrored = detOf(m) < 0;
    if (!sc.uniform) {
      nonUniformTexts++;
      warn(
        `块 ${blockName ?? "?"} 内文字 "${String(e.textVal).slice(0, 24)}" 处在非均匀缩放` +
          ` (|sx|=${sc.sx.toFixed(4)}, |sy|=${sc.sy.toFixed(4)})，字高取平均 ${sc.s.toFixed(4)}`
      );
    }
    if (mirrored) mirroredTexts++;
    let { halign, valign } = e;
    if (e.type === "MTEXT") {
      const a = attachToAlign(e.attach);
      halign = a.halign;
      valign = a.valign;
    }
    const [ax, ay] = e.ax != null ? applyM(m, e.ax, e.ay) : [null, null];
    const isMtext = e.type === "MTEXT";
    out.push({
      x,
      y,
      ax,
      ay,
      h,
      /* 原样（未变换）的候选 —— cadcraft 导出的块里，"块内坐标"与"已烘焙世界坐标"
       * 两种形态混着出现，单靠块级判据分不开，只能把两个候选都吐出来让上层按
       * 「位置是否落在图纸范围内 / 字高是否合理」二选一。 */
      raw: { x: e.x, y: e.y, ax: e.ax, ay: e.ay, h: e.h, rot: e.rot || 0 },
      /* 块内文字跟整块一起变换：世界角 = 文字自身角 + 累计矩阵的旋转角，
       * 同为 DXF 组码 50 的 CCW 正角口径（**不能取反**，也不能忽略块旋转）。
       * 实测（cadcraft 版 Drawing1-4「假机柜」）：块内 rot=90、INSERT rot=90，
       * 世界角 180°，落在机柜格子里呈倒置 —— 与基准图逐像素一致。 */
      rot: (e.rot || 0) + (rotOf(m) * 180) / Math.PI,
      /* det < 0（负缩放/镜像）：本地字形要沿 x 轴再翻一次 (x,y)→(x,-y)，
       * 与上面的 rot 合成后正好等于完整的 INSERT 矩阵（见 shx-text.js renderShxText）。
       * 这样镜像块里的字是"真镜像"，而不是只把位置搬过去、字形还正着。 */
      mirror: mirrored,
      wf: e.wf || 1,
      halign,
      valign,
      /* MTEXT 的组码 41 是**折行宽度**（不是宽度因子），必须带出去：
       * AutoCAD 按它折行（225 字高 / 248 宽 → 一字一行，看起来是竖排），
       * 丢掉就会画成一条横线。TEXT 没有这个语义，恒为 0。 */
      mtext: isMtext,
      wrapWidth: isMtext && e.width > 0 ? e.width : 0,
      attach: isMtext ? e.attach || 1 : undefined,
      text: e.textVal,
      layer: e.layer ? decodeEscapes(e.layer) : "0",
      aci: e.aci || 7,
      /* 组码 7 同样是 `\U+XXXX` 转义的样式名（实测 文本/宋体/…），不解码就查不到
       * createShxContext 里的样式 → 整条文字退回填充字体（af7f 的 1779 条就是这么漏的）。 */
      style: e.style ? (decodeStyle ? decodeEscapes(e.style) : e.style) : "STANDARD",
      /* 归属图块名（null = 顶层）：聚焦 block:<名> 时用来判断这条注入文字是否属于聚焦块 */
      block: blockName ?? null,
      /* 顶层 INSERT 句柄：这条文字是从哪个顶层块实例展开的。服务器用它把
       * `SPATIAL_FILTER` 的裁剪多边形套到块内展平文字上（否则文字被注入到
       * ENTITIES 顶层，已经不在块里，引擎的 XCLIP 裁不到）。 */
      owner: owner ?? null,
      /* 顶层 INSERT 的块坐标→WCS 矩阵 {a,b,c,d,e,f}；owner 对应的裁剪多边形
       * 是块定义坐标，必须先乘它才能和上面的 x/y（WCS）比较。 */
      ownerMatrix: ownerMatrix ? { ...ownerMatrix } : null,
      /* 完整 INSERT 链（最外层→最内层）。嵌套 INSERT 也可能带 XCLIP，文字必须逐层
       * 用每层的 p_block 多边形求交，不能只看最外层。 */
      owners: owners && owners.length
        ? owners.map((o) => ({ handle: o.handle ?? null, matrix: o.matrix ? { ...o.matrix } : null }))
        : null,
      /* ATTRIB 本身不参与 XCLIP；但它是 flattenTexts 注入的副本，输出里的原始 ATTRIB
       * 已被 collectAttribLines 删除，因此副本仍按所属 INSERT 链过滤。 */
      attrib: e.type === "ATTRIB",
      /* 图纸空间来源（67=1 的顶层实体，或图纸空间块里的文字）：space=model 时整条丢弃 */
      paper: e.paper === true || (blockName ? blocks.get(blockName)?.paper === true : false),
    });
  };

  let inserts = 0;
  let fromBlocks = 0;

  /* 递归展开：块内实体按 M 变换；嵌套 INSERT 继续乘。
   * owners 是完整 INSERT 链（每层带 block→WCS 矩阵），最外层用于普通 XCLIP，
   * 内层用于嵌套 XCLIP 的交集。展平后的 x/y 是世界坐标。 */
  const expandBlock = (name, m, depth, owners = []) => {
    if (depth > 12) return; // 防循环引用
    const b = blocks.get(name);
    if (!b) return;
    for (const e of b.ents) {
      if (e.type === "INSERT") {
        inserts++;
        const child = blocks.get(e.name);
        const childBase = child ? child.base : [0, 0];
        const childM = mul(m, insertMatrix(e, childBase));
        expandBlock(e.name, childM, depth + 1, [
          ...owners,
          { handle: e.handle ?? null, matrix: childM },
        ]);
      } else if (e.type === "ATTDEF") {
        /* 块定义里的属性模板不画：值由 ATTRIB 提供 */
        continue;
      } else {
        if (out.length >= MAX_OUT) return;
        const top = owners[0] || null;
        emit(e, m, null, name, top?.handle ?? null, top?.matrix ?? null, owners);
        fromBlocks++;
      }
    }
  };

  /* 顶层 INSERT 的缩放：顶层 ATTRIB 的坐标已经是世界坐标（实测 attr.pos ≈ ins.pos），
   * 只有**字高**还要不要再乘这个缩放，取决于 ATTRIB 里的 h 是哪种形态（见下面）。 */
  const topScale = new Map();
  const topBlock = new Map(); // INSERT 句柄 → 块名（顶层 ATTRIB 归属到它所属的 INSERT）
  /* 顶层 INSERT 的块坐标→WCS 矩阵：顶层 ATTRIB 的 x/y 已是 WCS，但它的所属 INSERT
   * 如果带 XCLIP，服务器仍需用这个矩阵把 p_block 换到 WCS 后才能比较。 */
  const topMatrix = new Map();
  for (const e of tops) {
    if (e.type === "INSERT" && e.handle) {
      topScale.set(e.handle, Math.abs(e.sx ?? 1) || 1);
      topBlock.set(e.handle, e.name ?? null);
      const b = blocks.get(e.name);
      if (b) topMatrix.set(e.handle, insertMatrix(e, b.base));
    }
  }

  /* 块内 ATTDEF 模板字高：块名 → (tag → 字高)。
   * 用来判断同名 ATTRIB 的 h 是「块内值」还是「已经烘焙成世界值」——两种图都真实存在。 */
  const attdefHeights = new Map();
  for (const [bname, b] of blocks) {
    const m = new Map();
    for (const e of b.ents) {
      if (e.type === "ATTDEF" && e.tag && Number.isFinite(e.h) && e.h > 0) m.set(e.tag, e.h);
    }
    if (m.size) attdefHeights.set(bname, m);
  }

  for (const e of tops) {
    if (e.type === "INSERT") {
      inserts++;
      const b = blocks.get(e.name);
      if (!b) continue;
      const m = insertMatrix(e, b.base);
      expandBlock(e.name, m, 0, [{ handle: e.handle ?? null, matrix: m }]);
    } else if (e.type === "ATTRIB") {
      if (out.length >= MAX_OUT) break;
      const s = topScale.get(e.owner) ?? 1;
      const blk = topBlock.get(e.owner) ?? null;
      /* 位置不动（已是世界坐标）。**字高必须逐个判**，因为两种形态都真实存在：
       *   · 块内值      → 要 ×s（dxf-viewer 漏掉的就是这一步）
       *   · 已烘焙的世界值 → 再乘就放大 s 倍
       * 判据：以块里同 tag 的 ATTDEF 字高为基准，期望世界字高 = attdefH × s，
       *       取 raw 与 raw×s 中更接近期望的那个。
       * 实测（实用旋转楼梯全套图）：ATTRIB h=187 已经 = ATTDEF 5.5 × 34，
       *       再乘 34 → 6358，文字糊成一片盖住整张图。 */
      let hScale = s;
      const tmpl = blk ? (attdefHeights.get(blk) || new Map()).get(e.tag) : undefined;
      if (Number.isFinite(tmpl) && tmpl > 0) {
        const expected = tmpl * s;
        hScale = Math.abs(e.h - expected) <= Math.abs(e.h * s - expected) ? 1 : s;
      } else {
        /* v50：**块里没有同 tag 的 ATTDEF 时，h 必须原样使用。**
         *
         * DXF 规范里 ATTRIB 是 ENTITIES 段的独立实体，组码 10/20（位置）与 40（字高）
         * 都已经是 WCS 值（AutoCAD 在 INSERT 时把块内 ATTDEF 按插入缩放烘焙好了）。
         * 以前这里没模板就无条件 `hScale = s`（`let hScale = s` 的旧默认），把已烘焙的
         * 世界字高又乘了一次插入缩放。
         *
         * 实测 `机柜图纸.dxf`（887ab95e7a53）：`$WINLIB2D$` / `$DorLib2D$` 门窗库块
         * 只有 6 条 LWPOLYLINE、**没有任何 ATTDEF**，但 INSERT 带 66=1 和 ATTRIB；
         * ATTRIB 的 40 已是世界值 297.5，所属 INSERT 的 41 却是 800…6800 →
         * 展平成 535,500…2,023,000 高（正是用户看到的"巨大空心字形"）。
         * 同图 182 条顶层 ATTRIB 里 126 条属于这种无模板块；换成 DWG 走
         * converted.dxf 时同一批字高被 filterFlatTexts 按 contentBox 救回，所以
         * 只有 DXF 直开才炸 —— 两处入口表现不一致就是这个缺口造成的。
         *
         * 有 ATTDEF 模板时仍保留上面的二选一（历史图里确实存在"h 还是块内值"的写法，
         * 如 `实用旋转楼梯全套图` 的 ATTDEF 5.5 × 34；该判据命中时行为不变）。 */
        hScale = 1;
      }
      const ownerMatrix = topMatrix.get(e.owner) ?? null;
      emit(e, IDENT, hScale, blk, e.owner ?? null, ownerMatrix,
           e.owner != null ? [{ handle: e.owner, matrix: ownerMatrix }] : []);
    }
    /* 顶层 TEXT / MTEXT 不在这里出：dxf-viewer 本来就能正确渲染它们，
     * 再注入一份就是重影。本模块只负责"引擎画不出来的那部分"。 */
  }

  return {
    items: out,
    stats: {
      blocks: blocks.size,
      inserts,
      tops: tops.length,
      fromBlocks,
      total: out.length,
      /* v30：解析阶段走 `mtextToPlainText()` 的 MTEXT 条数（块内 + 顶层）。用来在
       * 构建统计里确认"块内 MTEXT 的内联码没有任何一条绕过共享清理器"。 */
      mtext: mtextCount,
      invisibleAttrib,
      rescuedAttrib,
      nonUniformTexts,
      mirroredTexts,
      warnings,
      capped: out.length >= MAX_OUT,
    },
  };
}
