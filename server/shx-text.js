/**
 * SHX 笔画字体 → 笔画几何（LWPOLYLINE）。
 *
 * 为什么需要（T2）：web 端 dxf-viewer **只能画 TTF 字形**，`STYLE` 表里指向 `.shx`
 * 的字体它根本不认识 —— 那些文字在 WebGL 里不是乱码而是**整段消失**（引擎拿不到字形）。
 * 服务端把这类文字在预处理阶段直接转成 LWPOLYLINE 注回 DXF，浏览器就当普通线画，
 * 既不用 fork dxf-viewer，也不用改 `web/**`。
 *
 * 设计要点（细节都在下面各函数上方）：
 *   · 只在 STYLE 的主字体/大字体确实是 .shx 时接管（组码 3/4 省略扩展名的
 *     `SIMPLEX` / `GBCBIG` 由 fonts.js 按 kind:"shx" 解析后判定），其余一律返回 null，
 *     调用方保留原 TEXT；
 *   · 提供 `ctx.resolveShape` 依赖注入，测试不需要真的 SHX 文件；
 *   · `fonts.js` 用动态 import，缺文件/写坏时降级成"SHX 关闭"，绝不影响开图。
 *
 * 坐标系：DXF 世界坐标，Y 向上；`item.rot` 是**度**（与 block-text.js 的 flattenTexts 一致）。
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { DIAMETER_CHAR } from "./block-text.js";

const require = createRequire(import.meta.url);

/*
 * @mlightcad/shx-parser 1.4.5 的 package.json 是 `"type": "module"`，但 `main` 指向
 * `dist/index.cjs.js` —— Node 按扩展名规则把 `.cjs.js` 当 **ESM** 解析，于是那份 CJS
 * 产物第一行 `exports.xxx=` 直接抛 `exports is not defined`（实测 Node 26）。
 * 用 `require()` 拿到的还是空命名空间（不报错，更坑）。
 * 解决：读包自己的 package.json，按它声明的 `module`（真正的 ESM 构建）加载。
 * require(ESM) 在 Node ≥20.19 / ≥22.12 是同步可用的，正好满足 loadShxFont 的同步契约。
 */
let ShxFontCtor = null;
let iconv = null;
let depsError = null;
try {
  const tryLoad = (spec) => {
    try {
      const mod = require(spec);
      return mod && typeof mod.ShxFont === "function" ? mod : null;
    } catch {
      return null; // 该 spec 不能用；继续试包自己的 ESM 构建
    }
  };
  let mod = tryLoad("@mlightcad/shx-parser");
  if (!mod) {
    const pkgPath = require.resolve("@mlightcad/shx-parser/package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const entry = pkg.module || pkg.main;
    if (entry) mod = tryLoad(path.join(path.dirname(pkgPath), entry));
  }
  ShxFontCtor = mod ? mod.ShxFont : null;
  if (!ShxFontCtor) throw new Error("ShxFont 导出缺失");
} catch (e) {
  depsError = e;
}
try {
  iconv = require("iconv-lite");
} catch (e) {
  if (!depsError) depsError = e;
}

/* ───────────────────────── 常量（导出便于测试/调参） ───────────────────────── */

export const SHX_LIMITS = Object.freeze({
  /** 单条文字最多产出的折线数（防止病态字体把 DXF 撑爆） */
  maxPolylines: 2000,
  /** 单条折线最多顶点数 */
  maxPoints: 4000,
  /** 多行文字行距 = h × 1.6 */
  lineHeight: 1.6,
  /** 字形没有可信 lastPoint 时的字距补偿 = h × 0.2（与解析器默认 InkWidthAdvanceStrategy 一致） */
  sideBearing: 0.2,
  /** 缺字形字符占位前进量 = h × 0.5（不画 `?`，但也不让后面的字叠在一起） */
  missingAdvance: 0.5,
});

const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF01-\uFF60]/;
const LINE_HEIGHT = SHX_LIMITS.lineHeight;
const SIDE_BEARING = SHX_LIMITS.sideBearing;
const MISSING_ADVANCE = SHX_LIMITS.missingAdvance;
const MAX_POLYLINES = SHX_LIMITS.maxPolylines;
const MAX_POINTS = SHX_LIMITS.maxPoints;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const num = (v, dflt = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};
const posNum = (v, dflt = 1) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};
const normName = (n) => String(n ?? "").trim().toUpperCase();
const clip = (s, n = 24) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));

/* ───────────────────────── 字体名 / 编码推断 ───────────────────────── */

/** 字体名是否 SHX（大小写不敏感，允许带路径）。 */
export function isShxName(name) {
  return /\.shx\s*$/i.test(String(name ?? "").trim());
}

/** `$DWGCODEPAGE` / TextDecoder 编码名 → iconv-lite 编码名 */
function codepageEncoding(codepage) {
  const cp = String(codepage ?? "").trim().toLowerCase();
  if (!cp) return null;
  if (cp.includes("936") || cp === "gbk" || cp === "gb2312" || cp === "gb18030" || cp === "cp936") return "gbk";
  if (cp.includes("950") || cp === "big5" || cp === "cp950") return "big5";
  if (cp.includes("932") || cp === "shift_jis" || cp === "shift-jis" || cp === "sjis" || cp === "cp932") return "shift_jis";
  if (cp.includes("949") || cp === "euc-kr" || cp === "euckr" || cp === "cp949") return "euc-kr";
  return null;
}

/**
 * 从**大字体文件名**推断传统码页（大字体按 DBCS 双字节码索引字形，必须先按码页编码）。
 *
 * 顺序很重要：`gbcbig.shx` 同时含 "gb" 与 "big"，必须先命中 GBK 分支。
 *   gbcbig / hztxt / tssdchn / china… → gbk
 *   chineset / bigfont / cht…          → big5
 *   extfont / jis / japan…             → shift_jis
 *   whgdtxt / hangul / korea…          → euc-kr
 * 推断不出来时退回 `$DWGCODEPAGE`，再不行 gbk（国内图纸最常见）。
 *
 * @param {string} bigFontName
 * @param {string} [codepage]
 * @returns {"gbk"|"big5"|"shift_jis"|"euc-kr"}
 */
export function inferShxEncoding(bigFontName, codepage) {
  const n = String(bigFontName ?? "").trim().toLowerCase();
  if (/gbcbig|gbc?h\b|hztxt|tssdchn|tssd|china|gbk|gb2312|gb18030/.test(n)) return "gbk";
  if (/chineset|bigfont|cht|traditional|big5/.test(n)) return "big5";
  if (/extfont|jis|japan|sjis|shift[-_]?jis/.test(n)) return "shift_jis";
  if (/whgdtxt|hangul|korea|euc[-_]?kr|ksc/.test(n)) return "euc-kr";
  return codepageEncoding(codepage) || "gbk";
}

/* ───────────────────────── 字体加载（LRU 16） ───────────────────────── */

const FONT_CACHE = new Map();
const FONT_CACHE_MAX = 16;

/**
 * 读入并解析一个 SHX 字体；按绝对路径缓存，LRU 上限 16。
 * @param {string} fontPath
 * @returns {object|null} ShxFont 实例；读不到/解析失败返回 null
 */
export function loadShxFont(fontPath) {
  const key = String(fontPath ?? "");
  if (!key) return null;
  const hit = FONT_CACHE.get(key);
  if (hit) {
    // 命中后重新插入，维持 LRU 顺序
    FONT_CACHE.delete(key);
    FONT_CACHE.set(key, hit);
    return hit;
  }
  if (!ShxFontCtor) return null;
  let font = null;
  try {
    const buf = fs.readFileSync(key);
    // Buffer 可能来自共享池，必须按 byteOffset 切片，否则 ArrayBuffer 带着别人的字节
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    font = new ShxFontCtor(ab);
  } catch {
    font = null;
  }
  if (!font) return null;
  FONT_CACHE.set(key, font);
  while (FONT_CACHE.size > FONT_CACHE_MAX) {
    const oldest = FONT_CACHE.keys().next().value;
    FONT_CACHE.delete(oldest);
  }
  return font;
}

/** 测试/热更新用：清空字体缓存。 */
export function clearShxFontCache() {
  FONT_CACHE.clear();
}

/* ───────────────────────── 几何工具 ───────────────────────── */

function bboxOfPolylines(polylines) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const poly of polylines || []) {
    for (const p of poly || []) {
      if (!isNum(p?.x) || !isNum(p?.y)) continue;
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

/** 等比缩放一个 shape（polylines / lastPoint / bbox 全部一起缩）。 */
function scaleShape(shape, k) {
  const s = Number.isFinite(k) && k !== 0 ? k : 1;
  const polylines = [];
  for (const poly of shape?.polylines || []) {
    const pts = [];
    for (const p of poly || []) {
      if (!isNum(p?.x) || !isNum(p?.y)) continue;
      pts.push({ x: p.x * s, y: p.y * s });
    }
    polylines.push(pts);
  }
  const lp = shape?.lastPoint;
  const lastPoint = lp && isNum(lp.x) && isNum(lp.y) ? { x: lp.x * s, y: lp.y * s } : null;
  const bb = shape?.bbox;
  const bbox =
    bb && isNum(bb.minX) && isNum(bb.maxX) && isNum(bb.minY) && isNum(bb.maxY)
      ? { minX: bb.minX * s, minY: bb.minY * s, maxX: bb.maxX * s, maxY: bb.maxY * s }
      : bboxOfPolylines(polylines);
  return { polylines, lastPoint, bbox, hasExplicitAdvance: shape?.hasExplicitAdvance };
}

/**
 * 字距（advance，已按当前字高缩放）。
 *
 * 这里对任务书里的 "lastPoint.x 优先" 做了一处**基于实测的收紧**：
 *   · 大字体（BIGFONT）是定宽单元格，`lastPoint.x` 是**笔位**不是字宽 ——
 *     gbcbig.shx 的「中」raw lastPoint.x = 12、墨迹 maxX = 55，直接拿 12 当字距会让
 *     整行汉字叠在一起。大字体一律用单元格宽度 `h × content.width / content.height`。
 *   · 主字体/大字体以外的字形：`lastPoint.x` 只有**不小于墨迹右边界**才可信
 *     （txt.shx 'A'：lastPoint 6 ≥ maxX 4 → 用 6）；否则按解析器默认的
 *     InkWidthAdvanceStrategy：`bbox.maxX + 0.2 × cellWidth`。
 *   · 没有墨迹的字形（空格等）用 lastPoint.x，再不行用单元格宽度。
 *
 * @param {{shape:object, kind:"primary"|"big", cell:number}} g
 * @param {number} h 当前字高（图纸单位）
 */
function advanceOf(g, h) {
  const shape = g?.shape;
  if (!shape) return h * MISSING_ADVANCE;
  const cell = Number.isFinite(g.cell) && g.cell > 0 ? g.cell : h;
  const lp = shape.lastPoint;
  const bb = shape.bbox || bboxOfPolylines(shape.polylines);
  const inkMaxX = isNum(bb.maxX) ? bb.maxX : 0;
  const hasInk = (shape.polylines || []).some((p) => p && p.length >= 2);

  if (g.kind === "big") return cell; // 大字体定宽，lastPoint 不可作字距（见上）
  if (!hasInk) return lp && isNum(lp.x) && lp.x > 0 ? lp.x : cell;
  if (shape.hasExplicitAdvance && lp && isNum(lp.x) && lp.x > 0) return lp.x;
  if (lp && isNum(lp.x) && lp.x > 0 && lp.x >= inkMaxX - 1e-9) return lp.x;
  return Math.max(inkMaxX, 0) + cell * SIDE_BEARING;
}

/* ───────────────────────── 上下文 ───────────────────────── */

const FONTS_MODULE = { promise: null };

/** 动态导入 fonts.js：文件还不存在/正被别的 lane 改坏时返回 null，不抛。 */
async function loadFontsModule() {
  if (!FONTS_MODULE.promise) {
    FONTS_MODULE.promise = import("./fonts.js")
      .then((m) => (m && typeof m.resolveFontFile === "function" ? m : null))
      .catch(() => null);
  }
  return FONTS_MODULE.promise;
}

/**
 * 建立 SHX 渲染上下文。
 *
 * `root` 是字体搜索根目录（通常 = DXF 所在目录），`styleTable` 来自
 * `fonts.readStyleTable(dxfPath)`：`{ [styleName]: { font, bigFont, height, widthFactor, oblique, flags } }`。
 *
 * 只纳主字体或大字体确实是 SHX 的 STYLE：`.shx` 结尾，或省略扩展名但
 * `resolveFontFile(..., { kind: "shx" })` 真能找到 .shx 文件（真实图纸常见 SIMPLEX/GBCBIG）。
 * 字体文件解析不到时该样式被跳过并记 warning。
 * `resolveShape(styleName, code, kind)` 是测试用的依赖注入，kind ∈ "primary" | "big"。
 *
 * @param {{root?:string, styleTable?:object, codepage?:string,
 *          resolveShape?:Function, encodeChar?:Function}} [opts]
 */
export async function createShxContext(opts = {}) {
  const root = opts.root ?? process.cwd();
  const styleTable = opts.styleTable && typeof opts.styleTable === "object" ? opts.styleTable : {};
  const codepage = opts.codepage ?? null;
  const resolveShape = typeof opts.resolveShape === "function" ? opts.resolveShape : null;
  const encodeCharOverride = typeof opts.encodeChar === "function" ? opts.encodeChar : null;

  const styles = new Map();
  const warnings = [];
  if (depsError) warnings.push(`SHX: 依赖未安装（${depsError.message || depsError}）`);

  // 差量：没有 resolveShape 时才需要真的去定位字体文件
  const fonts = resolveShape ? null : await loadFontsModule();
  if (!resolveShape && !fonts) warnings.push("SHX: fonts.js 不可用，SHX 文字已关闭");

  /* 单线体模式：
   *   中国工程图的观感基准是 CAD 的 txt/simplex 单线体；但 STYLE 表里大量文字写的是
   *   arial.ttf / SimSun.ttf / NSimSun.ttf（AutoCAD 里这些 TTF 的中文也会回退成宋体）。
   *   如果只把 .shx 样式转笔画，同一张图里就会出现"有的字是细单线、有的字是粗填充"，
   *   也就是用户反馈的"粗细不一"。
   *   `textStroke=always` 把**所有**样式都映射到默认单线体字体对：
   *       primary  simplex.shx → txt.shx
   *       bigfont  hztxt.shx   → gbcbig.shx
   *   ⚠️ 产品链路（dxf-web.js）自 v47 起默认传 always（用户要求全部文字单线骨架）；
   *   本模块直接调用时的兜底默认仍是 auto（只转真正的 SHX 样式），测试/工具依赖这个行为。
   *   找不到这些字体（例如机器上没装 AutoCAD）时自动退回原行为（TTF 填充），并记一条 warning。
   *   想恢复旧行为：设置环境变量 CADVIEWER_TEXT_STROKE=auto。
   */
  const textStroke = String(
    opts.textStroke ?? process.env.CADVIEWER_TEXT_STROKE ?? "auto"
  ).toLowerCase();
  const strokeAll = textStroke !== "auto" && textStroke !== "never";

  /** 默认单线体字体对（只解析一次）。返回 null 表示找不到，保持 TTF。 */
  let defaultsResolved = false;
  let defaultStroke = null;
  const ensureDefaultStroke = () => {
    if (defaultsResolved) return defaultStroke;
    defaultsResolved = true;
    if (resolveShape) {
      // 测试注入模式：不碰文件系统
      defaultStroke = {
        primary: null,
        bigFont: null,
        primaryName: "simplex.shx",
        bigFontName: "hztxt.shx",
        encoding: inferShxEncoding("hztxt", codepage),
      };
      return defaultStroke;
    }
    if (!fonts) return (defaultStroke = null);
    const primary =
      fonts.resolveFontFile("simplex.shx", root, { kind: "shx" }) ||
      fonts.resolveFontFile("txt.shx", root, { kind: "shx" });
    const big =
      fonts.resolveFontFile("hztxt.shx", root, { kind: "shx" }) ||
      fonts.resolveFontFile("gbcbig.shx", root, { kind: "shx" });
    if (!primary && !big) {
      warnings.push("SHX: 未找到默认单线体字体（simplex.shx/txt.shx），文字回退为填充字体");
      defaultStroke = null;
      return null;
    }
    defaultStroke = {
      primary,
      bigFont: big,
      primaryName: primary.split(/[\\/]/).pop(),
      bigFontName: big ? big.split(/[\\/]/).pop() : "",
      encoding: inferShxEncoding(big ? big.split(/[\\/]/).pop() : "", codepage),
    };
    return defaultStroke;
  };

  for (const [rawName, raw] of Object.entries(styleTable)) {
    if (!raw || typeof raw !== "object") continue;
    const name = String(rawName);
    // 对另一个 lane 可能采用的别名保持宽容，但以契约为准（font / bigFont）
    const fontName = String(raw.font ?? raw.primary ?? raw.fontName ?? "").trim();
    const bigName = String(raw.bigFont ?? raw.bigfont ?? raw.bigFontName ?? "").trim();
    /* 真实图纸里 STYLE 的组码 3/4 经常**省略 .shx 扩展名**（实测 5875ba481190.dxf：
     * font=SIMPLEX、bigFont=GBCBIG/BIGFONT 都没有扩展名）。所以无扩展名的名字也纳入候选，
     * 但必须由 resolveFontFile(kind:"shx") 真找到 .shx 文件才承认 —— kind 过滤保证
     * "SimSun" 这类无扩展名的 TTF 不会被误当成 SHX。 */
    const bareName = (n) => !!n && !/\.[a-z0-9]{1,6}$/i.test(n);
    const candPrimary = isShxName(fontName) || bareName(fontName);
    const candBig = isShxName(bigName) || bareName(bigName);

    /* 非 SHX 样式：单线体模式下也收进来，用默认字体对渲染 */
    if (!candPrimary && !candBig) {
      if (!strokeAll) continue;
      const d = ensureDefaultStroke();
      if (!d) continue;
      styles.set(normName(name), {
        name,
        primary: d.primary,
        bigFont: d.bigFont,
        widthFactor: posNum(raw.widthFactor, 1),
        oblique: num(raw.oblique, 0),
        height: num(raw.height, 0),
        encoding: d.encoding,
        primaryName: d.primaryName,
        bigFontName: d.bigFontName,
        units: 1,
        bigUnits: 1,
        primaryType: null,
        singleStroke: true,
      });
      continue;
    }

    let primary = null;
    let bigFont = null;
    if (!resolveShape) {
      if (!fonts) continue;
      if (candPrimary) primary = fonts.resolveFontFile(fontName, root, { kind: "shx" });
      if (candBig) bigFont = fonts.resolveFontFile(bigName, root, { kind: "shx" });
      if (!primary && !bigFont) {
        /* 关键分支：样式名写的是 `SimSun` / `NSimSun` / `Arial` 这类**无扩展名的 TTF 名**，
         * 上面的 bareName 启发式会把它当 SHX 候选去解析，解析失败后如果直接 continue，
         * 整个样式就不在 map 里 → 该样式的文字查不到字体、退回填充字体
         * （实测 施工005-车库消防.dwg：`宋体`/`_TCH_DYN` 全部中招，1838 条文字没转）。
         * 单线体模式下改为落到默认单线体字体对。 */
        if (strokeAll) {
          const d = ensureDefaultStroke();
          if (d) {
            styles.set(normName(name), {
              name,
              primary: d.primary,
              bigFont: d.bigFont,
              widthFactor: posNum(raw.widthFactor, 1),
              oblique: num(raw.oblique, 0),
              height: num(raw.height, 0),
              encoding: d.encoding,
              primaryName: d.primaryName,
              bigFontName: d.bigFontName,
              units: 1,
              bigUnits: 1,
              primaryType: null,
              singleStroke: true,
            });
            continue;
          }
        }
        warnings.push(`SHX: 找不到字体文件（样式 ${name}: ${fontName || "-"} / ${bigName || "-"}）`);
        continue;
      }
    }

    styles.set(normName(name), {
      name,
      // 契约字段
      primary,
      bigFont,
      widthFactor: posNum(raw.widthFactor, 1),
      oblique: num(raw.oblique, 0),
      height: num(raw.height, 0),
      encoding: inferShxEncoding(bigName, codepage),
      // 辅助字段（本模块内部使用；测试可注入 units）
      primaryName: fontName,
      bigFontName: bigName,
      units: 1,
      bigUnits: 1,
      primaryType: raw.primaryType ?? null,
    });
  }

  /* 单线体模式下补齐字体对（2026-11 实测缺口，勿删）：
   *   · 样式 `Standard` 只写 font=txt.shx、没有大字体 → 汉字查不到字形，整条退回 TTF
   *     （实测 7a75：1437 条"感烟探测器"等中文全卡在这里）；
   *   · 样式写 `simplex_.ttf + HZTXT` 时主字体不是 SHX → primary=null，连 ASCII 都画不出；
   *   · 样式写 `#hztxt.shx`（FileNotFoundException 之后的 AutoCAD 写法）→ 大字体解析失败。
   * 既然 always 模式的契约就是"所有字形都走默认单线体"，缺哪一半就用默认单线体补哪一半。
   * auto 模式不动（保持只认真正的 SHX 样式）。 */
  if (strokeAll) {
    const d = ensureDefaultStroke();
    if (d) {
      for (const st of styles.values()) {
        if (!st.primary && d.primary) {
          st.primary = d.primary;
          st.primaryName = d.primaryName;
          st.primaryType = null;
        }
        if (!st.bigFont && d.bigFont) {
          st.bigFont = d.bigFont;
          st.bigFontName = d.bigFontName;
          st.encoding = d.encoding;
        }
      }
    }
  }

  /* 单线体模式下兜底一个 STANDARD：图里常有没写 group 7 的 TEXT（实测 PDF 标签就没有），
   * 它们按 STANDARD 取样式，没有实体样式记录就会漏掉、退回填充字体。 */
  if (strokeAll && !styles.has(normName("STANDARD"))) {
    const d = ensureDefaultStroke();
    if (d) {
      styles.set(normName("STANDARD"), {
        name: "STANDARD",
        primary: d.primary,
        bigFont: d.bigFont,
        widthFactor: 1,
        oblique: 0,
        height: 0,
        encoding: d.encoding,
        primaryName: d.primaryName,
        bigFontName: d.bigFontName,
        units: 1,
        bigUnits: 1,
        primaryType: null,
        singleStroke: true,
      });
    }
  }

  return {
    root,
    codepage,
    styles,
    hasAnyShx: styles.size > 0,
    warnings,
    resolveShape,
    encodeChar: encodeCharOverride,
    /** 生效的笔画模式（"always" / "auto" / "never"）；调用方据此决定能不能加粗 */
    textStroke,
    /** true = 单线体模式（所有样式都走笔画字体）—— 加粗填充只在这个模式下启用，
     *  auto 模式必须保持与旧版本逐字节一致的输出。 */
    strokeAll,
  };
}

function styleFor(ctx, name) {
  if (!ctx?.styles || !ctx.styles.size) return null;
  return ctx.styles.get(normName(name || "STANDARD")) || null;
}

/* ───────────────────────── 字形解析 ───────────────────────── */

/**
 * 真实字体的字高归一化（**这是全模块唯一需要"经验推导"的地方**）：
 *
 *   @mlightcad/shx-parser 的 `getCharShape(code, size)` 内部是
 *       factor = size / fontData.content.height      （SHAPES 字体无 0 号字形时 factor = size）
 *   即它把每个字体自己声明的 `content.height` 当作 1 个字号。
 *   所以本模块显式复现同一公式：先按 content.height 取"原始字体单位"的字形，再乘
 *       scale = item.h / units
 *
 *   units 的取法（实测数据支撑，2026-11）：
 *     · 主字体：units = content.height（txt.shx=8、simplex.shx=28，墨迹 0.75~1.0em，正常）；
 *     · 大字体：units = max(content.height, 「中」/'H' 等参考字形的墨迹高度)。
 *       原因：gbcbig.shx 声明 height=64，但「中」的墨迹高度是 89（1.39 倍）、「图」84，
 *       直接按 64 归一化会让汉字比同排 ASCII 高近一倍；而 HZTXT.SHX 声明 127、「中」
 *       墨迹正好 127。取 max 只在"墨迹确实超出声明字号"时修正，对正常字体零影响。
 *     · content.height 为 0（少见）：用 size=1 取参考字形 bbox 高度。
 *
 *   进位宽度另算：cellWidth = h × content.width / content.height（大字体定宽 1em）。
 */
const FONT_UNITS = new WeakMap();

function fontUnits(font, kind, encoding) {
  const key = `${kind}:${encoding || ""}`;
  const cached = FONT_UNITS.get(font);
  if (cached && cached[key]) return cached[key];
  const c = font?.fontData?.content;
  const declared = num(c?.height, 0);
  const probe = declared > 0 ? declared : 1;
  let units = declared;
  try {
    for (const code of refCodesFor(kind, encoding)) {
      const s = font.getCharShape(code, probe);
      const bh = s?.bbox ? s.bbox.maxY - s.bbox.minY : 0;
      if (bh > 0) {
        units = Math.max(units, bh);
        break;
      }
    }
  } catch {
    /* 参考字形取不到就用声明值 */
  }
  if (!(units > 0)) units = 1;
  const ratio = declared > 0 && num(c?.width, 0) > 0 ? num(c.width, 0) / declared : 1;
  const info = { units, ratio, declared };
  const box = cached || {};
  box[key] = info;
  FONT_UNITS.set(font, box);
  return info;
}

/**
 * 参考字形的码位：
 *   · 主字体用 'H' / 'A' / '0'（Unicode 码位直接可用，unifont/shapes 都认）；
 *   · 大字体按 DBCS 码索引，**不能**用 Unicode 0x4E2D —— 必须先把「中」按码页编码成
 *     lead*256+trail（gbcbig 里 0x4E2D 不存在，实测会让修正完全跳过）。
 *     未知码页时依次试探各常用码页的「中」/「图」。
 */
function refCodesFor(kind, encoding) {
  if (kind !== "big") return [0x48, 0x41, 0x30];
  const codes = [];
  if (encoding && iconv) {
    for (const ch of ["中", "图"]) {
      try {
        const b = iconv.encode(ch, encoding);
        if (b && b.length === 2) codes.push(b[0] * 256 + b[1]);
      } catch {
        /* 码页不支持就试下面的固定码 */
      }
    }
  }
  // GBK/GB2312、Big5、Shift-JIS、EUC-KR 的「中」「图」
  codes.push(0xd6d0, 0xcdbc, 0xa4a4, 0xa4e5, 0x9286, 0x905c, 0xf1d6, 0xb5b5);
  return codes;
}

function glyphFromFont(font, code, h, kind, encoding) {
  const { units, ratio, declared } = fontUnits(font, kind, encoding);
  let shape;
  try {
    shape = font.getCharShape(code, declared > 0 ? declared : 1);
  } catch {
    shape = null;
  }
  if (!shape) return null;
  return { shape: scaleShape(shape, h / units), kind, cell: h * ratio };
}

function glyphFrom(ctx, style, kind, code, h) {
  if (typeof ctx.resolveShape === "function") {
    let shape = null;
    try {
      shape = ctx.resolveShape(style.name, code, kind);
    } catch {
      shape = null;
    }
    if (!shape) return null;
    // 注入的 shape 以"字体单位"为坐标，用 style.units 归一化；默认 1 → 直接按 h 缩放
    const units = kind === "big" ? posNum(style.bigUnits, 1) : posNum(style.units, 1);
    // 注入模式下无法得知字体 content.width/height，默认单元格 = h；
    // 测试可用 style.cellWidthFactor 覆盖（例如模拟定宽大字体）。
    const ratio = posNum(kind === "big" ? style.bigCellFactor : style.cellFactor, 1);
    return { shape: scaleShape(shape, h / units), kind, cell: h * ratio };
  }
  const fontPath = kind === "big" ? style.bigFont : style.primary;
  if (!fontPath) return null;
  const font = loadShxFont(fontPath);
  if (!font) return null;
  return glyphFromFont(font, code, h, kind, style.encoding);
}

function primaryIsUnifont(style) {
  if (style.primaryType) return style.primaryType === "unifont";
  if (!style.primary) return false;
  const font = loadShxFont(style.primary);
  const type = font?.fontData?.header?.fontType ?? null;
  style.primaryType = type;
  return type === "unifont";
}

/** 字符 → 大字体 DBCS 字节；编码失败/不可映射（iconv 会替换成 '?'）返回 null。 */
function encodeChar(ch, encoding, ctx) {
  if (typeof ctx?.encodeChar === "function") {
    try {
      const r = ctx.encodeChar(ch, encoding);
      return r && r.length ? Uint8Array.from(r) : null;
    } catch {
      return null;
    }
  }
  if (!iconv) return null;
  try {
    const buf = iconv.encode(ch, encoding);
    if (!buf || !buf.length) return null;
    // iconv-lite 对码页外字符返回 "?"，必须回解验证，否则会去找 0x3F 的字形
    if (iconv.decode(buf, encoding) !== ch) return null;
    return Uint8Array.from(buf);
  } catch {
    return null;
  }
}

/**
 * 单个字符 → 字形（已按 item.h 缩放）。
 * 映射规则：
 *   · ASCII (<=0x7F)      → 主字体，码 = Unicode 码位；
 *   · 主字体是 unifont    → 先按主字体 + Unicode 码位；
 *   · 其余（含大字体）    → 先按码页编码成 DBCS，code = lead*256+trail 查大字体；
 *   · 大字体查不到/编码失败 → 退回主字体 + Unicode 码位（unifont 字体可用）。
 */
function resolveCharShape(ctx, style, ch, cp, h) {
  if (cp <= 0x7f) {
    const g = glyphFrom(ctx, style, "primary", cp, h);
    if (g) return g;
    // 主字体缺失/没有该 ASCII 字形时，大字体通常也带 ASCII（HZTXT 等），兜一层
    return (style.bigFont || isShxName(style.bigFontName)) && glyphFrom(ctx, style, "big", cp, h);
  }

  if (primaryIsUnifont(style)) {
    const g = glyphFrom(ctx, style, "primary", cp, h);
    if (g) return g;
  }

  if (style.bigFont || isShxName(style.bigFontName)) {
    const bytes = encodeChar(ch, style.encoding, ctx);
    if (bytes) {
      const code = bytes.length >= 2 ? bytes[0] * 256 + bytes[1] : bytes[0];
      const g = glyphFrom(ctx, style, "big", code, h);
      if (g) return g;
    }
  }

  return glyphFrom(ctx, style, "primary", cp, h);
}

/* ───────────────────────── 排版 ───────────────────────── */

/** 多行：`\n` / `\r\n` / 未清理的 `\P` 都算换行。 */
function splitLines(text) {
  return String(text ?? "").split(/\r\n|\r|\n|\\P/);
}

/* ───────────────────────── MTEXT → 纯文本（v18）─────────────────────────
 *
 * MTEXT 的组码 1/3 里是一串**内联排版码**，不是明文。本模块是单线体渲染，
 * 只关心"画哪些字符、从哪换行、怎么对齐"，所以先把它们抽成纯文本。
 *
 * 实现的语义（`mtextToPlainText`）：
 *   · `\P` → `\n`（`renderShxText` 每行下移 1.6h）；
 *   · `\~` → 普通空格（单线体没有 NBSP 字形；这里不做折行，NBSP 与空格等价）；
 *   · `\\` / `\{` / `\}` → 字面反斜杠/花括号（先转成占位符，避免被下面的码规则误删）；
 *   · `{...}` 分组花括号 → 去掉花括号保留内容；
 *   · `\fArial|b0;`（字体）→ 删；`\H1.5x;`/`\H2.5;`（逐段字高）→ 删。
 *     ⚠️ 本版**不实现逐段字高/字体**：所有 run 都按实体的组码 40 排；要支持的话
 *     得在解析阶段把 run 拆成多段并逐段缩放，属后续工作。
 *   · `\A1;` / `\C1;` / `\c255;` / `\T1.5;` / `\Q15;` / `\W0.8;` / `\p...;` → 删；
 *     另加无害的开关码 `\O`/`\o`（上划线）、`\L`/`\l`（下划线）、`\K`/`\k`（删除线）也删；
 *   · `\S1/2;` / `\S1^2;` → `1/2` / `1^2`（保留分子分母与分隔符）；
 *   · `%%d`/`%%D` → `°`，`%%p`/`%%P` → `±`，`%%%` → `%`，`%%c`/`%%C` → DIAMETER_CHAR，
 *     `%%nnn` → 对应字符；
 *   · `\U+XXXX` → 字符（dxf-web 已经全局解过一次，这里防守性再解）；
 *   · 去掉控制字符（保留 `\n`）与首尾换行。
 */

/** 字面转义占位符：处理期间使用，恢复前不会出现在正常文本里 */
const MTEXT_LITERAL = { "\\": "\u0001", "{": "\u0002", "}": "\u0003" };

/**
 * MTEXT 内联码 → 纯文本。
 * @param {string} raw 组码 1 + 重复组码 3 按文件顺序拼接后的原文
 * @returns {string}
 */
export function mtextToPlainText(raw) {
  let t = String(raw ?? "");
  // 制表符给一个正常空格；其余 C0 控制字符先清掉（占位符要用控制字符，必须先清）
  t = t.replace(/\t/g, " ");
  t = t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");

  // ① 转义字面量优先，之后 `\\A1;` 才不会被当成对齐码删掉
  t = t.replace(/\\([\\{}])/g, (_, c) => MTEXT_LITERAL[c]);
  // ② \U+XXXX（防守性）
  t = t.replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  // ③ 堆叠分数：保留内部文本与 `/`/`^` 分隔符
  t = t.replace(/\\S([^;]*);/g, "$1");
  // ④ 带参数的排版码：字体/字高/对齐/颜色/字距/宽度/段落
  t = t.replace(/\\(?:[ACcFfHhQTW]|p)[^;\\]*;/g, "");
  // ⑤ 无参数开关码
  t = t.replace(/\\[OoKkLl]/g, "");
  // ⑥ 换行 / 不换行空格
  t = t.replace(/\\P/g, "\n");
  t = t.replace(/\\~/g, " ");
  // ⑦ 分组花括号
  t = t.replace(/[{}]/g, "");
  // ⑧ 恢复字面量
  t = t.replace(/\u0001/g, "\\").replace(/\u0002/g, "{").replace(/\u0003/g, "}");
  // ⑨ %% 控制码
  t = t
    .replace(/%%[cC]/g, DIAMETER_CHAR)
    .replace(/%%[dD]/g, "°")
    .replace(/%%[pP]/g, "±")
    .replace(/%%%/g, "%")
    .replace(/%%([0-9]{3})/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
  // ⑩ 清控制字符与首尾换行（中间换行保留）
  t = t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  t = t.replace(/^[\r\n]+|[\r\n]+$/g, "");
  return t;
}

/**
 * MTEXT 附着点（组码 71）→ renderShxText 的 halign/valign。
 *
 * 71：1..3 = 上排（左/中/右），4..6 = 中排，7..9 = 下排。
 * renderShxText 的 valign：0=基线、1=底、2=中、3=顶，作用在**整段墨迹 bbox** 上：
 *   · 顶部附着（1/2/3）→ valign=3，墨迹顶边落在插入点 y；
 *     也就是**基线在顶边下方约一个字高**（`renderShxText` 用 dy=-maxY 实现）；
 *   · 中部附着（4/5/6）→ valign=2，墨迹中线落在 y；
 *   · 底部附着（7/8/9）→ valign=1，墨迹底边（最后一行基线）落在 y。
 * halign：0=左、1=中、2=右（与 TEXT 的 72 一致）。
 *
 * @param {number} attach 组码 71（缺省 1 = 左上）
 * @returns {{halign:number, valign:number}}
 */
export function mtextAttachToAlign(attach) {
  const n = Math.trunc(num(attach, 1));
  const a = n >= 1 && n <= 9 ? n : 1;
  return {
    halign: (a - 1) % 3,
    valign: a <= 3 ? 3 : a <= 6 ? 2 : 1,
  };
}

/**
 * 有效宽度因子：实体组码 41 优先（block-text 的 `wf` 默认 1，无法区分"没写"和"写了 1"），
 * 因此显式 1 时退回 STYLE 的宽度因子，避免把样式上的 0.8 丢掉。
 */
function widthFactorOf(item, style) {
  const ew = Number(item.wf);
  if (Number.isFinite(ew) && ew > 0 && Math.abs(ew - 1) > 1e-9) return ew;
  const sw = Number(style.widthFactor);
  return Number.isFinite(sw) && sw > 0 ? sw : 1;
}

/** TEXT 72 / MTEXT 附着点 → 0=左 1=中 2=右（3/5 对齐/布满按左处理，4=middle 按居中）。 */
function halignOf(item) {
  const a = Math.trunc(num(item.halign, 0));
  if (a === 1 || a === 4) return 1;
  if (a === 2) return 2;
  return 0;
}

/** TEXT 73 → 0=基线 1=底 2=中 3=顶 */
function valignOf(item) {
  const v = Math.trunc(num(item.valign, 0));
  return v === 1 || v === 2 || v === 3 ? v : 0;
}

/**
 * 测量文字宽度（图纸单位；已含宽度因子，未含旋转）。
 * 非 SHX 样式返回 0。
 */
export function measureTextWidth(item, ctx) {
  if (!item || !ctx) return 0;
  const style = styleFor(ctx, item.style);
  if (!style) return 0;
  const h = num(item.h, 0);
  if (!(h > 0)) return 0;
  const wf = widthFactorOf(item, style);
  let max = 0;
  for (const line of splitLines(item.text)) {
    let pen = 0;
    for (const ch of Array.from(line)) {
      const cp = ch.codePointAt(0);
      const g = resolveCharShape(ctx, style, ch, cp, h);
      pen += g ? advanceOf(g, h) : h * MISSING_ADVANCE;
    }
    if (pen * wf > max) max = pen * wf;
  }
  return max;
}

/**
 * 把一条文字渲染成笔画折线（DXF 世界坐标）。
 *
 * @param {{text:string,x:number,y:number,h:number,rot?:number,wf?:number,
 *          halign?:number,valign?:number,layer?:string,aci?:number,style?:string,
 *          ax?:number|null,ay?:number|null}} item
 * @param {object} ctx createShxContext() 的返回值
 * @returns {{polylines:{points:[number,number][],layer:string,aci:number,
 *            cjk:boolean}[], advance:number,styleName:string,missing:number,warnings:string[]}|null}
 *   `cjk` = 该折线来自汉字/全角字符（加粗填充几何的判据）。
 *   null = 样式不是 SHX / 字体找不到 / 整段无字形 → 调用方保留原 TEXT
 */
/**
 * 按 MTEXT 折行宽度（组码 41）折行。
 * 宽度比较用「笔位 × 宽度因子」，与 `renderShxText` 内部的度量一致。
 * @param {string[]} lines
 * @param {*} ctx
 * @param {*} style
 * @param {number} h 字高
 * @param {number} wf 宽度因子
 * @param {number} width 折行宽度（<=0 表示不折行）
 * @returns {string[]}
 */
function wrapByWidth(lines, ctx, style, h, wf, width) {
  if (!(width > 0)) return lines;
  /* 恰好排满 ⇒ 不折行。AutoCAD 只在**下一个字符超出**折行宽度时换行，刚好等于
   * 宽度是合法的（本图标题就是这种情况：19 字 × 425.19685 × 0.8 = 6462.99212598425
   * = 组码 41 的 6462.99212598425）。浮点累加会让"相等"变成差 1e-12 的两种结果，
   * 所以给一个相对 1e-9 的容差；这个量级远小于任何真实字距，不会影响别的折行。 */
  const limit = width + Math.max(1e-9, Math.abs(width) * 1e-9);
  const out = [];
  for (const line of lines) {
    const chars = Array.from(line);
    /* 中文折行保护（v25）：广联达/CAD 对中文标签是「每行至少 2 个汉字」——
     * 实测「数据机架」h=225、组码 41=248：每个汉字 225 宽，纯按宽度折行会变成
     * 1 字一行共四行，而基准图是「数据」/「机架」两行。所以含汉字的行把有效宽度
     * 抬到 max(width, 2 × 单字 advance)，等价于"当前行不足 2 字时不换行"。
     * 拉丁串一行都不含汉字，minChars=1，折行行为与旧版逐字节一致；
     * 整串只有 1 个字时也永远凑不满 2 字，自然不会折。 */
    const minChars = chars.some((ch) => CJK_RE.test(ch)) ? 2 : 1;
    let cur = "";
    let pen = 0;
    let count = 0;
    for (const ch of chars) {
      const cp = ch.codePointAt(0);
      const g = resolveCharShape(ctx, style, ch, cp, h);
      const adv = g ? advanceOf(g, h) : h * MISSING_ADVANCE;
      if (cur && count >= minChars && (pen + adv) * wf > limit) {
        out.push(cur);
        cur = ch;
        pen = adv;
        count = 1;
      } else {
        cur += ch;
        pen += adv;
        count++;
      }
    }
    out.push(cur);
  }
  return out.length ? out : [""];
}

export function renderShxText(item, ctx) {
  if (!item || !ctx) return null;
  const style = styleFor(ctx, item.style);
  if (!style) return null;
  const text = String(item.text ?? "");
  if (!text) return null;
  const h = num(item.h, 0);
  if (!(h > 0)) return null;

  const wf = widthFactorOf(item, style);
  const shear = Math.tan((num(style.oblique, 0) * Math.PI) / 180);
  /* MTEXT 组码 41 是**折行宽度**（不是宽度因子）。AutoCAD 会按它自动换行 ——
   * 实测「数据机架」(h=225, 宽=248) 每个汉字 225 宽，只能排 1 个字，于是折成
   * 竖排一列；我们之前忽略宽度，就画成一行横排（用户反馈"竖排被渲染成横排"）。
   * 这里在排版前先按宽度折行，语义与 AutoCAD 的按字符折行一致（不处理西文单词边界）。 */
  const lines = wrapByWidth(splitLines(text), ctx, style, h, wf, num(item.width, 0));

  /* 旋转一律按 item.rot 应用，不对汉字做任何特判。
   * 基准是广联达的放大截图：「假机柜」这类竖排标签是**整串旋转 90°**（字形侧倒、
   * 沿竖直方向排字），不是正立逐字向下堆叠 —— 之前那个特判会让字序/朝向都变。 */
  const rotDeg = num(item.rot, 0);
  const lineStep = h * LINE_HEIGHT;

  const hAlign = halignOf(item);
  const vAlign = valignOf(item);

  const lineData = [];
  let missing = 0;
  const missingSeen = new Set();
  let emitted = 0;
  let overflow = false;
  let inkMinY = Infinity;
  let inkMaxY = -Infinity;

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const baseY = -li * lineStep;
    let pen = 0;
    const polys = [];

    for (const ch of Array.from(line)) {
      const cp = ch.codePointAt(0);
      const g = resolveCharShape(ctx, style, ch, cp, h);
      if (!g) {
        missing++;
        missingSeen.add(ch);
        pen += h * MISSING_ADVANCE;
        continue;
      }
      /* CJK 标记：调用方据此决定"这条笔画要不要加粗成填充四边形"。
       * 拉丁笔画本身够清楚，保持细折线；汉字单线太细（用户反馈的"光架子"）。 */
      const cjk = CJK_RE.test(ch);

      let stop = false;
      for (const poly of g.shape.polylines) {
        if (!poly || !poly.length) continue;
        if (emitted >= MAX_POLYLINES) {
          overflow = true;
          stop = true;
          break;
        }
        let pts = poly;
        if (pts.length > MAX_POINTS) {
          pts = pts.slice(0, MAX_POINTS);
          overflow = true;
        }
        const out = [];
        for (const p of pts) {
          if (!isNum(p?.x) || !isNum(p?.y)) continue;
          const gy = p.y; // 斜体剪切用"字形自身"的 y，基线不被剪歪
          const y = gy + baseY;
          // 先在"未乘宽度因子"的笔位空间里累加 x，再统一 ×wf（电子宽度随宽度因子缩放）；
          // 斜体剪切按 AutoCAD 习惯作用在缩放之后：x = x*wf + y*tan(oblique)
          const x = (pen + p.x) * wf + gy * shear;
          out.push([x, y]);
          if (y < inkMinY) inkMinY = y;
          if (y > inkMaxY) inkMaxY = y;
        }
        if (out.length) {
          polys.push({ pts: out, cjk });
          emitted++;
        }
      }
      if (stop) break;
      pen += advanceOf(g, h);
    }

    lineData.push({ polys, width: pen * wf });
    if (overflow) break;
  }

  if (!emitted) return null; // 整段都无字形 → 交给调用方保留原 TEXT

  // ── 垂直对齐：按整段墨迹 bbox 平移（多行一起算）
  const minY = Number.isFinite(inkMinY) ? inkMinY : 0;
  const maxY = Number.isFinite(inkMaxY) ? inkMaxY : h;
  let dy = 0;
  if (vAlign === 1) dy = -minY; // 底部
  else if (vAlign === 2) dy = -(minY + maxY) / 2; // 居中
  else if (vAlign === 3) dy = -maxY; // 顶部

  // 非左对齐时 DXF 用 11/21（第二对齐点）定位；有就优先用它
  const useAnchor = (hAlign !== 0 || vAlign !== 0) && isNum(item.ax) && isNum(item.ay);
  const ox = useAnchor ? item.ax : num(item.x, 0);
  const oy = useAnchor ? item.ay : num(item.y, 0);

  /* 旋转：DXF 组码 50 是 CCW 正角（AutoCAD 标准口径），直接按 + 应用。
   * 块内文字的"世界角"由 block-text.js 在做 INSERT 矩阵时已经合成好（rot_text + 块旋转），
   * 这里不再做任何符号特判。 */
  const rot = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  /* 镜像块（INSERT 的负缩放，累计矩阵 det < 0）：block-text.js 已把 rot 取成
   * atan2(b,a)，此时本地字形再沿 x 轴翻一次 (x,y)→(x,-y) 与 rot 合成，
   * 结果严格等于完整 INSERT 矩阵。 */
  const mirror = item.mirror === true;

  const layer = item.layer != null ? String(item.layer) : "0";
  const aci = Number.isFinite(Number(item.aci)) && Number(item.aci) > 0 && Number(item.aci) < 256
    ? Number(item.aci)
    : 7;

  const out = [];
  let maxWidth = 0;
  for (const ld of lineData) {
    if (ld.width > maxWidth) maxWidth = ld.width;
    // 每行各自按 halign 对齐（多行 MTEXT 的实际观感；单行与"按总宽对齐"完全一致）
    const adx = hAlign === 1 ? -ld.width / 2 : hAlign === 2 ? -ld.width : 0;
    for (const pts of ld.polys) {
      const mapped = pts.pts.map(([x, y]) => {
        const lx = x + adx;
        const ly = (mirror ? -y : y) + (mirror ? -dy : dy);
        return [lx * cos - ly * sin + ox, lx * sin + ly * cos + oy];
      });
      out.push({ points: mapped, layer, aci, cjk: pts.cjk });
    }
  }

  const warnings = [];
  if (overflow) {
    const msg = `SHX: 文字 "${clip(text)}" 超过上限（${MAX_POLYLINES} 折线 / ${MAX_POINTS} 点），已截断`;
    warnings.push(msg);
    if (Array.isArray(ctx.warnings)) ctx.warnings.push(msg);
  }

  return {
    polylines: out,
    advance: maxWidth,
    styleName: style.name,
    missing,
    /** 缺字形的具体字符（最多 64 个，供诊断/回退判断用；不改渲染结果） */
    missingChars: [...missingSeen].slice(0, 64),
    warnings,
    /** 实际排版出的行数（MTEXT 折行后 > 1）；调用方用它统计"折行生效"的条数 */
    lineCount: lineData.length,
  };
}
