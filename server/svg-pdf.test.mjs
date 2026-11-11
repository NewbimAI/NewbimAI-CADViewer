/**
 * server/svg-pdf.js 单测（v67 新增）：
 *   A 题「导出的 PDF 必须是矢量」的回归门槛 + 取景/精度两个实测 bug。
 *
 * 背景（实测，勿删）：
 *   · cadcraft 的 SVG 只有 polyline/path/circle，没有 <image>/<text>；
 *     PDF 由 svg-pdf.js 手写内容流，理应没有任何位图 XObject —— 这里用结构断言锁住；
 *   · 旧代码把 CTM 的比例 k 用 fmt(4 位小数) 写盘：k=0.00175389 → "0.0018"，
 *     比例误差 +2.63%，图形被放大推出页面（智能化图纸右侧版面被裁）；
 *   · 框外元素（远离主图的版面副本/飞点）旧代码照画，会溢出页面。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { convertSvgToPdf } from "./svg-pdf.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cadviewer-svgpdf-"));

function writeSvg(dir, body, viewBox = "0 0 100 100") {
  const p = path.join(dir, "in.svg");
  fs.writeFileSync(
    p,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="1600" height="908">` +
      `<rect width="100%" height="100%" fill="white"/>${body}</svg>`,
    "utf8"
  );
  return p;
}

/** 解出 PDF 唯一内容流（svg-pdf 的产物固定 1 页 / 1 条 Flate 流） */
function contentStream(pdf) {
  const buf = fs.readFileSync(pdf);
  const s = buf.toString("latin1");
  const kw = s.indexOf("stream");
  let start = kw + "stream".length;
  while (buf[start] === 0x0d || buf[start] === 0x0a) start++;
  const end = s.indexOf("endstream", start);
  const raw = buf.subarray(start, end);
  try {
    return zlib.inflateSync(raw).toString("latin1");
  } catch {
    return raw.toString("latin1");
  }
}

test("A: 产物是纯矢量 PDF（无 image XObject / 无字体 / 有 m-l 绘制操作）", () => {
  const dir = tmp();
  const svg = writeSvg(
    dir,
    '<polyline fill="none" stroke="#00ff00" stroke-width="1" points="10,10 90,10 90,90"/>' +
      '<path fill="#ff0000" d="M20 20L30 20L30 30Z"/>' +
      '<circle cx="50" cy="50" r="5" fill="#0000ff"/>'
  );
  const pdf = path.join(dir, "out.pdf");
  const stats = convertSvgToPdf(svg, pdf);
  assert.equal(stats.polylines, 1);
  assert.equal(stats.paths, 1);
  assert.equal(stats.circles, 1);

  const buf = fs.readFileSync(pdf);
  const latin = buf.toString("latin1");
  assert.equal(/\/Subtype\s*\/Image/.test(latin), false, "不能出现位图 XObject");
  assert.equal(/\/Font\b/.test(latin), false, "文字是路径，不应内嵌字体");
  assert.equal(/\/XObject\b/.test(latin), false, "不应有 XObject");
  assert.match(latin, /^%PDF-1\.4/);

  const content = contentStream(pdf);
  const moves = (content.match(/(?:^|\s)m(?=\s)/g) || []).length;
  const lines = (content.match(/(?:^|\s)l(?=\s)/g) || []).length;
  const curves = (content.match(/(?:^|\s)c(?=\s)/g) || []).length;
  assert.ok(moves >= 3, `应有 m 操作符，实际 ${moves}`);
  assert.ok(lines >= 2, `应有 l 操作符，实际 ${lines}`);
  assert.ok(curves >= 4, "circle 应转成 4 段贝塞尔 c");
  assert.equal(/\bBI\b/.test(content), false, "不能有内联位图 BI");
  assert.equal(/\bDo\b/.test(content), false, "不能有 XObject 绘制 Do");
});

test("A: CTM 比例不按 4 位小数舍入（旧 bug：0.00175389 → 0.0018，误差 +2.63%）", () => {
  const dir = tmp();
  const svg = writeSvg(
    dir,
    '<polyline fill="none" stroke="#000000" stroke-width="1" points="0,0 630498,357898"/>',
    "0 0 630498.404302 357898.934012"
  );
  const pdf = path.join(dir, "out.pdf");
  const stats = convertSvgToPdf(svg, pdf);

  // (1190 - 2*42.1) / 630498.404302 = 0.001753850…
  assert.ok(
    Math.abs(stats.scale - 0.0017538505925707897) < 1e-12,
    `取景比例应保持全精度，实际 ${stats.scale}`
  );
  const content = contentStream(pdf);
  assert.ok(content.includes("0.0017538506"), "矩阵里应写入高精度 k");
  assert.equal(content.includes("0.0018 0 0"), false, "不得再出现 4 位舍入后的 0.0018");
});

test("A: 框外元素（版面副本/飞点）不画，且内容被裁剪在 viewBox 内", () => {
  const dir = tmp();
  const svg = writeSvg(
    dir,
    '<polyline fill="none" stroke="#000000" stroke-width="1" points="0,0 100,100"/>' +
      '<polyline fill="none" stroke="#ff0000" stroke-width="1" points="9000,9000 9100,9100"/>' +
      '<polyline fill="none" stroke="#00ff00" stroke-width="1" points="-50000,50 -40000,60"/>'
  );
  const pdf = path.join(dir, "out.pdf");
  const stats = convertSvgToPdf(svg, pdf);
  assert.equal(stats.skippedOutside, 2, "两条完全在框外的折线必须剪掉");

  const content = contentStream(pdf);
  assert.equal(content.includes("9000"), false);
  assert.equal(content.includes("-50000"), false);
  assert.ok(/\bW\b/.test(content) && /\bn\b/.test(content), "应有裁剪路径 re W n");
  assert.ok(/\bre\b/.test(content), "裁剪区域应写成矩形 re");
});

test("A: 超大 SVG 明确抛 TOO_LARGE（路由据此返回 413，而不是 500 + ERR_STRING_TOO_LONG）", () => {
  const dir = tmp();
  const p = path.join(dir, "huge.svg");
  // 稀疏文件：只写大小，不占磁盘
  const fd = fs.openSync(p, "w");
  fs.ftruncateSync(fd, 470 * 1024 * 1024);
  fs.closeSync(fd);
  let err = null;
  try {
    convertSvgToPdf(p, path.join(dir, "huge.pdf"));
  } catch (e) {
    err = e;
  }
  assert.ok(err, "必须抛错");
  assert.equal(err.code, "TOO_LARGE");
  assert.match(err.message, /图纸过大/);
  assert.equal(fs.existsSync(path.join(dir, "huge.pdf")), false, "不能留下半成品 PDF");
});

test("A: viewBox 缺失时明确报错（不产出坏 PDF）", () => {
  const dir = tmp();
  const p = path.join(dir, "bad.svg");
  fs.writeFileSync(p, "<svg><rect/></svg>", "utf8");
  assert.throws(() => convertSvgToPdf(p, path.join(dir, "bad.pdf")), /viewBox/);
});

test("A: 上千条折线仍是矢量（内容流体积可控、无位图）", () => {
  const dir = tmp();
  const parts = [];
  for (let i = 0; i < 1200; i++) {
    const y = (i % 100) + 0.5;
    parts.push(
      `<polyline fill="none" stroke="#336699" stroke-width="0.2" points="${i % 10},${y} ${(i % 10) + 5},${y + 1}"/>`
    );
  }
  const svg = writeSvg(dir, parts.join(""));
  const pdf = path.join(dir, "out.pdf");
  const stats = convertSvgToPdf(svg, pdf);
  assert.equal(stats.polylines, 1200);
  const latin = fs.readFileSync(pdf).toString("latin1");
  assert.equal(/\/Subtype\s*\/Image/.test(latin), false);
  const content = contentStream(pdf);
  assert.ok((content.match(/(?:^|\s)m(?=\s)/g) || []).length >= 1200);
});
