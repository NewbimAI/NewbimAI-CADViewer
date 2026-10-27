/**
 * 生成「轻量 Skill 包」：Skill 文档 + CLI 实际 import 的 4 个 server 模块 + 服务端清单。
 *
 *   node scripts/build-skill.mjs
 *   → release/cadviewer-skill-<version>.zip   （约 90KB，解压约 250KB）
 *
 * 为什么可以这么小：cad.mjs 只动态 import cadcraft.js / scanner.js / tch-detect.js /
 * svg-pdf.js，四个模块只依赖 Node 内置库，彼此不 import。web/、字体、前端构建产物
 * 都不进包——**安装时由 install.ps1 / install.sh 自动下载补全**。
 *
 * 装完为什么是完整功能：
 *   安装脚本发现缺 server/index.js 或 web/dist/index.html 时，会从发布仓库取回
 *   对应的 tag 归档（约 18MB），把 server/*.js 与 web/dist 复制进包内目录，于是
 *   open（生成链接 + 起界面）、PNG/PDF 导出、图块文字展开全部可用。
 *   package.json / package-lock.json 随包分发，serve 首次启动时自动 npm ci。
 *
 * 仍然需要联网（或事后补）：cadcraft 转换器（约 57MB，DWG 与 png/pdf 导出用）。
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

// CLI 直接 import 的模块 + 服务端清单（清单用于版本号与 npm ci）
const MODULES = [
  "cadcraft.js",
  "scanner.js",
  "tch-detect.js",
  "svg-pdf.js",
  "package.json",
  "package-lock.json",
];

fs.rmSync(STAGE, { recursive: true, force: true });
fs.rmSync(ZIP, { force: true });
fs.mkdirSync(path.join(STAGE, "server"), { recursive: true });

fs.cpSync(path.join(ROOT, "Skill"), path.join(STAGE, "Skill"), { recursive: true });
for (const m of MODULES) {
  fs.copyFileSync(path.join(ROOT, "server", m), path.join(STAGE, "server", m));
}

fs.writeFileSync(
  path.join(STAGE, "使用说明.txt"),
  `CADViewer Skill ${ver}（轻量包 · 安装时自动补全）

一、这个包为什么小
  包内只有两样东西：agent 用的命令行 Skill（含 cad.mjs），
  以及它实际 import 的 4 个服务端模块 + 服务端清单。
  界面、服务端全量代码、DWG 转换器都不在包里，**安装时自动下载补回来**——
  所以包只有几百 KB，可以上传到有 3MB 限制的 agent（WorkBuddy 等），
  装完却是完整功能。

二、对方需要什么
  · Windows 10/11 x64（macOS / Linux 只能做 DXF 只读）
  · Node.js 20+：https://nodejs.org       ← 唯一需要自己装的东西
  · 联网（安装时要下载组件）

三、怎么装（一条命令，装完即止）
  1) 解压到一个**固定位置**（建议 D:\\CADViewer；装完不能随便移动/删除，注册用的是目录联接）
  2) 在该目录执行：
       powershell -ExecutionPolicy Bypass -File Skill\\install.ps1
     它会依次完成：
       · 把 Skill 注册到 agent 的 skills 目录（OpenCode / Claude Code / Cursor）
       · 下载并解压 cadcraft 转换器（约 57MB，DWG 用）
       · 下载界面 + 服务端（约 18MB），补回 web/dist 与 server/*.js
       · 跑 doctor 自检并打印结果
     看到 doctor: ok 就装完了，**不需要再拿图纸验证**。

四、装完能做什么（完整功能）
  · open：DWG→DXF → 起本地服务（后台静默，不弹窗）→ 返回可直接打开的链接
  · serve：只确保服务在跑；close：立即停服（空闲 30 分钟也会自动退出）
  · readout：一次拿全量 JSON（实体/图层/块/文字/范围/天正），读数据不用截图
  · export --to dxf|json|pdf|png|svg：导出原始 DXF、数据、矢量 PDF、图片
  · summary / stats / layers / blocks / text / tch：单点查询

五、常见问题
  · 下载失败（公司网络/墙）：重跑一次安装脚本即可，已装好的部分会跳过；
    也可把发布仓库的源码包下载到本地，用
      powershell -File Skill\\install.ps1 -ComponentsUrl <本地 zip>
    离线或不想补全时加 -SkipComponents（只剩统计与 JSON/DXF 导出）。
  · 提示「找不到 Node」：装 Node.js 20+ 后重开终端。
  · doctor 里 degraded 有 cadcraft / ui：说明那次下载没成功，重跑安装脚本。
  · 端口被占用：cad.mjs 会自动挑空闲端口；也可 set PORT=3727。
  · 换位置了：删除旧目录后重新解压 + 重新跑 install.ps1（-Force 可重指向）。

六、许可
  AGPL-3.0-only（见仓库 LICENSE）；商业许可 nbimgpt@163.com
  第三方组件（含 CADCraft CLI，Apache-2.0 或 MIT）见仓库 THIRD-PARTY.md
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
