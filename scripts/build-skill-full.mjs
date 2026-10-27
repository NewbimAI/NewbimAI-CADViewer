/**
 * 生成「完整 Skill 包」：Skill + 服务端 + 已构建前端 + 转换器（可直接发给别人）。
 *
 *   node scripts/build-skill-full.mjs
 *   → release/cadviewer-skill-full-<version>.zip
 *
 * 为什么做完整包：轻量包只能做「统计/导出」，`open`（生成访问链接、在内置浏览器看图）
 * 需要 server/index.js + web/dist；开 DWG 需要 bin/cadcraft。把这三样一起打进去，
 * 对方解压后跑一次 install.ps1 就能按 SOP 走完整流程。
 *
 * 包里**不含** node.exe：对方需要自己装 Node.js 20+（文档里写清）。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ver = JSON.parse(fs.readFileSync(path.join(ROOT, "server/package.json"), "utf8")).version;
const NAME = `cadviewer-skill-full-${ver}`;
const STAGE = path.join(ROOT, "release", "skill-full", NAME);
const ZIP = path.join(ROOT, "release", `${NAME}.zip`);

const dirSize = (d) => {
  let n = 0;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    n += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return n;
};

fs.rmSync(STAGE, { recursive: true, force: true });
fs.rmSync(ZIP, { force: true });
fs.mkdirSync(path.join(STAGE, "server"), { recursive: true });

// 1) Skill（含 install.ps1 / install.sh）
fs.cpSync(path.join(ROOT, "Skill"), path.join(STAGE, "Skill"), { recursive: true });

// 2) 服务端：全部源码 + 清单（node_modules 由 serve 首次自动 npm ci）
for (const f of fs.readdirSync(path.join(ROOT, "server"))) {
  if (/\.(js|json|bat)$/.test(f)) fs.copyFileSync(path.join(ROOT, "server", f), path.join(STAGE, "server", f));
}

// 3) 已构建前端（不装 npm、不构建）
fs.cpSync(path.join(ROOT, "web/dist"), path.join(STAGE, "web/dist"), { recursive: true });

// 4) 转换器
fs.cpSync(path.join(ROOT, "bin/cadcraft"), path.join(STAGE, "bin/cadcraft"), { recursive: true });

// 5) 许可
for (const f of ["LICENSE", "THIRD-PARTY.md"]) {
  if (fs.existsSync(path.join(ROOT, f))) fs.copyFileSync(path.join(ROOT, f), path.join(STAGE, f));
}

fs.writeFileSync(
  path.join(STAGE, "使用说明.txt"),
  `CADViewer Skill ${ver}（完整包）

一、里面有什么
  Skill\\             agent 用的命令行 Skill + 一键安装脚本
  server\\            本地服务（scanner / DXF 预处理 / 导出）
  web\\dist\\          已构建好的界面（不用 npm install、不用构建）
  bin\\cadcraft\\      DWG 转换器（已内置，不用另外下载）

二、对方需要什么
  · Windows 10/11 x64
  · Node.js 20+（唯一需要自己装的东西）：https://nodejs.org
  · 一个支持 skills 的 agent（OpenCode / WorkBuddy / Claude Code / Cursor 等）

三、怎么装（两步）
  1) 解压到一个**固定位置**（建议 D:\\CADViewer 或 C:\\Tools\\CADViewer；
     注意：注册用的是目录联接，装完不能随便移动/删除这个目录）
  2) 在该目录执行：
       powershell -ExecutionPolicy Bypass -File Skill\\install.ps1
     脚本会：链接到 agent 的 skills 目录 → 跑 doctor 自检 → 打印结果。
     看到 doctor: ok 就装完了，**不需要再拿图纸验证**。

四、装完怎么用（agent 里的标准流程）
  1. 让它读一张图：agent 会跑
       node <本目录>\\Skill\\cadviewer\\scripts\\cad.mjs open "图纸.dwg"
     这一步会：DWG→DXF（缓存）、起本地服务（后台静默、不弹窗口）、返回一个链接 + 概要。
  2. agent 会把链接以**超链接**发给用户（可直接点开），必要时用内置浏览器打开。
  3. 读数据不需要截图：agent 会跑 readout 拿一份 JSON（实体/图层/块/文字）。
  4. 导出由用户选择：PDF（A3 打印）/ PNG（只导一张）/ DXF / JSON。
  5. 看完让 agent 跑 close；服务空闲 30 分钟也会自己退出。

五、常见问题
  · 提示「找不到 Node」：装 Node.js 20+ 后重开终端。
  · doctor 里 degraded 有 fonts：正常（字体只给界面用，CLI 不读）。
  · doctor 里 degraded 有 cadcraft：说明 bin\\cadcraft 被删了，重新解压本包即可。
  · 端口被占用：cad.mjs 会自动挑空闲端口；也可 set PORT=3727。
  · 换位置了：删除旧目录后重新解压 + 重新跑 install.ps1（-Force 可重指向）。

六、许可
  AGPL-3.0-only（见 LICENSE）；商业许可联系 nbimgpt@163.com。
  第三方组件（含 CADCraft CLI，Apache-2.0 或 MIT）见 THIRD-PARTY.md。
`,
  "utf8"
);

try {
  execFileSync("tar.exe", ["-a", "-c", "-f", ZIP, "-C", path.join(ROOT, "release", "skill-full"), NAME], { stdio: "inherit" });
} catch {
  execFileSync("powershell", ["-NoProfile", "-Command",
    `Compress-Archive -Path '${STAGE}' -DestinationPath '${ZIP}' -CompressionLevel Optimal`], { stdio: "inherit" });
}

console.log(`\n  目录: ${STAGE}`);
console.log(`  解压: ${(dirSize(STAGE) / 1048576).toFixed(1)} MB`);
console.log(`  压缩: ${ZIP}`);
console.log(`  大小: ${(fs.statSync(ZIP).size / 1048576).toFixed(1)} MB`);
