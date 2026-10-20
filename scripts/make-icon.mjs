/**
 * 由 web/public/logo.svg 生成 scripts/SfxLauncher/app.ico（多尺寸，白底圆角）。
 *
 * 图标是构建产物但需要进仓库（csproj 的 ApplicationIcon 要用它），
 * logo 改了就跑一次这个脚本重新生成。
 *
 *   npm i sharp --no-save     # 仅构建期依赖，不进产品
 *   node scripts/make-icon.mjs
 */
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "web/public/logo.svg");
const OUT = path.join(ROOT, "scripts/SfxLauncher/app.ico");

const raw = fs.readFileSync(SRC, "utf8");
const inner = raw
  .replace(/<title>[\s\S]*?<\/title>/g, "")
  .replace(/^[\s\S]*?<svg[^>]*>/, "")
  .replace(/<\/svg>\s*$/, "");

// 白底圆角 + 浅描边：深色任务栏上也看得清
const buildSvg = (s) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-3 -3 38 38" width="${s}" height="${s}">
  <rect x="-3" y="-3" width="38" height="38" rx="8.5" fill="#ffffff"/>
  <rect x="-2.65" y="-2.65" width="37.3" height="37.3" rx="8.15" fill="none" stroke="#d0d0d0" stroke-width="0.7"/>
  ${inner}
</svg>`;

const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = [];
for (const s of sizes) {
  const buf = await sharp(Buffer.from(buildSvg(s))).png({ compressionLevel: 9 }).toBuffer();
  pngs.push({ s, buf });
  console.log(`  ${String(s).padStart(3)}x${String(s).padEnd(3)}  ${(buf.length / 1024).toFixed(1)} KB`);
}

const count = pngs.length;
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(count, 4);

const entries = Buffer.alloc(16 * count);
let offset = 6 + 16 * count;
pngs.forEach((p, i) => {
  const e = 16 * i;
  entries.writeUInt8(p.s >= 256 ? 0 : p.s, e + 0);
  entries.writeUInt8(p.s >= 256 ? 0 : p.s, e + 1);
  entries.writeUInt8(0, e + 2);
  entries.writeUInt8(0, e + 3);
  entries.writeUInt16LE(1, e + 4);
  entries.writeUInt16LE(32, e + 6);
  entries.writeUInt32LE(p.buf.length, e + 8);
  entries.writeUInt32LE(offset, e + 12);
  offset += p.buf.length;
});

fs.writeFileSync(OUT, Buffer.concat([header, entries, ...pngs.map((p) => p.buf)]));
console.log(`\n  -> ${path.relative(ROOT, OUT)}  ${(fs.statSync(OUT).size / 1024).toFixed(1)} KB  (${count} 个尺寸)`);
