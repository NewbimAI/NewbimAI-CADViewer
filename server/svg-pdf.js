/**
 * cadcraft 产出的 SVG → 矢量 PDF。
 *
 * 设计前提：只服务 cadcraft-cli 0.7.0 的导出结构（实测）：
 *   <polyline fill="none" stroke="#rrggbb" stroke-width="..." points="x,y ..."/>
 *   <path fill="#rrggbb" d="M x y L x y Z M ..."/>
 *   <circle cx="..." cy="..." r="..." fill="#rrggbb"/>
 *   <rect width="100%" height="100%" fill="white"/>（跳过）
 * 没有 <g>/transform/text/defs/style/use/ellipse；path 只含 M/L/Z（大小写都兼容）。
 *
 * 不引入任何依赖：内容流用 node:zlib 压缩，PDF 对象手写。
 * 解析用正则扫描，遇到不认识的元素/属性/路径命令一律跳过，绝不因为一个图元让整张图失败。
 */

import fs from "node:fs";
import zlib from "node:zlib";

const KAPPA = 0.5522847498; // 4 段三次贝塞尔近似圆
const ELEMENT_RE = /<(polyline|path|circle)\b([^>]*)>/g;
const ATTR_RE = /([\w:-]+)\s*=\s*"([^"]*)"/g;
const POINT_NUM_RE = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;
const PATH_TOKEN_RE = /[MLZmlz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;
/** path 里出现这些命令说明不是我们支持的子集：整条 path 跳过，避免把控制点当直线画歪。 */
const UNSUPPORTED_PATH_CMD_RE = /[CcSsQqTtAaHhVv]/;

/** 坐标/线宽格式化：最多 4 位小数，去掉无意义的尾零。 */
function fmt(n) {
  if (!Number.isFinite(n)) return "0";
  const r = Math.round(n * 10000) / 10000;
  return String(r === 0 ? 0 : r);
}

function parseAttrs(s) {
  const out = {};
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(s))) out[m[1]] = m[2];
  return out;
}

/** "#rrggbb"/"#rgb"/"rgb(...)"/少量颜色名 → [r,g,b]（0..1）；none/无法识别 → null */
function parseColor(value) {
  if (!value) return null;
  const v = String(value).trim().toLowerCase();
  if (v === "none" || v === "transparent") return null;
  if (v === "white") return [1, 1, 1];
  if (v === "black") return [0, 0, 0];
  if (v === "red") return [1, 0, 0];
  if (v === "green") return [0, 128 / 255, 0];
  if (v === "blue") return [0, 0, 1];
  let hex = v;
  if (hex[0] === "#") hex = hex.slice(1);
  if (/^[0-9a-f]{3}$/.test(hex)) {
    hex = hex
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (/^[0-9a-f]{6}$/.test(hex)) {
    return [
      parseInt(hex.slice(0, 2), 16) / 255,
      parseInt(hex.slice(2, 4), 16) / 255,
      parseInt(hex.slice(4, 6), 16) / 255,
    ];
  }
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(v);
  if (m) {
    return [
      Math.min(1, Math.max(0, Number(m[1]) / 255)),
      Math.min(1, Math.max(0, Number(m[2]) / 255)),
      Math.min(1, Math.max(0, Number(m[3]) / 255)),
    ];
  }
  return null;
}

function isWhite(rgb) {
  return !!rgb && rgb[0] === 1 && rgb[1] === 1 && rgb[2] === 1;
}

/** 分块累积内容流，避免把几百 MB 的 PDF 操作符拼成一个巨大的 JS 字符串。 */
class ContentWriter {
  constructor(chunkChars = 1 << 20) {
    this.chunkChars = chunkChars;
    this.parts = [];
    this.chars = 0;
    this.chunks = [];
  }

  push(s) {
    if (!s) return;
    this.parts.push(s);
    this.chars += s.length;
    if (this.chars >= this.chunkChars) this.flush();
  }

  flush() {
    if (!this.parts.length) return;
    this.chunks.push(Buffer.from(this.parts.join(""), "utf8"));
    this.parts = [];
    this.chars = 0;
  }

  finish() {
    this.flush();
    return Buffer.concat(this.chunks);
  }
}

/** polyline 的 points → PDF "x y m / x y l ..."；有效点不足 2 个返回 null。 */
function polylineOps(points) {
  if (!points) return null;
  POINT_NUM_RE.lastIndex = 0;
  const parts = [];
  let x = 0;
  let hasX = false;
  let count = 0;
  let m;
  while ((m = POINT_NUM_RE.exec(points))) {
    const n = Number(m[0]);
    if (!Number.isFinite(n)) continue;
    if (!hasX) {
      x = n;
      hasX = true;
    } else {
      parts.push(`${fmt(x)} ${fmt(n)} ${count === 0 ? "m" : "l"}\n`);
      count++;
      hasX = false;
    }
  }
  return count >= 2 ? parts.join("") : null;
}

/**
 * path 的 d → PDF "m/l/h"。
 * 支持 M/L/Z（以及小写 m/l/z，cadcraft 某些后处理产物用小写 l）。
 * 出现 C/S/Q/T/A/H/V 等命令时返回 null（整条跳过），不做错误近似。
 */
function pathOps(d) {
  if (!d || UNSUPPORTED_PATH_CMD_RE.test(d)) return null;
  PATH_TOKEN_RE.lastIndex = 0;
  const parts = [];
  let cmd = null;
  let moveFirst = false;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let args = [];
  let m;
  while ((m = PATH_TOKEN_RE.exec(d))) {
    const t = m[0];
    if (t.length === 1 && /[MLZmlz]/.test(t)) {
      cmd = t;
      args = [];
      if (t === "Z" || t === "z") {
        parts.push("h\n");
        cx = sx;
        cy = sy;
      } else if (t === "M" || t === "m") {
        moveFirst = true;
      }
      continue;
    }
    const n = Number(t);
    if (!Number.isFinite(n)) continue;
    args.push(n);
    if (args.length < 2) continue;

    if (cmd === "M" || cmd === "m") {
      let x = args[0];
      let y = args[1];
      if (cmd === "m") {
        x += cx;
        y += cy;
      }
      cx = x;
      cy = y;
      if (moveFirst) {
        sx = cx;
        sy = cy;
        parts.push(`${fmt(cx)} ${fmt(cy)} m\n`);
        moveFirst = false;
      } else {
        parts.push(`${fmt(cx)} ${fmt(cy)} l\n`);
      }
      args = [];
    } else if (cmd === "L" || cmd === "l") {
      let x = args[0];
      let y = args[1];
      if (cmd === "l") {
        x += cx;
        y += cy;
      }
      cx = x;
      cy = y;
      parts.push(`${fmt(cx)} ${fmt(cy)} l\n`);
      args = [];
    } else {
      // 不认识的命令：丢掉数字，避免误画
      args = [];
    }
  }
  return parts.length ? parts.join("") : null;
}

/** circle → 4 段三次贝塞尔 */
function circleOps(cx, cy, r) {
  const kr = KAPPA * r;
  return (
    `${fmt(cx + r)} ${fmt(cy)} m\n` +
    `${fmt(cx + r)} ${fmt(cy + kr)} ${fmt(cx + kr)} ${fmt(cy + r)} ${fmt(cx)} ${fmt(cy + r)} c\n` +
    `${fmt(cx - kr)} ${fmt(cy + r)} ${fmt(cx - r)} ${fmt(cy + kr)} ${fmt(cx - r)} ${fmt(cy)} c\n` +
    `${fmt(cx - r)} ${fmt(cy - kr)} ${fmt(cx - kr)} ${fmt(cy - r)} ${fmt(cx)} ${fmt(cy - r)} c\n` +
    `${fmt(cx + kr)} ${fmt(cy - r)} ${fmt(cx + r)} ${fmt(cy - kr)} ${fmt(cx + r)} ${fmt(cy)} c\n` +
    "h\n"
  );
}

function readViewBox(svg) {
  const root = /<svg\b([^>]*)>/i.exec(svg);
  const attrs = root ? parseAttrs(root[1]) : {};
  if (attrs.viewBox) {
    const n = attrs.viewBox
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (n.length === 4 && n.every(Number.isFinite) && n[2] > 0 && n[3] > 0) {
      return { x: n[0], y: n[1], w: n[2], h: n[3] };
    }
  }
  // 没有 viewBox 时退回 width/height（不认识单位就放弃）
  const w = Number.parseFloat(attrs.width);
  const h = Number.parseFloat(attrs.height);
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
    return { x: 0, y: 0, w, h };
  }
  return null;
}

/** A3：短边 842、长边 1190；按图纸宽高比决定横/竖。 */
function pageSize(vbW, vbH) {
  const LONG = 1190;
  const SHORT = 842;
  return vbW >= vbH
    ? { w: LONG, h: SHORT, orientation: "landscape" }
    : { w: SHORT, h: LONG, orientation: "portrait" };
}

/**
 * 把 cadcraft SVG 转成 PDF 文件。
 * @param {string} svgPath
 * @param {string} pdfPath
 * @returns {{bytes:number, elements:number, circles:number, polylines:number, paths:number, pageWidth:number, pageHeight:number, orientation:string}}
 */
export function convertSvgToPdf(svgPath, pdfPath) {
  const svg = fs.readFileSync(svgPath, "utf8");
  const vb = readViewBox(svg);
  if (!vb) throw new Error("SVG 缺少可用的 viewBox/width/height");

  const page = pageSize(vb.w, vb.h);
  // 5% 边距（按页面短边算）
  const margin = Math.min(page.w, page.h) * 0.05;
  const k = Math.min((page.w - 2 * margin) / vb.w, (page.h - 2 * margin) / vb.h);
  if (!(k > 0) || !Number.isFinite(k)) throw new Error("SVG 尺寸无效");
  const tx = (page.w - k * vb.w) / 2 - k * vb.x;
  const ty = (page.h + k * vb.h) / 2 + k * vb.y;

  const writer = new ContentWriter();
  // 关键：所有几何都直接用 SVG 用户坐标；线宽也直接写 stroke-width，
  // PDF 会随 CTM 一起缩放，无需在主进程里手算。
  writer.push(
    `q\n${fmt(k)} 0 0 ${fmt(-k)} ${fmt(tx)} ${fmt(ty)} cm\n1 J 1 j\n`
  );

  /** opacity → ExtGState 名；同值复用 */
  const gsMap = new Map();
  const gsName = (op) => {
    const key = fmt(op);
    let name = gsMap.get(key);
    if (!name) {
      name = `GS${gsMap.size}`;
      gsMap.set(key, name);
    }
    return name;
  };

  let elements = 0;
  let circles = 0;
  let polylines = 0;
  let paths = 0;

  ELEMENT_RE.lastIndex = 0;
  let m;
  while ((m = ELEMENT_RE.exec(svg))) {
    elements++;
    const tag = m[1];
    let attrs;
    try {
      attrs = parseAttrs(m[2]);
    } catch {
      continue; // 单个元素属性坏掉：跳过
    }

    try {
      const opacity = Number.parseFloat(attrs.opacity);
      const hasOpacity = Number.isFinite(opacity) && opacity >= 0 && opacity < 1;
      const fill = parseColor(attrs.fill);
      const stroke = parseColor(attrs.stroke);
      const doFill = !!fill && !isWhite(fill);
      const doStroke = !!stroke;
      if (!doFill && !doStroke) continue;

      if (hasOpacity) writer.push(`/${gsName(opacity)} gs\n`);

      if (tag === "polyline") {
        const ops = polylineOps(attrs.points);
        if (!ops) continue;
        if (doFill) {
          const [r, g, b] = fill;
          writer.push(`${fmt(r)} ${fmt(g)} ${fmt(b)} rg\n`);
        }
        if (doStroke) {
          const [r, g, b] = stroke;
          const width = Number.parseFloat(attrs["stroke-width"]);
          writer.push(
            `${fmt(r)} ${fmt(g)} ${fmt(b)} RG\n${fmt(
              Number.isFinite(width) ? width : 1
            )} w\n`
          );
        }
        writer.push(ops);
        writer.push(doFill && doStroke ? "B\n" : doFill ? "f\n" : "S\n");
        polylines++;
      } else if (tag === "path") {
        const ops = pathOps(attrs.d);
        if (!ops) continue;
        if (doFill) {
          const [r, g, b] = fill;
          writer.push(`${fmt(r)} ${fmt(g)} ${fmt(b)} rg\n`);
        }
        if (doStroke) {
          const [r, g, b] = stroke;
          const width = Number.parseFloat(attrs["stroke-width"]);
          writer.push(
            `${fmt(r)} ${fmt(g)} ${fmt(b)} RG\n${fmt(
              Number.isFinite(width) ? width : 1
            )} w\n`
          );
        }
        writer.push(ops);
        writer.push(doFill && doStroke ? "B\n" : doFill ? "f\n" : "S\n");
        paths++;
      } else {
        // circle
        const cx = Number.parseFloat(attrs.cx);
        const cy = Number.parseFloat(attrs.cy);
        const r = Number.parseFloat(attrs.r);
        if (![cx, cy, r].every(Number.isFinite) || r <= 0) continue;
        if (doFill) {
          const [rr, gg, bb] = fill;
          writer.push(`${fmt(rr)} ${fmt(gg)} ${fmt(bb)} rg\n`);
        }
        if (doStroke) {
          const [rr, gg, bb] = stroke;
          const width = Number.parseFloat(attrs["stroke-width"]);
          writer.push(
            `${fmt(rr)} ${fmt(gg)} ${fmt(bb)} RG\n${fmt(
              Number.isFinite(width) ? width : 1
            )} w\n`
          );
        }
        writer.push(circleOps(cx, cy, r));
        writer.push(doFill && doStroke ? "B\n" : doFill ? "f\n" : "S\n");
        circles++;
      }
    } catch {
      // 单个元素异常：跳过，继续导出
    }
  }
  writer.push("Q\n");

  const content = writer.finish();
  const compressed = zlib.deflateSync(content);

  let gsDict = "";
  for (const [op, name] of gsMap) {
    gsDict += `/${name} << /Type /ExtGState /ca ${op} /CA ${op} >> `;
  }
  const resources = gsDict ? `<< /ExtGState << ${gsDict}>> >>` : "<< >>";

  // ---- 手写 PDF ----
  const header = Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1");
  const chunks = [header];
  const offsets = [];
  let offset = header.length;

  const addObj = (num, body) => {
    const b = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
    offsets[num] = offset;
    const pre = Buffer.from(`${num} 0 obj\n`, "utf8");
    const post = Buffer.from("\nendobj\n", "utf8");
    chunks.push(pre, b, post);
    offset += pre.length + b.length + post.length;
  };

  addObj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  addObj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  addObj(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(page.w)} ${fmt(
      page.h
    )}] /Contents 4 0 R /Resources ${resources} >>`
  );

  const streamHead = Buffer.from(
    `<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`,
    "utf8"
  );
  const streamTail = Buffer.from("\nendstream", "utf8");
  addObj(4, Buffer.concat([streamHead, compressed, streamTail]));

  const objectCount = 5; // 1..4 + 空闲项 0
  const xrefOffset = offset;
  let xref = `xref\n0 ${objectCount}\n0000000000 65535 f \n`;
  for (let i = 1; i < objectCount; i++) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${objectCount} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  chunks.push(Buffer.from(xref + trailer, "utf8"));

  const pdf = Buffer.concat(chunks);
  fs.writeFileSync(pdfPath, pdf);

  return {
    bytes: pdf.length,
    elements,
    circles,
    polylines,
    paths,
    pageWidth: page.w,
    pageHeight: page.h,
    orientation: page.orientation,
  };
}
