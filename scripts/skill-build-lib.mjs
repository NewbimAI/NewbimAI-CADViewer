/**
 * Skill 打包公共逻辑（轻量包 / 完整包共用）。
 *
 * 规则：
 *  · 版本号**只**来自 server/package.json；构建时注入到包内 skill.json 的 version 字段。
 *  · Skill 目录名与清单 name 统一为 NewbimAI-CADViewer-Skill。
 *  · 包内绝不出现闭源解析组件的源码、Cargo 清单、构建产物目录（assertNoForbiddenSources 会拦）。
 *  · 输出目录可用 CADVIEWER_RELEASE_DIR 重定向（默认 <root>/release，可指向临时目录做验证）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SKILL_NAME = "NewbimAI-CADViewer-Skill";
export const SKILL_SRC = path.join(ROOT, "Skill", SKILL_NAME);

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** 唯一版本事实源。 */
export function appVersion() {
  return String(readJson(path.join(ROOT, "server", "package.json")).version);
}

export function sourceManifest() {
  return readJson(path.join(SKILL_SRC, "skill.json"));
}

export function releaseDir() {
  const custom = process.env.CADVIEWER_RELEASE_DIR;
  return custom ? path.resolve(custom) : path.join(ROOT, "release");
}

export function dirSize(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return n;
}

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;

/**
 * 复制 Skill 源码目录，并把版本注入包内 skill.json。
 *
 * flat=true（默认）：直接写到 stage 根 —— 解压后 zip 第一层就是 skill 目录本身
 *   （<name>/SKILL.md、<name>/skill.json、<name>/scripts/…），这是 Claude Code /
 *   opencode 等 agent 平台要求的标准结构；运行时组件（server/、web/dist/、bin/…）
 *   也由调用方放在同一个 stage 根里，scripts/cad.mjs 从脚本目录向上即可找到 server/scanner.js。
 * flat=false：旧布局，写到 <stage>/Skill/<name>（仅为兼容历史调用保留）。
 */
export function copySkillTree(stage, version, { flat = true } = {}) {
  const dst = flat ? stage : path.join(stage, "Skill", SKILL_NAME);
  fs.cpSync(SKILL_SRC, dst, {
    recursive: true,
    filter: (src) => {
      const base = path.basename(src).toLowerCase();
      return base !== "node_modules" && base !== ".git";
    },
  });

  // 安装脚本与 README 和 SKILL.md 放在同一层：平铺布局在 stage 根，
  // 旧布局在 <stage>/Skill（那里的命令写作 Skill\install.ps1）。
  const bundleDst = flat ? stage : path.join(stage, "Skill");
  fs.mkdirSync(bundleDst, { recursive: true });
  for (const f of ["README.md", "install.ps1", "install.sh"]) {
    const src = path.join(ROOT, "Skill", f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(bundleDst, f));
  }

  const manifest = sourceManifest();
  manifest.version = version;
  manifest.versionSource = "server/package.json";
  fs.writeFileSync(path.join(dst, "skill.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return dst;
}

/** 按 skill.json 的 requires.serverModules 复制服务端模块（不再硬编码白名单）。 */
export function copyServerModules(stage, { manifest = sourceManifest() } = {}) {
  const modules = manifest?.requires?.serverModules;
  if (!Array.isArray(modules) || modules.length === 0) {
    throw new Error("skill.json 缺少 requires.serverModules，无法确定要打包哪些 server 模块");
  }
  const dst = path.join(stage, "server");
  fs.mkdirSync(dst, { recursive: true });
  const copied = [];
  for (const name of [...modules, "package.json", "package-lock.json"]) {
    const src = path.join(ROOT, "server", name);
    if (!fs.existsSync(src)) throw new Error(`缺少 server/${name}（skill.json 声明或服务端清单要求）`);
    fs.copyFileSync(src, path.join(dst, name));
    copied.push(name);
  }
  // server/dxf-web.js 与 compare.js 都 import ../shared/geometry/index.mjs，
  // 共享几何模块必须与 server 模块一起随包分发，否则启动即 ERR_MODULE_NOT_FOUND。
  const sharedSrc = path.join(ROOT, "shared");
  if (!fs.existsSync(sharedSrc)) throw new Error("缺少 shared/（服务端 import 了 ../shared/geometry）");
  fs.cpSync(sharedSrc, path.join(stage, "shared"), { recursive: true });
  return copied;
}

/**
 * 在包根放「一键安装」入口（双击 install.cmd 或跑 install.ps1 即可）。
 *
 * 平铺布局下 install.ps1 / install.sh 已经由 copySkillTree 复制到 stage 根、且自己就能
 * 判断布局，这里**不再覆盖**它们，只补一个 Windows 双击入口 install.cmd。
 * 旧嵌套布局（stage/Skill/<name>）才写三份薄转发脚本，保持向后兼容。
 */
export function writeRootInstaller(stage) {
  const flat = fs.existsSync(path.join(stage, "SKILL.md"));

  if (flat) {
    const cmd = `@echo off\r\nrem 一键安装：双击或在本目录执行 install.cmd\r\nsetlocal\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*\r\n`;
    fs.writeFileSync(path.join(stage, "install.cmd"), cmd, "utf8");
    const shPath = path.join(stage, "install.sh");
    if (fs.existsSync(shPath)) {
      try {
        fs.chmodSync(shPath, 0o755);
      } catch {}
    }
    return;
  }

  const ps = `# 一键安装包装：把 Skill\\ 注册进 agent 的 skills 目录（转发给 Skill\\install.ps1）
# 用法：powershell -ExecutionPolicy Bypass -File install.ps1 [-SkillsDir <dir>]
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$inner = Join-Path $here "Skill\\install.ps1"
if (-not (Test-Path -LiteralPath $inner)) { throw "缺少 Skill\\install.ps1（安装包不完整，请重新解压）" }
& $inner @args
exit $LASTEXITCODE
`;
  const cmd = `@echo off\r\nrem 一键安装：双击或在本目录执行 install.cmd\r\nsetlocal\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Skill\\install.ps1" %*\r\n`;
  const sh = `#!/usr/bin/env sh
# 一键安装（macOS / Linux）：转发给 Skill/install.sh
set -e
here=$(cd "$(dirname "$0")" && pwd)
exec sh "$here/Skill/install.sh" "$@"
`;
  fs.writeFileSync(path.join(stage, "install.ps1"), ps, "utf8");
  fs.writeFileSync(path.join(stage, "install.cmd"), cmd, "utf8");
  const shPath = path.join(stage, "install.sh");
  fs.writeFileSync(shPath, sh, "utf8");
  try {
    fs.chmodSync(shPath, 0o755);
  } catch {}
}

/**
 * 命中即抛错（宁可不发包，也不发错包）。
 */
export function assertNoForbiddenSources(stage) {
  const forbiddenDir = new Set(["crates", "target", "node_modules"]);
  const forbiddenFile = /^(cargo\.toml|cargo\.lock)$/i;
  const forbiddenExt = /\.(rlib|rmeta|crate|pdb|lib)$/i;
  const hits = [];

  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const rel = path.relative(stage, p);
      if (e.isDirectory()) {
        if (forbiddenDir.has(e.name.toLowerCase())) hits.push(rel + "/");
        else walk(p);
      } else if (forbiddenFile.test(e.name) || forbiddenExt.test(e.name)) {
        hits.push(rel);
      }
    }
  };
  walk(stage);

  if (hits.length) {
    throw new Error(
      "闭源边界校验失败：包内出现了不该分发的文件/目录：\n  " + hits.join("\n  ")
    );
  }
  return true;
}

/** 随包许可附件（目标路径 → 源路径）。缺少源文件时由调用方决定是否致命。 */
export function licenseAttachments() {
  return [
    ["licenses/acadrust-MPL-2.0.txt", "crates/licenses/acadrust-MPL-2.0.txt"],
    ["licenses/acadrust-SOURCE.txt", "crates/licenses/acadrust-SOURCE.txt"],
    ["licenses/udo-cli-NOTICE.md", "crates/NOTICE.md"],
    ["licenses/udo-cli-LICENSE-MIT.txt", "crates/udo-cli/LICENSE-MIT"],
    ["licenses/udo-cli-LICENSE-APACHE.txt", "crates/udo-cli/LICENSE-APACHE"],
    ["licenses/acadrust-NOTICE.txt", "crates/dwg-io/NOTICE"],
  ];
}

/**
 * 复制解析组件二进制 + MPL-2.0 许可附件。
 * 有二进制就必须有附件：缺一个就抛错（合规优先）。
 */
export function copyClosedSourceBinary(stage) {
  const exeName = process.platform === "win32" ? "udo-cli.exe" : "udo-cli";
  const exeSrc = path.join(ROOT, "bin", "udo-cli", exeName);
  if (!fs.existsSync(exeSrc)) {
    return { included: false, bytes: 0, reason: `未找到 bin/udo-cli/${exeName}` };
  }

  const dst = path.join(stage, "bin", "udo-cli");
  fs.mkdirSync(dst, { recursive: true });
  fs.copyFileSync(exeSrc, path.join(dst, exeName));

  const missing = [];
  const copied = [];
  for (const [rel, srcRel] of licenseAttachments()) {
    const src = path.join(ROOT, srcRel);
    if (!fs.existsSync(src)) {
      missing.push(srcRel);
      continue;
    }
    const out = path.join(stage, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.copyFileSync(src, out);
    copied.push(rel);
  }
  if (missing.length) {
    throw new Error(
      "分发闭源二进制时必须随附许可附件，以下源文件缺失：\n  " + missing.join("\n  ")
    );
  }
  return { included: true, bytes: fs.statSync(exeSrc).size, licenses: copied };
}

export function copyCadcraft(stage) {
  const src = path.join(ROOT, "bin", "cadcraft");
  if (!fs.existsSync(src)) return { included: false, bytes: 0, reason: "未找到 bin/cadcraft" };
  fs.cpSync(src, path.join(stage, "bin", "cadcraft"), {
    recursive: true,
    filter: (s) => {
      const base = s.split(path.sep).pop();
      // 上游 EGUI 桌面主程序（~75MB）与调试符号不进包；CLI 链路不用它们。
      return !/^(cadcraft\.exe|.*\.pdb)$/i.test(base);
    },
  });
  return { included: true, bytes: dirSize(path.join(stage, "bin", "cadcraft")) };
}

export function zipStage(stage, zipPath) {
  fs.rmSync(zipPath, { force: true });
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  const parent = path.dirname(stage);
  const name = path.basename(stage);
  try {
    execFileSync("tar.exe", ["-a", "-c", "-f", zipPath, "-C", parent, name], { stdio: "inherit" });
  } catch {
    execFileSync(
      "powershell",
      ["-NoProfile", "-Command",
        `Compress-Archive -Path '${stage}' -DestinationPath '${zipPath}' -CompressionLevel Optimal`],
      { stdio: "inherit" }
    );
  }
  return fs.statSync(zipPath).size;
}

/** 读 zip 内的条目名（含目录条目），用 .NET ZipFile，无需外部依赖。 */
export function zipEntryNames(zipPath) {
  const abs = path.resolve(zipPath).replace(/'/g, "''");
  const outFile = path.join(os.tmpdir(), `skill-zip-entries-${process.pid}-${Date.now()}.txt`);
  const ps = [
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    `$zip = [System.IO.Compression.ZipFile]::OpenRead('${abs}')`,
    "try {",
    "  $names = @($zip.Entries | ForEach-Object { $_.FullName })",
    `  [System.IO.File]::WriteAllLines('${outFile.replace(/'/g, "''")}', [string[]]$names, (New-Object System.Text.UTF8Encoding($false)))`,
    "} finally { $zip.Dispose() }",
  ].join("\n");
  execFileSync("powershell", ["-NoProfile", "-Command", ps], { stdio: ["ignore", "ignore", "inherit"] });
  const text = fs.readFileSync(outFile, "utf8").replace(/^\uFEFF/, "");
  fs.rmSync(outFile, { force: true });
  return text.split(/\r?\n/).filter((l) => l.length > 0);
}

/**
 * agent 平台要求的标准 skill 包布局：**解压后第一层就是 skill 目录本身**。
 * 这里直接读 zip 条目校验，防止「SKILL.md 在第二层」的包再次被发出去。
 *
 * @param {string} zipPath
 * @param {{ files?: string[], label?: string }} [opts] files 为相对 skill 目录的必需条目
 * @returns {{ entries: string[], problems: string[] }}
 */
export function assertSkillZipLayout(zipPath, { files = [], label = zipPath } = {}) {
  const entries = zipEntryNames(zipPath);
  const problems = [];
  const prefix = `${SKILL_NAME}/`;

  if (!entries.length) problems.push("zip 是空的");

  const outsiders = entries.filter((e) => e !== prefix && !e.startsWith(prefix));
  if (outsiders.length) {
    problems.push(
      `zip 第一层必须是 ${SKILL_NAME}/，但有 ${outsiders.length} 个条目在它之外：` +
        outsiders.slice(0, 5).join(", ") + (outsiders.length > 5 ? " …" : "")
    );
  }

  for (const need of ["SKILL.md", "skill.json", ...files]) {
    const entry = prefix + need;
    if (!entries.includes(entry)) problems.push(`缺少 ${entry}`);
  }

  if (entries.some((e) => e.startsWith(`${prefix}Skill/`))) {
    problems.push(`出现了旧布局 ${prefix}Skill/（SKILL.md 会被埋在第二层）`);
  }

  if (problems.length) {
    throw new Error(
      `zip 布局校验失败（${label}）：\n  ` + problems.join("\n  ")
    );
  }
  return { entries, problems };
}

export function printReport({ title, stage, zipPath, zipBytes, breakdown, extra = [] }) {
  console.log(`\n  ${title}`);
  console.log(`  目录 : ${stage}`);
  for (const [label, bytes] of breakdown) {
    console.log(`    ${label.padEnd(22)} ${bytes >= 1048576 ? mb(bytes) : kb(bytes)}`);
  }
  console.log(`  合计 : ${mb(dirSize(stage))}（解压）`);
  console.log(`  压缩 : ${zipPath}`);
  console.log(`         ${mb(zipBytes)}`);
  for (const line of extra) console.log(`  ${line}`);
}
