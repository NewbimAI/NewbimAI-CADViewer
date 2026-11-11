/**
 * 生成「完整 Skill 包」：Skill + 全部服务端 + 已构建前端 + 转换器 + 自定义对象解析组件
 * （可直接发给别人，解压后跑一次 install 即可用）。
 *
 *   node scripts/build-skill-full.mjs
 *   → <release>/NewbimAI-CADViewer-Skill-full-<version>.zip
 *
 * 与轻量包的区别：本包含 web/dist（约 30MB，其中字体约 27MB）、bin/cadcraft（CLI，约 53MB）、
 * bin/udo-cli（约 7.4MB）与随附许可附件，因此可离线使用，也能解析天正自定义对象。
 *
 * 包里**不含** node.exe：对方需自备 Node.js 20+。
 * 输出目录默认 <root>/release；用 CADVIEWER_RELEASE_DIR 可指到临时目录做验证。
 */
import fs from "node:fs";
import path from "node:path";

import {
  ROOT,
  SKILL_NAME,
  SKILL_SRC,
  appVersion,
  printReport,
  zipStage,
  writeRootInstaller,
  releaseDir,
  copySkillTree,
  copyServerModules,
  copyCadcraft,
  copyClosedSourceBinary,
  dirSize,
  assertNoForbiddenSources,
  assertSkillZipLayout,
} from "./skill-build-lib.mjs";

const ver = appVersion();
const NAME = `${SKILL_NAME}-full-${ver}`;
// stage 目录名必须是 NewbimAI-CADViewer-Skill：解压后第一层就是 skill 目录本身，
// 运行时组件（server/、web/dist/、bin/…）都在同一个目录内，cad.mjs 向上即可找到根。
const STAGE = path.join(releaseDir(), "skill-full", SKILL_NAME);
const ZIP = path.join(releaseDir(), `${NAME}.zip`);

fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

// 1) Skill（含 install.ps1 / install.sh、薄 SKILL.md、skill.json）
copySkillTree(STAGE, ver);

// 2) 服务端：Skill 需要的模块 + 全部服务端源码与清单（node_modules 由 serve 首次自动 npm ci）
copyServerModules(STAGE);
let serverCount = 0;
for (const f of fs.readdirSync(path.join(ROOT, "server"))) {
  if (!/\.(js|json|bat)$/.test(f)) continue;
  const dst = path.join(STAGE, "server", f);
  if (!fs.existsSync(dst)) {
    fs.copyFileSync(path.join(ROOT, "server", f), dst);
    serverCount++;
  }
}

// 3) 已构建前端（含随包字体；不装 npm、不构建）
const webSrc = path.join(ROOT, "web", "dist");
if (!fs.existsSync(path.join(webSrc, "index.html"))) {
  throw new Error(`缺少已构建前端：${webSrc}/index.html（先构建 web，或改用轻量包）`);
}
fs.cpSync(webSrc, path.join(STAGE, "web", "dist"), { recursive: true });

// 4) DWG 转换器（排除上游 EGUI 桌面主程序 cadcraft.exe）
const cadcraft = copyCadcraft(STAGE);

// 5) 自定义对象解析组件（闭源二进制）+ MPL-2.0 许可附件
const udo = copyClosedSourceBinary(STAGE);

// 6) 许可与第三方声明 + 运行时目录 + 双击启动脚本
for (const f of ["LICENSE", "THIRD-PARTY.md", "start.bat"]) {
  const src = path.join(ROOT, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(STAGE, f));
}
// data/ 只放目录说明：data/uploads/ 是用户原始图纸（隐私），绝不进包。
const dataReadme = path.join(ROOT, "data", "README.md");
if (fs.existsSync(dataReadme)) {
  fs.mkdirSync(path.join(STAGE, "data"), { recursive: true });
  fs.copyFileSync(dataReadme, path.join(STAGE, "data", "README.md"));
}
if (udo.included) {
  // 根目录再放一份“为什么有 licenses/”的说明，免得用户当成垃圾文件删掉
  fs.writeFileSync(
    path.join(STAGE, "licenses", "README.md"),
    `本目录是 bin/udo-cli/ 随附的第三方许可与源码获取说明（MPL-2.0 义务）。

- acadrust-MPL-2.0.txt   MPL-2.0 全文
- acadrust-SOURCE.txt    源码获取地址与“未修改”声明
- acadrust-NOTICE.txt    acadrust 的 NOTICE
- udo-cli-LICENSE-MIT.txt / udo-cli-LICENSE-APACHE.txt   自有代码的双许可
- udo-cli-NOTICE.md      组件与依赖声明

分发本包时必须保留这些文件；删除后不得再分发其中的 bin/udo-cli/。
`,
    "utf8"
  );
}

// 7) 读我
fs.writeFileSync(
  path.join(STAGE, "INSTALL.txt"),
  "\uFEFF" + `${SKILL_NAME} ${ver}（完整包）

一、里面有什么（解压后第一层就是 skill 目录本身）
  ${SKILL_NAME}/
    SKILL.md          给模型的能力说明（agent 平台要求它在第一层目录里）
    skill.json        机器可读清单（版本由构建注入）
    README.md         人读的安装 / 打包说明
    install.ps1 · install.cmd · install.sh    一键安装
    scripts/          cad.mjs 命令层（唯一入口）
    references/       cli · compare · measure · udo · answering · api · troubleshooting
    server/           本地服务（扫描 / 对比引擎 / 导出 / 自定义对象解析调用）
    web/dist/         已构建好的界面（不用 npm install、不用构建）
    bin/cadcraft/     DWG 转换器（已内置）
    bin/udo-cli/      自定义对象解析组件（已内置，闭源二进制）
    licenses/         解析组件的第三方许可与源码获取说明（MPL-2.0，请勿删除）
    shared/           服务端共用的几何模块
    data/             用户图纸目录（只带目录说明，不含任何图纸）
    start.bat         双击启动界面（可选，CLI 不需要）

  把 ${SKILL_NAME} 这个目录整个交给 agent（或上传整个 zip）即可；不要把 SKILL.md 单独摘出来。

二、对方需要什么
  · Windows 10/11 x64
  · Node.js 20+（唯一需要自己装的东西）：https://nodejs.org
  · 支持 skills 的 agent（OpenCode / WorkBuddy / Claude Code / Cursor 等）

三、怎么装（两步）
  1) 解压到一个固定位置（建议 D:/CADViewer；注册用的是目录联接，装完不能随便移动）
  2) 进入解压后的 ${SKILL_NAME}/ 目录执行：
       powershell -ExecutionPolicy Bypass -File install.ps1
     （也可以直接双击 install.cmd）
     看到 doctor: ok 就装完了（degraded 为空 = 连自定义对象解析都可用）。

四、装完怎么用
  · 读图：cad.mjs open / readout / summary / layers / blocks / text / stats
  · 对比：cad.mjs compare "旧图" "新图" [--report report.docx]
  · 测量：cad.mjs measure distance --points "0,0;3000,4000"（贴合图元用界面底部工具条）
  · 自定义对象：cad.mjs udo "天正图.dwg" --coverage
  · 导出：cad.mjs export <图> --to dxf|svg|pdf|json|png

五、常见问题
  · doctor 的 degraded 有 fonts：正常（字体只给界面用，CLI 不读）
  · degraded 有 cadcraft：bin\\cadcraft 被删了，重新解压本包
  · degraded 有 udo：bin\\udo-cli 被删了，重新解压本包
  · 端口被占用：cad.mjs 自动挑空闲端口；也可 set PORT=3727

六、版本与许可
  · Skill 与 App 同版本：${ver}（唯一事实源 server/package.json）
  · 本项目 AGPL-3.0-only（见 LICENSE）；商业许可 nbimgpt@163.com
  · 第三方组件见 THIRD-PARTY.md 与 licenses/
`,
  "utf8"
);

// 8) 闭源边界校验 + 压缩 + zip 布局硬校验
assertNoForbiddenSources(STAGE);
writeRootInstaller(STAGE);
const zipBytes = zipStage(STAGE, ZIP);

assertSkillZipLayout(ZIP, {
  label: NAME,
  files: [
    "scripts/cad.mjs",
    "references/cli.md",
    "install.ps1",
    "install.sh",
    "INSTALL.txt",
    "LICENSE",
    "THIRD-PARTY.md",
    "start.bat",
    "server/index.js",
    "server/scanner.js",
    "shared/geometry/index.mjs",
    "web/dist/index.html",
    "bin/udo-cli/udo-cli.exe",
    "licenses/acadrust-MPL-2.0.txt",
    "licenses/acadrust-SOURCE.txt",
    "licenses/acadrust-NOTICE.txt",
    "licenses/udo-cli-NOTICE.md",
    "licenses/udo-cli-LICENSE-MIT.txt",
    "licenses/udo-cli-LICENSE-APACHE.txt",
  ],
});

const skillBytes =
  dirSize(SKILL_SRC) +
  ["README.md", "install.ps1", "install.sh", "install.cmd", "INSTALL.txt", "LICENSE", "THIRD-PARTY.md", "start.bat"]
    .map((f) => (fs.existsSync(path.join(STAGE, f)) ? fs.statSync(path.join(STAGE, f)).size : 0))
    .reduce((a, b) => a + b, 0);
const serverBytes = dirSize(path.join(STAGE, "server"));
const webBytes = dirSize(path.join(STAGE, "web", "dist"));
const fontBytes = fs.existsSync(path.join(STAGE, "web", "dist", "fonts"))
  ? dirSize(path.join(STAGE, "web", "dist", "fonts"))
  : 0;
const licenseBytes = fs.existsSync(path.join(STAGE, "licenses"))
  ? dirSize(path.join(STAGE, "licenses"))
  : 0;
const docBytes = ["data/README.md"].reduce(
  (a, f) => a + (fs.existsSync(path.join(STAGE, f)) ? fs.statSync(path.join(STAGE, f)).size : 0),
  0
);

printReport({
  title: `完整包 ${NAME}`,
  stage: STAGE,
  zipPath: ZIP,
  zipBytes,
  breakdown: [
    ["SKILL.md+scripts+refs+安装/声明", skillBytes],
    ["server/（全量）", serverBytes],
    [`web/dist（字体 ${(fontBytes / 1048576).toFixed(1)} MB）`, webBytes],
    ["bin/cadcraft（CLI）", cadcraft.bytes],
    ["bin/udo-cli（解析组件）", udo.bytes],
    ["licenses/", licenseBytes],
    ["data/（仅目录说明）", docBytes],
  ],
  extra: [
    `服务端补齐：${serverCount} 个额外文件`,
    udo.included ? `解析组件：已内置 + ${udo.licenses.length} 个许可附件` : `解析组件：未打包（${udo.reason}）`,
  ],
});
