/**
 * 构建单文件 EXE：把便携包 zip 嵌进一个自包含启动器，产出
 *   release/CADViewer-<version>-win64.exe
 *
 * 前置：先跑 node scripts/build-portable.mjs（需要那个 zip）
 * 依赖：dotnet SDK 8+（用于编译启动器；产物本身不依赖 .NET，用户机器无需安装）
 *
 *   node scripts/build-sfx.mjs
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ver = JSON.parse(fs.readFileSync(path.join(ROOT, "server/package.json"), "utf8")).version;
const zip = path.join(ROOT, "release", `CADViewer-${ver}-win64.zip`);
const outDir = path.join(ROOT, "release", "sfx");
const exe = path.join(ROOT, "release", `CADViewer-${ver}-win64.exe`);

if (!fs.existsSync(zip)) {
  console.error(`缺少 ${path.relative(ROOT, zip)}，先运行: node scripts/build-portable.mjs`);
  process.exit(1);
}

console.log(`[1/2] dotnet publish（把 ${(fs.statSync(zip).size / 1048576).toFixed(1)} MB 包嵌进 exe）…`);
execFileSync(
  "dotnet",
  [
    "publish",
    path.join(ROOT, "scripts/SfxLauncher/SfxLauncher.csproj"),
    "-c", "Release",
    "-r", "win-x64",
    "--self-contained", "true",
    "-p:PublishSingleFile=true",
    `-p:PayloadPath=${zip}`,
    "-o", outDir,
  ],
  { stdio: "inherit", cwd: ROOT }
);

console.log("[2/2] 产出");
fs.copyFileSync(path.join(outDir, "CADViewer.exe"), exe);
const size = fs.statSync(exe).size;
const sha = crypto.createHash("sha256").update(fs.readFileSync(exe)).digest("hex");
console.log(`  ${path.relative(ROOT, exe)}`);
console.log(`  ${(size / 1048576).toFixed(1)} MB`);
console.log(`  SHA256 ${sha}`);
