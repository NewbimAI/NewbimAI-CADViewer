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

/** 复制 Skill 源码目录到 <stage>/Skill/<name>，并把版本注入包内 skill.json。 */
export function copySkillTree(stage, version) {
  const dst = path.join(stage, "Skill", SKILL_NAME);
  fs.cpSync(SKILL_SRC, dst, {
    recursive: true,
    filter: (src) => {
      const base = path.basename(src).toLowerCase();
      return base !== "node_modules" && base !== ".git";
    },
  });

  // 包根部的 Skill/ 还要带安装脚本与 README（使用说明里的命令就是 Skill\install.ps1）
  const bundleDst = path.join(stage, "Skill");
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
  return copied;
}

/**
 * 闭源边界：包内不得出现解析组件源码、Cargo 清单、Rust 构建产物。
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
