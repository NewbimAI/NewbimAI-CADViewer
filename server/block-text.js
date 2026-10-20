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
 */
import fs from "node:fs";

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

/** 均匀缩放因子（面积开方；非均匀缩放时取几何平均，够用） */
const scaleOf = (m) => Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;

/** 矩阵里的旋转角（弧度） */
const rotOf = (m) => Math.atan2(m.b, m.a);

/** INSERT 的变换矩阵：先平移到块基点、缩放、旋转，再移到插入点 */
function insertMatrix(ins, blockBase) {
  const r = ((ins.rotation || 0) * Math.PI) / 180;
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

/** MTEXT 里的 `\U+XXXX` 与格式码清理（保留可见字符） */
function cleanText(raw) {
  let t = raw.replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
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
  };
}

/**
 * 解析整张图：块定义表 + 顶层实体表。
 * @returns {{blocks: Map<string,{base:[number,number], ents:object[]}>, tops: object[]}}
 */
function parseDrawing(buf) {
  const blocks = new Map();
  const tops = [];
  const n = buf.length;

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
        curBlock = { base: [e.bx || 0, e.by || 0], ents: [] };
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
      e.textVal = cleanText(e.text || "");
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
  return { blocks, tops };
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
    return { items: [], stats: { blocks: 0, inserts: 0, tops: 0, fromBlocks: 0 } };
  }

  const { blocks, tops } = parseDrawing(buf);
  const out = [];

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

  const emit = (e, m, hScale = null, blockName = null) => {
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
    const s = hScale ?? scaleOf(m);
    const h = e.h > 0 ? e.h * s : 0;
    if (!h || !e.textVal) return;
    let { halign, valign } = e;
    if (e.type === "MTEXT") {
      const a = attachToAlign(e.attach);
      halign = a.halign;
      valign = a.valign;
    }
    const [ax, ay] = e.ax != null ? applyM(m, e.ax, e.ay) : [null, null];
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
      rot: (e.rot || 0) + (rotOf(m) * 180) / Math.PI,
      wf: e.wf || 1,
      halign,
      valign,
      text: e.textVal,
      layer: e.layer ? e.layer.replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) : "0",
      aci: e.aci || 7,
      style: e.style || "STANDARD",
      /* 归属图块名（null = 顶层）：聚焦 block:<名> 时用来判断这条注入文字是否属于聚焦块 */
      block: blockName ?? null,
    });
  };

  let inserts = 0;
  let fromBlocks = 0;

  /* 递归展开：块内实体按 M 变换；嵌套 INSERT 继续乘 */
  const expandBlock = (name, m, depth) => {
    if (depth > 12) return; // 防循环引用
    const b = blocks.get(name);
    if (!b) return;
    for (const e of b.ents) {
      if (e.type === "INSERT") {
        inserts++;
        const child = blocks.get(e.name);
        const childBase = child ? child.base : [0, 0];
        expandBlock(e.name, mul(m, insertMatrix(e, childBase)), depth + 1);
      } else if (e.type === "ATTDEF") {
        /* 块定义里的属性模板不画：值由 ATTRIB 提供 */
        continue;
      } else {
        if (out.length >= MAX_OUT) return;
        emit(e, m, null, name);
        fromBlocks++;
      }
    }
  };

  /* 顶层 INSERT 的缩放：顶层 ATTRIB 的坐标已经是世界坐标（实测 attr.pos ≈ ins.pos），
   * 只有**字高**还是块内值，必须乘这个缩放 —— 这正是 dxf-viewer 漏掉的那一步。 */
  const topScale = new Map();
  const topBlock = new Map(); // INSERT 句柄 → 块名（顶层 ATTRIB 归属到它所属的 INSERT）
  for (const e of tops) {
    if (e.type === "INSERT" && e.handle) {
      topScale.set(e.handle, Math.abs(e.sx ?? 1) || 1);
      topBlock.set(e.handle, e.name ?? null);
    }
  }

  for (const e of tops) {
    if (e.type === "INSERT") {
      inserts++;
      const b = blocks.get(e.name);
      if (!b) continue;
      expandBlock(e.name, insertMatrix(e, b.base), 0);
    } else if (e.type === "ATTRIB") {
      if (out.length >= MAX_OUT) break;
      const s = topScale.get(e.owner) ?? 1;
      /* 位置不动（已是世界坐标），字高乘插入缩放 */
      emit(e, IDENT, s, topBlock.get(e.owner) ?? null);
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
      invisibleAttrib,
      rescuedAttrib,
      capped: out.length >= MAX_OUT,
    },
  };
}
