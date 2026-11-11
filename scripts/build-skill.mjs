/**
 * 生成「轻量 Skill 包」：Skill（薄 SKILL.md + skill.json + CLI/命令层 + references）
 * + CLI 实际 import 的服务端模块 + 服务端清单。
 *
 *   node scripts/build-skill.mjs
 *   → <release>/NewbimAI-CADViewer-Skill-<version>.zip
 *
 * 版本号取自 server/package.json，构建时注入包内 skill.json；不在 Skill 里另存一份。
 * web/、字体、前端构建产物、转换器、闭源解析组件都不进包——安装时由
 * install.ps1 / install.sh 自动补全（解析组件只在完整包里）。
 *
 * 输出目录默认 <root>/release；用 CADVIEWER_RELEASE_DIR 可指到临时目录做验证。
 */
import fs from "node:fs";
import path from "node:path";

import {
  SKILL_NAME,
  SKILL_SRC,
  appVersion,
  printReport,
  zipStage,
  writeRootInstaller,
  releaseDir,
  copySkillTree,
  copyServerModules,
  dirSize,
  assertNoForbiddenSources,
  assertSkillZipLayout,
  sourceManifest,
} from "./skill-build-lib.mjs";

const ver = appVersion();
const NAME = `${SKILL_NAME}-${ver}`;
// stage 目录名必须是 NewbimAI-CADViewer-Skill：zipStage 用 `-C parent <stage basename>`，
// 这样解压后第一层就是 skill 目录本身（SKILL.md 在第一层），agent 平台才认得。
const STAGE = path.join(releaseDir(), "skill", SKILL_NAME);
const ZIP = path.join(releaseDir(), `${NAME}.zip`);

fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

// 1) Skill 源码 + 版本注入
copySkillTree(STAGE, ver);

// 2) 服务端模块（清单来自 skill.json，不再硬编码 4 个）
const modules = copyServerModules(STAGE);

// 3) 读我
fs.writeFileSync(
  path.join(STAGE, "INSTALL.txt"),
  "\uFEFF" + `${SKILL_NAME} ${ver}（轻量包 · 安装时自动补全）

一、这个包为什么小，以及解压后长什么样
  包内只有：agent 用的 Skill（薄 SKILL.md + skill.json + 命令层）
  + CLI 实际 import 的服务端模块 + 服务端清单。
  界面、服务端全量代码、DWG 转换器、自定义对象解析组件都不在包里，
  安装时自动补回来——所以可以上传到有 3MB 限制的 agent 平台。

  解压后第一层就是 skill 目录本身（agent 平台要求的标准结构）：
    ${SKILL_NAME}/
      SKILL.md            给模型的能力说明
      skill.json          机器可读清单（版本由构建注入）
      README.md           人读的安装 / 打包说明
      install.ps1 · install.cmd · install.sh    一键安装
      scripts/            cad.mjs 命令层（唯一入口）+ commands/
      references/         cli · compare · measure · udo · answering · api · troubleshooting
      server/             CLI 直接 import 的服务端模块 + 清单
      shared/             服务端共用的几何模块

  把这个目录整个交给 agent（或上传整个 zip）即可；不要把 SKILL.md 单独摘出来。

二、对方需要什么
  · Windows 10/11 x64（macOS / Linux 只能做 DXF 只读命令）
  · Node.js 20+：https://nodejs.org       ← 唯一需要自己装的东西
  · 联网（安装时要下载组件）

三、怎么装（一条命令，装完即止）
  1) 解压到一个固定位置（建议 D:/CADViewer；装完不能随便移动，注册用的是目录联接）
  2) 进入解压后的 ${SKILL_NAME}/ 目录执行：
       powershell -ExecutionPolicy Bypass -File install.ps1
     （也可以直接双击 install.cmd）
     它会依次：注册 Skill → 下载转换器（约 57MB）→ 补界面与服务端（约 18MB）→ 跑 doctor
     看到 doctor: ok 就装完了，不需要再拿图纸验证。

四、装完能做什么
  · 读图：open / readout / summary / layers / blocks / text / stats
  · 对比：compare（新增/删除/修改 + 变更集；--report 出 .docx）
  · 测量：measure（坐标距离/长度/面积/角度）+ 界面底部测量工具
  · 自定义对象：udo（判定）/ udo --coverage（解出/未解出）
    ⚠️ 轻量包不含解析组件，doctor 的 degraded 里会有 udo；需要时用完整包
  · 导出：export --to dxf|svg|pdf|json|png

五、常见问题
  · 下载失败（公司网络/墙）：重跑安装脚本（已装好的部分会跳过）；
    或下载发布仓库源码包，用 -ComponentsUrl <本地 zip>
  · 只想要 CLI、不要界面：-SkipComponents（此时 compare / open 不可用）
  · 提示找不到 Node：装 Node.js 20+ 后重开终端
  · 端口被占用：cad.mjs 自动挑空闲端口；也可 set PORT=3727

六、版本与许可
  · Skill 与 App 同版本：${ver}（唯一事实源 server/package.json）
  · 本项目 AGPL-3.0-only（见仓库 LICENSE）；商业许可 nbimgpt@163.com
  · 第三方组件见仓库 THIRD-PARTY.md（含 CADCraft CLI，Apache-2.0 或 MIT）
`,
  "utf8"
);

// 4) 闭源边界：包内不得出现解析组件源码 / Cargo 清单 / Rust 构建产物
assertNoForbiddenSources(STAGE);

// 5) 压缩 + 报告
writeRootInstaller(STAGE);
const zipBytes = zipStage(STAGE, ZIP);

// 6) zip 布局硬校验：解压后第一层必须是 NewbimAI-CADViewer-Skill/，且其下直接有 SKILL.md
assertSkillZipLayout(ZIP, {
  label: NAME,
  files: [
    "scripts/cad.mjs",
    "scripts/manifest.mjs",
    "references/cli.md",
    "install.ps1",
    "install.sh",
    "INSTALL.txt",
    "server/scanner.js",
    "shared/geometry/index.mjs",
  ],
});

const skillBytes =
  dirSize(SKILL_SRC) +
  ["README.md", "install.ps1", "install.sh", "install.cmd"]
    .map((f) => (fs.existsSync(path.join(STAGE, f)) ? fs.statSync(path.join(STAGE, f)).size : 0))
    .reduce((a, b) => a + b, 0);
const serverBytes = dirSize(path.join(STAGE, "server"));
const txtBytes = fs.statSync(path.join(STAGE, "INSTALL.txt")).size;
printReport({
  title: `轻量包 ${NAME}`,
  stage: STAGE,
  zipPath: ZIP,
  zipBytes,
  breakdown: [
    ["SKILL.md+scripts+refs", skillBytes],
    ["server/（模块+清单）", serverBytes],
    ["INSTALL.txt", txtBytes],
  ],
  extra: [`服务端模块：${modules.join(", ")}`],
});

// 供 CI / 校验脚本读取
const manifest = JSON.parse(fs.readFileSync(path.join(STAGE, "skill.json"), "utf8"));
const expectedModules = sourceManifest()?.requires?.serverModules || [];
if (manifest.version !== ver) {
  throw new Error(`包内 skill.json 版本 ${manifest.version} 与 server/package.json ${ver} 不一致`);
}
if (JSON.stringify(manifest.requires?.serverModules) !== JSON.stringify(expectedModules)) {
  throw new Error("包内 skill.json 的 serverModules 与源码清单不一致");
}
