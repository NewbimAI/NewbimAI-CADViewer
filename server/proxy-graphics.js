/**
 * 自定义实体（IAEC_* / IWT_* 等）的 `310`「代理图形」解码。
 *
 * ## 为什么需要它（2026-11-09 实测，勿删）
 * 机柜图 `acad-cab.dxf`、施工图 `acad-s005.dxf` 里的墙/文字/门窗/箭头不是标准
 * DXF 实体，而是第三方建筑插件（类名 `IcDb*`，IntelliCAD 系）的自定义对象。
 * 导出 DXF 时几何被写进 `310` 组码，dxf-viewer 的 `_ProcessDxfEntity` 不认识
 * 这些类型，直接 `Unhandled entity type` 丢弃 → 浏览器里墙和房间文字整片消失。
 *
 * ## 310 数据的实际结构（逐字节验证）
 * 小端（x86）字节序，整体是一串**自描述长度**的记录：
 *
 *   u32 totalSize            // 必须等于 310 拼接后的字节数
 *   u32 objectCount          // 子实体数（仅作参考，不参与解码）
 *   record[]                 // 从 offset 8 开始，直到 totalSize
 *
 *   record:
 *     u32 size               // 本记录总字节数（含这 4 字节）；可能不是 4 的倍数
 *     u32 kind               // 记录类型，见下表
 *     ...payload...
 *
 * kind 一览（括号内为本项目实测到的用法）：
 *   2  (7 doubles)   圆：cx,cy,cz, r, nx,ny,nz
 *   4  (11 doubles)  圆弧：cx,cy,cz, r, 0,0, 1, ux,uy,0, sweep
 *                    (ux,uy) 是弧起点的单位方向，sweep 是逆时针扫过的弧度
 *   6  (count+pts)   折线：u32 n, n × (x,y,z) double
 *   9  (mesh)        三角网格：u32 n, n × (x,y,z), 面表（见下）
 *   19 (2 u32)       子实体开始（重置当前变换）
 *   29 (16 doubles)  4×4 行主序变换矩阵（平移在 m[3]/m[7]/m[11]）
 *   31 (无 payload)  实体结束（重置变换）
 *   32 (count+pts)   折线（带法向）：u32 n, n × (x,y,z), (nx,ny,nz)
 *   33 (len+bytes)   未解的二进制块（窗框符号；见下）
 *   38 (text)        文字：x,y,z, nx,ny,nz, ux,uy,uz, UTF-16LE 字符串 + NUL,
 *                    对齐到 4 字节后：u32 字符数, u32 0,
 *                    8 × double: 字高, 宽度因子, 旋转(rad), ?, ?, ?, ?, ?
 *                    尾部是字体名（UTF-16LE、NUL 分隔；实测 SIMPLEX/GBCBIG、
 *                    tssdeng.shx/HZTXT.shx、LiSu/SIMLI.TTF）
 *   其它             (14/16/18/20/23/26 等) 绘制状态（图层/颜色/线宽），忽略
 *
 * 9 的面表：`u32 nWords`，随后 nWords 个 u32，每 4 个一组：
 *   [3, i0, i1, i2] 表示一个三角形。组数 = nWords/4。
 *   例如矩形墙 4 个顶点 → [3,0,1,2, 3,2,1,3] 两个三角形。
 *
 * 变换：kind 29 之后、直到同子实体的 kind 31 或下一个 kind 19 之前，
 * 所有坐标都先乘矩阵再加平移。块内实体保持块坐标系（不摊平）。
 *
 * ## 文字为什么直接出笔画（v46，2026-11-09）
 * `IAEC_TEXT` 解出来的文字原本写成 TEXT，交给 dxf-viewer 用 TTF（Noto）画填充字形；
 * 而同一张图里其它 SHX 文字是 `server/shx-text.js` 渲染的单线笔画，两种字形/字重并存。
 * 这里改为**在解码阶段就用 `renderShxText` 出笔画**（LWPOLYLINE），原因是：
 *   · `acad-cab.dxf` 的 250 条 `IAEC_TEXT` 全部位于 **BLOCKS 段的块定义**
 *     （`0727-3FF ditu`），`convertShxTexts()` 只转换顶层 ENTITIES 与标注块，
 *     所以「写 SHX 样式让后面自动转」的路线覆盖不到它们；
 *   · 笔画留在块坐标系里，块插入的缩放/旋转照常生效，handle/图层/颜色沿用原实体。
 * 字体优先用 kind38 尾部记录的字体名（SIMPLEX/GBCBIG、tssdeng/HZTXT…）；
 * 记录缺失或字体不是 SHX 时退回图纸里第一个可用的单线字体对。
 * 解不出字形（`renderShxText` 返回 null 或 missing > 0）时**保留原 TEXT**，
 * 宁可回退成 TTF，也不能让字消失。`shxCtx` 由 `dxf-web.js` 传入；没传时行为与旧版一致。
 *
 * ## 没能解出来的
 * kind 33（窗框符号，26 字节二进制块）目前未解 —— 它是按位压缩的私有格式，
 * 未找到可靠规范。对「只有 kind 33 的 IAEC_OPENING（窗）」用变换矩阵里的
 * x/y 缩放（= 窗宽/墙厚）补一个单位矩形，作为可见的近似；其余实体忽略该块。
 * 统计里 `kind33` / `approximated` 会如实计数，绝不静默丢失。
 */

import { renderShxText } from "./shx-text.js";

/** 记录类型。仅用于可读性，数值来自实测。 */
export const PROXY_KIND = Object.freeze({
  CIRCLE: 2,
  ARC: 4,
  POLYLINE: 6,
  MESH: 9,
  BEGIN: 19,
  MATRIX: 29,
  END: 31,
  POLYLINE_NORMAL: 32,
  BLOB: 33,
  TEXT: 38,
});

/** dxf-viewer 自己能处理的实体：一律不碰（哪怕带 310）。 */
const STANDARD_TYPES = new Set([
  "LINE",
  "LWPOLYLINE",
  "POLYLINE",
  "VERTEX",
  "SEQEND",
  "CIRCLE",
  "ARC",
  "ELLIPSE",
  "SPLINE",
  "TEXT",
  "MTEXT",
  "INSERT",
  "ATTRIB",
  "ATTDEF",
  "SOLID",
  "TRACE",
  "3DFACE",
  "POINT",
  "HATCH",
  "DIMENSION",
  "LEADER",
  "MULTILEADER",
  "MLINE",
  "VIEWPORT",
  "IMAGE",
  "WIPEOUT",
  "ACAD_TABLE",
  "RAY",
  "XLINE",
  "BODY",
  "REGION",
  "SURFACE",
]);

const isFinitePoint = (p) =>
  Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);

/**
 * kind38 尾部的字体名。字符串是 UTF-16LE、NUL 分隔，前后有少量对齐/标志字节，
 * 所以不按固定偏移取，而是扫描可打印 ASCII 串（长度 ≥ 2）拿前两个：
 * `[主字体, 大字体]`。取不到返回 []。
 */
function readProxyFontNames(buf, start, end) {
  const names = [];
  let cur = "";
  const flush = () => {
    if (cur.length >= 2) names.push(cur);
    cur = "";
  };
  for (let i = start; i + 1 < end && names.length < 2; i += 2) {
    const ch = buf.readUInt16LE(i);
    if (ch >= 0x20 && ch <= 0x7e) cur += String.fromCharCode(ch);
    else flush();
  }
  if (names.length < 2) flush();
  return names.slice(0, 2);
}

/**
 * 解码一条实体的 310 代理图形。
 * @param {string} hex 连续的十六进制串（多个 310 值已拼接）
 * @returns {{primitives:Array, stats:object, matrix:number[]|null}|null}
 *          格式不符/损坏时返回 null
 */
export function decodeProxyGraphics(hex) {
  let buf;
  try {
    buf = Buffer.from(hex, "hex");
  } catch {
    return null;
  }
  if (buf.length < 8) return null;
  const total = buf.readUInt32LE(0);
  if (total !== buf.length) return null;

  const primitives = [];
  const stats = {
    records: 0,
    kind33: 0,
    unknown: 0,
    matrices: 0,
    texts: 0,
    textsStroked: 0,
    textsKept: 0,
    strokePolylines: 0,
    polylines: 0,
    triangles: 0,
    circles: 0,
    arcs: 0,
  };

  let pos = 8;
  /** 当前 4×4 变换（行主序）；null = 单位矩阵 */
  let matrix = null;
  /** 最后一个非单位变换（给 kind33 近似用） */
  let lastMatrix = null;

  const apply = (x, y) => {
    if (!matrix) return [x, y];
    return [
      matrix[0] * x + matrix[1] * y + matrix[3],
      matrix[4] * x + matrix[5] * y + matrix[7],
    ];
  };

  const readPoint = (at) => {
    const x = buf.readDoubleLE(at);
    const y = buf.readDoubleLE(at + 8);
    return apply(x, y);
  };

  while (pos + 8 <= total) {
    const size = buf.readUInt32LE(pos);
    const kind = buf.readUInt32LE(pos + 4);
    if (size < 8 || pos + size > total) return null;
    const end = pos + size;
    stats.records++;

    switch (kind) {
      case PROXY_KIND.BEGIN:
      case PROXY_KIND.END:
        matrix = null;
        break;

      case PROXY_KIND.MATRIX: {
        if (size < 8 + 128) return null;
        const m = new Array(16);
        for (let k = 0; k < 16; k++) m[k] = buf.readDoubleLE(pos + 8 + k * 8);
        if (!m.every(Number.isFinite)) return null;
        matrix = m;
        lastMatrix = m;
        stats.matrices++;
        break;
      }

      case PROXY_KIND.POLYLINE:
      case PROXY_KIND.POLYLINE_NORMAL: {
        const n = buf.readUInt32LE(pos + 8);
        if (n < 2 || n > 1_000_000 || pos + 12 + n * 24 > end) return null;
        const points = [];
        for (let k = 0; k < n; k++) points.push(readPoint(pos + 12 + k * 24));
        if (!points.every(isFinitePoint)) return null;
        primitives.push({ type: "polyline", points, closed: false });
        stats.polylines++;
        break;
      }

      case PROXY_KIND.MESH: {
        const n = buf.readUInt32LE(pos + 8);
        if (n < 3 || n > 1_000_000 || pos + 12 + n * 24 > end) return null;
        const points = [];
        for (let k = 0; k < n; k++) points.push(readPoint(pos + 12 + k * 24));
        if (!points.every(isFinitePoint)) return null;

        const tail = pos + 12 + n * 24;
        let faces = 0;
        if (tail + 4 <= end) {
          const nWords = buf.readUInt32LE(tail);
          if (nWords >= 4 && nWords % 4 === 0 && tail + 4 + nWords * 4 <= end) {
            for (let k = 0; k < nWords; k += 4) {
              if (buf.readUInt32LE(tail + 4 + k * 4) !== 3) break;
              const a = buf.readUInt32LE(tail + 8 + k * 4);
              const b = buf.readUInt32LE(tail + 12 + k * 4);
              const c = buf.readUInt32LE(tail + 16 + k * 4);
              if (a >= n || b >= n || c >= n) break;
              primitives.push({ type: "triangle", points: [points[a], points[b], points[c]] });
              faces++;
            }
          }
        }
        if (!faces) {
          primitives.push({ type: "polyline", points, closed: true });
          stats.polylines++;
        } else {
          stats.triangles += faces;
        }
        break;
      }

      case PROXY_KIND.CIRCLE: {
        if (size < 8 + 56) return null;
        const cx = buf.readDoubleLE(pos + 8);
        const cy = buf.readDoubleLE(pos + 16);
        const r = buf.readDoubleLE(pos + 32);
        if (!Number.isFinite(cx) || !Number.isFinite(cy) || !(r > 0) || r > 1e12) break;
        const points = [];
        for (let k = 0; k < 32; k++) {
          const a = (k / 32) * Math.PI * 2;
          points.push(apply(cx + Math.cos(a) * r, cy + Math.sin(a) * r));
        }
        primitives.push({ type: "polyline", points, closed: true });
        stats.circles++;
        break;
      }

      case PROXY_KIND.ARC: {
        if (size < 8 + 88) return null;
        const cx = buf.readDoubleLE(pos + 8);
        const cy = buf.readDoubleLE(pos + 16);
        const r = buf.readDoubleLE(pos + 32);
        const ux = buf.readDoubleLE(pos + 64);
        const uy = buf.readDoubleLE(pos + 72);
        const sweep = buf.readDoubleLE(pos + 88);
        if (!Number.isFinite(cx) || !Number.isFinite(cy) || !(r > 0)) break;
        if (!Number.isFinite(ux) || !Number.isFinite(uy) || !Number.isFinite(sweep)) break;
        if (sweep === 0 || Math.abs(sweep) > Math.PI * 2 + 1e-6) break;
        const a0 = Math.atan2(uy, ux);
        const steps = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 18)));
        const points = [];
        for (let k = 0; k <= steps; k++) {
          const a = a0 + (sweep * k) / steps;
          points.push(apply(cx + Math.cos(a) * r, cy + Math.sin(a) * r));
        }
        primitives.push({ type: "polyline", points, closed: false });
        stats.arcs++;
        break;
      }

      case PROXY_KIND.TEXT: {
        if (size < 80) return null;
        const x = buf.readDoubleLE(pos + 8);
        const y = buf.readDoubleLE(pos + 16);
        let text = "";
        let at = pos + 80;
        while (at + 1 < end) {
          const ch = buf.readUInt16LE(at);
          if (!ch) break;
          text += String.fromCharCode(ch);
          at += 2;
        }
        at += 2; // NUL
        if (at % 4) at += 4 - (at % 4);
        if (at + 8 + 64 > end) return null;
        const d = new Array(8);
        for (let k = 0; k < 8; k++) d[k] = buf.readDoubleLE(at + 8 + k * 8);
        const height = d[0];
        const widthFactor = Number.isFinite(d[1]) && d[1] > 0 ? d[1] : 1;
        const rotation = Number.isFinite(d[2]) ? d[2] : 0;
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        if (!(height > 0) || height > 1e7) break;
        const [fontName, bigFontName] = readProxyFontNames(buf, at + 72, end);
        const [px, py] = apply(x, y);
        primitives.push({
          type: "text",
          text,
          x: px,
          y: py,
          height,
          widthFactor,
          rotation,
          font: fontName || "",
          bigFont: bigFontName || "",
        });
        stats.texts++;
        break;
      }

      case PROXY_KIND.BLOB:
        stats.kind33++;
        break;

      default:
        stats.unknown++;
        break;
    }

    pos = end;
  }

  if (pos !== total) return null;
  return { primitives, stats, matrix: lastMatrix };
}

/* ─────────────────────── 实体行生成 ─────────────────────── */

const f = (v) => {
  if (!Number.isFinite(v)) return "0";
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(9).replace(/0+$/, "").replace(/\.$/, "");
};

/** 单个图元的 DXF 行（不含图层/颜色等公共组码） */
function primitiveRows(p) {
  if (p.type === "text") {
    const rows = [
      "100", "AcDbText",
      "10", f(p.x),
      "20", f(p.y),
      "30", "0.0",
      "40", f(p.height),
      "1", p.text,
    ];
    if (p.rotation) rows.push("50", f((p.rotation * 180) / Math.PI));
    if (p.widthFactor && Math.abs(p.widthFactor - 1) > 1e-9) rows.push("41", f(p.widthFactor));
    return { type: "TEXT", rows };
  }
  if (p.type === "triangle") {
    const [a, b, c] = p.points;
    return {
      type: "SOLID",
      rows: [
        "100", "AcDbTrace",
        "10", f(a[0]), "20", f(a[1]), "30", "0.0",
        "11", f(b[0]), "21", f(b[1]), "31", "0.0",
        "12", f(c[0]), "22", f(c[1]), "32", "0.0",
        "13", f(c[0]), "23", f(c[1]), "33", "0.0",
      ],
    };
  }
  // polyline
  const rows = [
    "100", "AcDbPolyline",
    "90", String(p.points.length),
    "70", p.closed ? "1" : "0",
    "43", "0.0",
  ];
  for (const [x, y] of p.points) rows.push("10", f(x), "20", f(y));
  return { type: "LWPOLYLINE", rows };
}

/* ─────────────────── 文字 → 单线笔画（与 SHX 文字同一套字形）─────────────────── */

const PROXY_STYLE_PREFIX = "@PROXY:";
const styleKey = (name) => String(name ?? "").trim().toUpperCase();
const fontStem = (name) =>
  String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/^.*[\\/]/, "")
    .replace(/\.(shx|ttf|otf|ttc)$/i, "");

/**
 * 在既有 SHX 上下文上包一层「按字体对取样式」的视图。
 *
 * 为什么不直接拿样式名用：代理文字自己的宽度因子（组码 41 的等价物）和倾斜角
 * 必须完全由 kind38 决定；而 STYLE 表里的样式可能带 `widthFactor=0.7`，直接复用会把
 * 文字压窄 30%。所以匹配到的样式都克隆一份，宽度因子固定 1、倾斜 0，只借它的字体。
 *
 * 匹配顺序（都做大小写/扩展名归一）：
 *   ① 主字体 + 大字体都一致的样式；② 主字体一致；③ 大字体一致；
 *   ④ 兜底：优先 `simplex/txt` 主字体 + 有大字体 + 宽度因子接近 1 的样式。
 * 这样 acad-cab 的 `SIMPLEX/GBCBIG` 会命中 `_TCH_WINDOW`，`tssdeng.shx/HZTXT.shx`
 * 会命中 `_TEL_DIM`，而 `LiSu/SIMLI.TTF`（TTF，无 SHX 可解析）退回默认单线体。
 */
function createStrokeView(baseCtx) {
  if (!baseCtx || !baseCtx.styles || !baseCtx.styles.size) return null;
  const styles = new Map(baseCtx.styles);
  const view = { ...baseCtx, styles };
  const all = [...styles.values()];
  const cache = new Map();

  const widthOk = (st) => {
    const wf = Number(st.widthFactor);
    return !Number.isFinite(wf) || Math.abs(wf - 1) < 1e-9;
  };
  const score = (st) => {
    let s = 0;
    if (/^(simplex|txt)$/.test(fontStem(st.primaryName || st.primary))) s += 3;
    if (st.bigFont) s += 2;
    if (widthOk(st)) s += 1;
    return s;
  };
  const pick = (primary, bigFont) => {
    const p = fontStem(primary);
    const b = fontStem(bigFont);
    if (!p && !b) return null;
    let best = null;
    let bestScore = -1;
    for (const st of all) {
      const sp = fontStem(st.primaryName || st.primary);
      const sb = fontStem(st.bigFontName || st.bigFont);
      let match = -1;
      if (p && sp === p) match = b && sb === b ? 4 : 2;
      else if (b && sb === b) match = 1;
      if (match < 0) continue;
      const total = match * 10 + score(st);
      if (total > bestScore) {
        bestScore = total;
        best = st;
      }
    }
    return best;
  };
  const fallback = () =>
    all.slice().sort((a, b) => score(b) - score(a))[0] || null;

  return {
    ctx: view,
    /** 字体对 → 克隆样式名；没有可用样式时返回 null（调用方保留 TEXT）。 */
    styleFor(primary, bigFont) {
      const key = `${fontStem(primary)}|${fontStem(bigFont)}`;
      if (cache.has(key)) return cache.get(key);
      const base = pick(primary, bigFont) || fallback();
      let name = null;
      if (base) {
        name = `${PROXY_STYLE_PREFIX}${key}`;
        const keyUpper = styleKey(name);
        if (!styles.has(keyUpper)) {
          styles.set(keyUpper, {
            ...base,
            name,
            // 宽度因子/倾斜只认 kind38 自己的值（见上）
            widthFactor: 1,
            oblique: 0,
            height: 0,
          });
        }
      }
      cache.set(key, name);
      return name;
    },
  };
}

/**
 * 一条代理文字 → 笔画折线（世界/块坐标与 TEXT 的插入点一致）。
 * @returns {[number,number][][]|null} null = 没有可用字体/有缺字形 → 保留 TEXT
 */
function textToStrokePolylines(p, view, layer, aci) {
  let style = null;
  try {
    style = view.styleFor(p.font, p.bigFont);
  } catch {
    return null;
  }
  if (!style) return null;
  try {
    const rendered = renderShxText(
      {
        text: p.text,
        x: p.x,
        y: p.y,
        h: p.height,
        // kind38 的旋转是弧度；renderShxText / DXF 组码 50 用度
        rot: (p.rotation * 180) / Math.PI,
        wf: p.widthFactor,
        layer,
        aci,
        style,
      },
      view.ctx
    );
    /* 有缺字形时整条不转：用缺字的笔画替换 TEXT 等于把字吃掉，宁可回退给 TTF。 */
    if (!rendered || !rendered.polylines.length || rendered.missing > 0) return null;
    return rendered.polylines.map((pl) => pl.points);
  } catch {
    // 字体损坏/渲染异常 → 保留原 TEXT（开图优先，绝不让整张图 500）
    return null;
  }
}

/**
 * 扫描 ENTITIES + BLOCKS 里的自定义实体（未知类型 + 带 310），把可解码的
 * 代理图形就地替换成标准实体。解不出来的一律原样保留。
 *
 * @param {string} text 已解码的 DXF 文本
 * @param {number} startHandle 新实体句柄起点（应 > 文件内最大句柄）
 * @param {{shxCtx?:object|null}} [options]
 *   `shxCtx` = `createShxContext()` 的返回值。传入后代理文字改用单线笔画
 *   （与 SHX 文字同一套字形）；不传/渲染失败时仍写成 TEXT。
 * @returns {{text:string, converted:number, primitives:number, unsupported:number,
 *            kind33:number, approximated:number, nextHandle:number, byType:object,
 *            textsStroked:number, textsKept:number, strokePolylines:number}}
 */
export function convertProxyGraphicsEntities(text, startHandle = 0x100, options = {}) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const out = [];
  const stats = {
    converted: 0,
    primitives: 0,
    unsupported: 0,
    kind33: 0,
    approximated: 0,
    unknownKinds: 0,
    nextHandle: startHandle,
    byType: {},
    textsStroked: 0,
    textsKept: 0,
    strokePolylines: 0,
  };
  const strokeView = createStrokeView(options?.shxCtx);

  let section = null;
  let pendingSection = false;

  for (let i = 0; i + 1 < lines.length; ) {
    const code = lines[i].trim();
    const value = lines[i + 1].trim();

    if (code === "0" && value === "SECTION") {
      pendingSection = true;
      out.push(lines[i], lines[i + 1]);
      i += 2;
      continue;
    }
    if (pendingSection && code === "2") {
      section = value;
      pendingSection = false;
      out.push(lines[i], lines[i + 1]);
      i += 2;
      continue;
    }
    if (code === "0" && value === "ENDSEC") {
      section = null;
      out.push(lines[i], lines[i + 1]);
      i += 2;
      continue;
    }

    const inScope = section === "ENTITIES" || section === "BLOCKS";
    if (!inScope || code !== "0") {
      out.push(lines[i], lines[i + 1]);
      i += 2;
      continue;
    }

    // 一个实体：从当前 0/type 到下一个 0 行之前
    const type = value;
    let j = i + 2;
    while (j + 1 < lines.length && lines[j].trim() !== "0") j += 2;

    if (STANDARD_TYPES.has(type) || type === "BLOCK" || type === "ENDBLK" || type === "SEQEND") {
      for (let k = i; k < j; k++) out.push(lines[k]);
      i = j;
      continue;
    }

    const fields = new Map();
    const hexes = [];
    for (let k = i + 2; k + 1 < j; k += 2) {
      const c = lines[k].trim();
      const v = lines[k + 1].trim();
      if (c === "310") {
        hexes.push(v);
        continue;
      }
      if (!fields.has(c)) fields.set(c, v);
    }

    if (!hexes.length) {
      for (let k = i; k < j; k++) out.push(lines[k]);
      i = j;
      continue;
    }

    const decoded = decodeProxyGraphics(hexes.join(""));
    if (!decoded) {
      // 宁可不动，也绝不删原实体
      stats.unsupported++;
      for (let k = i; k < j; k++) out.push(lines[k]);
      i = j;
      continue;
    }

    let prims = decoded.primitives;

    /* 窗：g70=1 的 IAEC_OPENING 几何只在未解的 kind33 里。用 29 号矩阵的
     * 缩放（x=窗宽，y=墙厚）补 [-0.5,0.5]² 的矩形。只在这种情况下启用，
     * 避免把真正无几何的 IAEC_INSERT 等画成方块。
     * 注意窗自己还会带一个 kind38 标签（C1652ab'），所以判断“没有几何图元”
     * 时要排除文字。 */
    const hasGeometry = prims.some((p) => p.type !== "text");
    if (!hasGeometry && decoded.stats.kind33 > 0 && /^IAEC_OPENING$/i.test(type)) {
      const m = decoded.matrix;
      if (m) {
        const tf = (x, y) => [m[0] * x + m[1] * y + m[3], m[4] * x + m[5] * y + m[7]];
        prims = [
          ...prims,
          {
            type: "polyline",
            closed: true,
            points: [
              tf(-0.5, -0.5),
              tf(0.5, -0.5),
              tf(0.5, 0.5),
              tf(-0.5, 0.5),
            ],
          },
        ];
        stats.approximated++;
      }
    }

    if (!prims.length) {
      // 没有可画图元：保留原实体（例如只有 kind33 的非窗对象）
      stats.unsupported++;
      stats.kind33 += decoded.stats.kind33;
      for (let k = i; k < j; k++) out.push(lines[k]);
      i = j;
      continue;
    }

    const originalHandle = fields.get("5");
    const handleNum = originalHandle ? parseInt(originalHandle, 16) : NaN;
    const handle = Number.isFinite(handleNum) ? handleNum : null;
    const layer = fields.get("8") ?? "0";

    const common = ["62", "6", "420", "370", "48", "60", "67", "410"]
      .filter((c) => fields.has(c))
      .map((c) => [c, fields.get(c)]);

    let first = true;
    const emitted = [];
    const p62 = fields.get("62");
    const aci = p62 && Number(p62) > 0 && Number(p62) < 256 ? Number(p62) : 7;
    const pushPrimitive = (p) => {
      const rows = primitiveRows(p);
      const h =
        first && originalHandle
          ? originalHandle
          : (stats.nextHandle++).toString(16).toUpperCase();
      const ent = ["0", rows.type, "5", h];
      if (fields.has("330")) ent.push("330", fields.get("330"));
      ent.push("100", "AcDbEntity", "8", layer);
      for (const [c, v] of common) ent.push(c, v);
      ent.push(...rows.rows);
      emitted.push(ent.join(eol));
      first = false;
    };

    for (const p of prims) {
      if (p.type === "text" && strokeView) {
        const strokes = textToStrokePolylines(p, strokeView, layer, aci);
        if (strokes) {
          stats.textsStroked++;
          stats.strokePolylines += strokes.length;
          for (const points of strokes) pushPrimitive({ type: "polyline", points, closed: false });
          continue;
        }
        // 没字形/缺字形：保留 TEXT（TTF 回退），绝不静默丢字
        stats.textsKept++;
      }
      pushPrimitive(p);
    }

    stats.converted++;
    stats.primitives += emitted.length;
    stats.kind33 += decoded.stats.kind33;
    stats.unknownKinds += decoded.stats.unknown;
    stats.byType[type] = (stats.byType[type] || 0) + 1;
    out.push(emitted.join(eol));
    i = j;
  }

  return {
    // 没有替换任何实体时逐字节返回原文：老图纸（sample/e115/af7f/施工005）的产出必须不变
    text: stats.converted ? out.join(eol) : text,
    ...stats,
  };
}
