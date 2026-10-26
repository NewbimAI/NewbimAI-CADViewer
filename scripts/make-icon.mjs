/**
 * 由 scripts/SfxLauncher/icon/app-icon-*.png 生成 scripts/SfxLauncher/app.ico（多尺寸）。
 *
 * 图标源文件是设计师按尺寸导出的（32/48/64/128/256/1024），小尺寸是专门优化过的，
 * 所以**优先直接用对应尺寸的 PNG**，只有 16/24 从 32 缩（没有更小的源）。
 *
 *   npm i sharp --no-save     # 仅构建期依赖，不进产品
 *   node scripts/make-icon.mjs
 */
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ICON_DIR = path.join(ROOT, "scripts/SfxLauncher/icon");
const OUT = path.join(ROOT, "scripts/SfxLauncher/app.ico");

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };
const spec = [
  { size: 16, from: 32 },
  { size: 24, from: 32 },
  { size: 32, from: 32 },
  { size: 48, from: 48 },
  { size: 64, from: 64 },
  { size: 128, from: 128 },
  { size: 256, from: 256 },
];

const pngs = [];
for (const { size, from } of spec) {
  const src = path.join(ICON_DIR, `app-icon-${from}.png`);
  if (!fs.existsSync(src)) throw new Error(`缺少图标源: ${src}`);
  const buf = await sharp(src)
    .resize(size, size, { fit: "contain", background: TRANSPARENT })
    .png({ compressionLevel: 9 })
    .toBuffer();
  pngs.push({ size, buf });
  console.log(`  ${String(size).padStart(3)}x${String(size).padEnd(3)}  <- app-icon-${from}.png  ${(buf.length / 1024).toFixed(1)} KB`);
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
  entries.writeUInt8(p.size >= 256 ? 0 : p.size, e + 0);
  entries.writeUInt8(p.size >= 256 ? 0 : p.size, e + 1);
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
