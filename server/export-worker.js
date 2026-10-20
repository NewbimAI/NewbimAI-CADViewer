/**
 * 导出子进程：cadcraft convert → SVG → 自研 SVG→PDF。
 *
 * 参数：[源 DXF, out.svg, out.pdf, cadcraft-cli 路径, window JSON 或 null, SVG 上限字节数]
 * 主进程只等 IPC，不参与重 CPU 的解析/压缩。
 */
import fs from "node:fs";
import { CadcraftCli } from "./cadcraft.js";
import { convertSvgToPdf } from "./svg-pdf.js";

const [src, outSvg, outPdf, cliPath, windowJson, maxSvgBytesRaw] =
  process.argv.slice(2);

const maxSvgBytes = Number(maxSvgBytesRaw) || 0;

function cleanup() {
  for (const p of [outSvg, outPdf]) {
    try {
      fs.rmSync(p, { force: true });
    } catch {
      /* ignore */
    }
  }
}

try {
  if (!src || !fs.existsSync(src)) throw new Error("缺少可用的 DXF 源文件");
  if (!cliPath || !fs.existsSync(cliPath)) throw new Error("cadcraft-cli 未找到");

  let window = null;
  if (windowJson && windowJson !== "null") {
    try {
      window = JSON.parse(windowJson);
    } catch {
      window = null; // window 只影响裁剪范围，坏了就退回全图
    }
  }

  const cli = new CadcraftCli(cliPath);
  const t0 = Date.now();
  await cli.convertToSvg(src, outSvg, window);
  const svgMs = Date.now() - t0;
  const svgBytes = fs.statSync(outSvg).size;

  if (maxSvgBytes > 0 && svgBytes > maxSvgBytes) {
    cleanup();
    process.send({
      type: "error",
      code: "TOO_LARGE",
      error: "图纸过大，暂不支持矢量 PDF 导出",
    });
    process.exitCode = 0;
  } else {
    const t1 = Date.now();
    const stats = convertSvgToPdf(outSvg, outPdf);
    const pdfMs = Date.now() - t1;
    process.send({
      type: "done",
      stats: { ...stats, svgBytes, svgMs, pdfMs },
    });
  }
} catch (e) {
  cleanup();
  process.send({
    type: "error",
    error: e instanceof Error ? e.message : String(e),
  });
  process.exitCode = 1;
}
