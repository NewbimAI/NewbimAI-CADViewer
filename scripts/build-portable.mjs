/**
 * 构建 Windows 免安装便携包。
 *
 *   node scripts/build-portable.mjs
 *
 * 产物：release/CADViewer-<version>-win64/  和  release/CADViewer-<version>-win64.zip
 *
 * 包内自带便携版 node.exe，用户无需安装 Node.js；cadcraft 也内置，DWG 直接可用。
 * 目标机器：Windows 10/11 x64。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "server/package.json"), "utf8"));
const VERSION = pkg.version;
const NAME = `CADViewer-${VERSION}-win64`;
const OUT = path.join(ROOT, "release", NAME);
const ZIP = path.join(ROOT, "release", `${NAME}.zip`);
const CACHE = path.join(ROOT, "release", ".cache");

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const dirSize = (dir) => {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else total += fs.statSync(p).size;
  }
  return total;
};
const step = (s) => console.log(`\n[${s}]`);

// ---------------------------------------------------------------- 1. 便携 node
step("1/6 便携版 Node.js");
fs.mkdirSync(CACHE, { recursive: true });

const shasums = await (await fetch("https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt")).text();
const line = shasums.split("\n").find((l) => /node-v\d+\.\d+\.\d+-win-x64\.zip$/.test(l.trim()));
if (!line) throw new Error("SHASUMS256.txt 里没找到 win-x64 zip");
const [hash, zipName] = line.trim().split(/\s+/);
const nodeZip = path.join(CACHE, zipName);
console.log(`  版本: ${zipName}`);

if (!fs.existsSync(nodeZip) || crypto.createHash("sha256").update(fs.readFileSync(nodeZip)).digest("hex") !== hash) {
  console.log("  下载中…");
  const buf = Buffer.from(await (await fetch(`https://nodejs.org/dist/latest-v22.x/${zipName}`)).arrayBuffer());
  const got = crypto.createHash("sha256").update(buf).digest("hex");
  if (got !== hash) throw new Error(`SHA256 校验失败: ${got}`);
  fs.writeFileSync(nodeZip, buf);
  console.log(`  已下载 ${mb(buf.length)}，SHA256 校验通过`);
} else {
  console.log("  缓存命中，SHA256 校验通过");
}

// ---------------------------------------------------------------- 2. 目录骨架
step("2/6 目录骨架");
fs.rmSync(OUT, { recursive: true, force: true });
fs.rmSync(ZIP, { force: true });
for (const d of ["server", "web", "bin", "node", "data"]) fs.mkdirSync(path.join(OUT, d), { recursive: true });

// ---------------------------------------------------------------- 3. 拷源码
step("3/6 拷服务端 / 前端产物 / cadcraft");
const copy = (from, to) => fs.cpSync(from, to, { recursive: true });
for (const f of fs.readdirSync(path.join(ROOT, "server"))) {
  if (!f.endsWith(".js") && !f.endsWith(".bat") && !f.endsWith(".json")) continue;
  if (f === "package-lock.json") continue; // 用 OUT 里重新解析的那份
  fs.copyFileSync(path.join(ROOT, "server", f), path.join(OUT, "server", f));
}
fs.copyFileSync(path.join(ROOT, "server/package-lock.json"), path.join(OUT, "server/package-lock.json"));
copy(path.join(ROOT, "web/dist"), path.join(OUT, "web/dist"));
copy(path.join(ROOT, "bin/cadcraft"), path.join(OUT, "bin/cadcraft"));
for (const f of ["LICENSE", "THIRD-PARTY.md", "README.md", "CLA.md"]) {
  if (fs.existsSync(path.join(ROOT, f))) fs.copyFileSync(path.join(ROOT, f), path.join(OUT, f));
}

// ---------------------------------------------------------------- 4. 只装生产依赖
step("4/6 安装生产依赖（--omit=dev）");
execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], {
  cwd: path.join(OUT, "server"),
  stdio: "inherit",
  shell: process.platform === "win32",
});

// ---------------------------------------------------------------- 5. 解 node.exe + 写启动器
step("5/6 解出 node.exe + 写启动脚本与说明");
const tmp = path.join(CACHE, "node-extract");
fs.rmSync(tmp, { recursive: true, force: true });
execFileSync("powershell", [
  "-NoProfile", "-Command",
  `Expand-Archive -LiteralPath '${nodeZip}' -DestinationPath '${tmp}' -Force`,
], { stdio: "inherit" });
const inner = fs.readdirSync(tmp).find((d) => d.startsWith("node-v"));
fs.copyFileSync(path.join(tmp, inner, "node.exe"), path.join(OUT, "node", "node.exe"));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`  node.exe ${mb(fs.statSync(path.join(OUT, "node", "node.exe")).size)}`);

fs.writeFileSync(path.join(OUT, "start.bat"), `@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo   CADViewer ${VERSION} - 便携版（免安装）
echo   图纸只在本机处理，不上传任何服务器
echo ============================================
echo.

if not exist "node\\node.exe" (
  echo [ERROR] node\\node.exe 缺失，请重新解压完整压缩包。
  pause
  exit /b 1
)
if not exist "web\\dist\\index.html" (
  echo [ERROR] web\\dist 缺失，请重新解压完整压缩包。
  pause
  exit /b 1
)
if not exist "bin\\cadcraft" (
  echo [WARN] bin\\cadcraft 缺失：DXF 仍可查看，DWG 无法打开。
  echo.
)

set "PATH=%~dp0node;%PATH%"
echo 服务地址: http://127.0.0.1:3717
echo 关闭此窗口即退出。
echo.
start "" http://127.0.0.1:3717
pushd server
"%~dp0node\\node.exe" index.js
popd
`, "utf8");

fs.writeFileSync(path.join(OUT, "使用说明.txt"), `CADViewer ${VERSION} 便携版（Windows 10/11 x64）

一、怎么用
  1. 把整个文件夹解压到任意位置（路径含中文也可以，但不要放在只读目录）。
  2. 双击 start.bat，浏览器会自动打开 http://127.0.0.1:3717 。
  3. 点右上「打开图纸」选 DWG 或 DXF；也可以直接把文件拖进窗口。
  4. 用完关掉黑色命令行窗口即可，不残留后台进程。

二、不用安装什么
  本包已自带 Node.js 运行时与 DWG 转换器（cadcraft），
  不需要装 Node、不需要联网、不需要管理员权限。

三、隐私
  服务只监听 127.0.0.1，图纸在本机转换与渲染，不会上传。
  你看过的图纸原件保存在 data\\uploads\\ 下（内容哈希命名），
  默认保留 30 天；想立刻清空，直接删掉该目录里的文件即可。

四、常见问题
  · 端口被占用：在 server 目录下执行 set PORT=3727 再运行 start.bat（或改 start.bat）。
  · 想换数据目录：设置环境变量 CADVIEWER_DATA 指向别的盘。
  · 杀毒软件拦截：本包未签名，首次运行可能提示，允许即可。

五、许可
  AGPL-3.0-only，见 LICENSE；商业许可联系 nbimgpt@163.com。
  第三方组件许可见 THIRD-PARTY.md。
`, "utf8");

// ---------------------------------------------------------------- 6. 压缩
step("6/6 压缩");
const before = dirSize(OUT);
try {
  execFileSync("tar.exe", ["-a", "-c", "-f", ZIP, "-C", path.join(ROOT, "release"), NAME], { stdio: "inherit" });
} catch {
  execFileSync("powershell", ["-NoProfile", "-Command",
    `Compress-Archive -Path '${OUT}' -DestinationPath '${ZIP}' -CompressionLevel Optimal`], { stdio: "inherit" });
}
const zipped = fs.statSync(ZIP).size;

console.log(`\n=== 完成 ===`);
console.log(`  目录: ${OUT}`);
console.log(`  大小: ${mb(before)}`);
console.log(`  压缩: ${ZIP}`);
console.log(`  大小: ${mb(zipped)}`);
console.log(`\n  cadcraft : ${mb(dirSize(path.join(OUT, "bin/cadcraft")))}`);
console.log(`  web/dist : ${mb(dirSize(path.join(OUT, "web/dist")))}`);
console.log(`  server   : ${mb(dirSize(path.join(OUT, "server")))}`);
