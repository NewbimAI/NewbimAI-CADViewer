/**
 * 生成「轻量 Skill 包」：只含 Skill 文档 + CLI 实际 import 的 4 个 server 模块。
 *
 *   node scripts/build-skill.mjs
 *   → release/cadviewer-skill-<version>.zip   （约 60KB，解压约 153KB）
 *
 * 为什么可以这么小：cad.mjs 只动态 import cadcraft.js / scanner.js / tch-detect.js /
 * svg-pdf.js，四个模块只依赖 Node 内置库，彼此不 import。web/、字体、前端构建产物
 * 全都用不到。
 *
 * 代价（必须在说明里写清）：
 *   · `serve`（起界面）不可用——它需要完整项目的 start.bat + web/dist；
 *   · DWG 转换仍需自己准备 bin/cadcraft/（约 57MB 下载，解压 127MB）。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ver = JSON.parse(fs.readFileSync(path.join(ROOT, "server/package.json"), "utf8")).version;
const NAME = `cadviewer-skill-${ver}`;
const STAGE = path.join(ROOT, "release", "skill", NAME);
const ZIP = path.join(ROOT, "release", `${NAME}.zip`);

const MODULES = ["cadcraft.js", "scanner.js", "tch-detect.js", "svg-pdf.js"];

fs.rmSync(STAGE, { recursive: true, force: true });
fs.rmSync(ZIP, { force: true });
fs.mkdirSync(path.join(STAGE, "server"), { recursive: true });

fs.cpSync(path.join(ROOT, "Skill"), path.join(STAGE, "Skill"), { recursive: true });
for (const m of MODULES) {
  fs.copyFileSync(path.join(ROOT, "server", m), path.join(STAGE, "server", m));
}

fs.writeFileSync(
  path.join(STAGE, "轻量版说明.txt"),
  `CADViewer Skill ${ver}（轻量包）

这个包只包含 agent 用的命令行 Skill，以及它实际依赖的 4 个服务端模块
（cadcraft.js / scanner.js / tch-detect.js / svg-pdf.js）。

能做什么（不需要浏览器、不需要前端）
  summary / stats / layers / blocks / text / tch
  export --to json | dxf        （DXF 输入时连 cadcraft 都不需要）
  export --to dwg→dxf 等        （需要 bin/cadcraft/，见下）

不能做什么
  · serve（启动图形界面）：它依赖完整项目的 start.bat 与 web/dist，
    轻量包里没有。要交互看图，请用完整版：
    https://github.com/NewbimAI/NewbimAI-CADViewer/releases

怎么用（两步）
  1) 需要 Node.js 20+（这是唯一的必需运行时；DXF 统计不再需要别的东西）
  2) 注册到 agent —— 会自动识别 OpenCode / Claude Code / Cursor：
       Windows    : powershell -ExecutionPolicy Bypass -File Skill\install.ps1
       macOS/Linux: bash Skill/install.sh
     装完不需要设置任何环境变量（CLI 从自身位置就能找到本包）。

  不注册也能直接用（cwd 在哪都行，不需要 --root）：
       node <本包>/Skill/cadviewer/scripts/cad.mjs summary 图纸.dxf

  3) 开 DWG（可选）：从 https://github.com/storytold/cadcraft/releases 下载
     cadcraft-<版本>-windows-x64-portable.zip，解压到 <本包>/bin/cadcraft/，
     使 <本包>/bin/cadcraft/**/cadcraft-cli.exe 存在，再跑 doctor 确认。

许可：AGPL-3.0-only（见仓库 LICENSE）；商业许可 nbimgpt@163.com
`,
  "utf8"
);

try {
  execFileSync("tar.exe", ["-a", "-c", "-f", ZIP, "-C", path.join(ROOT, "release", "skill"), NAME], { stdio: "inherit" });
} catch {
  execFileSync("powershell", ["-NoProfile", "-Command",
    `Compress-Archive -Path '${STAGE}' -DestinationPath '${ZIP}' -CompressionLevel Optimal`], { stdio: "inherit" });
}

const dirSize = (d) => {
  let n = 0;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    n += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return n;
};
console.log(`\n  目录: ${STAGE}`);
console.log(`  解压: ${(dirSize(STAGE) / 1024).toFixed(0)} KB`);
console.log(`  压缩: ${ZIP}`);
console.log(`  大小: ${(fs.statSync(ZIP).size / 1024).toFixed(0)} KB`);
