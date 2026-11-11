/**
 * Skill 校验（源码树或已打包目录）。
 *
 *   node scripts/check-skill.mjs                 # 校验源码树（Skill/NewbimAI-CADViewer-Skill）
 *   node scripts/check-skill.mjs --package <dir> # 校验打包后的 stage 目录（含闭源边界）
 *   node scripts/check-skill.mjs --zip <a.zip> --zip <b.zip>  # 校验 zip 第一层必须是
 *                                                # NewbimAI-CADViewer-Skill/ 且其下直接有 SKILL.md
 *   node scripts/check-skill.mjs --self-test     # 额外跑命令层纯函数断言
 *
 * 退出码：0 全部通过；1 有失败项。输出 JSON，便于 CI 读取。
 */
import fs from "node:fs";
import path from "node:path";

import {
  ROOT,
  SKILL_NAME,
  SKILL_SRC,
  appVersion,
  assertSkillZipLayout,
  dirSize,
  readJson,
} from "./skill-build-lib.mjs";

const args = process.argv.slice(2);
const pkgIndex = args.indexOf("--package");
const PACKAGE_DIR = pkgIndex >= 0 ? path.resolve(args[pkgIndex + 1] || "") : null;
const SELF_TEST = args.includes("--self-test");
const ZIP_PATHS = args.reduce(
  (acc, a, i) => (a === "--zip" && args[i + 1] ? [...acc, path.resolve(args[i + 1])] : acc),
  []
);

const results = [];
const ok = (name, detail = "") => results.push({ name, ok: true, detail });
const bad = (name, detail = "") => results.push({ name, ok: false, detail });

const version = appVersion();

/* ---------- 源码树 / 包内 Skill 目录 ---------- */
// 包的标准布局是「解压后第一层就是 skill 目录」：<pkg>/SKILL.md。
// 旧布局（<pkg>/Skill/<name>/SKILL.md）只为历史产物保留兼容。
const PACKAGE_FLAT = !!PACKAGE_DIR && fs.existsSync(path.join(PACKAGE_DIR, "SKILL.md"));
const skillDir = PACKAGE_DIR
  ? PACKAGE_FLAT
    ? PACKAGE_DIR
    : path.join(PACKAGE_DIR, "Skill", SKILL_NAME)
  : SKILL_SRC;

if (!fs.existsSync(path.join(skillDir, "SKILL.md"))) {
  bad("skill-dir", `找不到 ${skillDir}/SKILL.md`);
} else {
  ok("skill-dir", skillDir);
}

/* ---------- manifest ---------- */
let manifest = null;
try {
  manifest = readJson(path.join(skillDir, "skill.json"));
  ok("manifest-parse", `${path.join(skillDir, "skill.json")}（${dirSize(skillDir)} bytes 目录）`);
} catch (e) {
  bad("manifest-parse", e.message);
}

if (manifest) {
  if (manifest.name === SKILL_NAME) ok("manifest-name", manifest.name);
  else bad("manifest-name", `期望 ${SKILL_NAME}，实际 ${manifest.name}`);

  if (PACKAGE_DIR) {
    if (manifest.version === version) ok("manifest-version", manifest.version);
    else bad("manifest-version", `包内 ${manifest.version ?? "缺失"} ≠ server/package.json ${version}`);
  } else if (!manifest.version) {
    ok("manifest-version", "源码树未写 version（由构建注入，唯一事实源 server/package.json）");
  } else if (manifest.version === version) {
    ok("manifest-version", `${manifest.version}（源码树显式声明）`);
  } else {
    bad("manifest-version", `${manifest.version} ≠ ${version}`);
  }

  const minApp = manifest.minAppVersion;
  if (!minApp || minApp === version) ok("min-app-version", String(minApp));
  else {
    // minAppVersion 是“能力最低要求”，允许低于当前版本；高于当前版本才算错
    const cmp = (a, b) => {
      const pa = String(a).split(".").map(Number);
      const pb = String(b).split(".").map(Number);
      for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
      return 0;
    };
    if (cmp(minApp, version) <= 0) ok("min-app-version", `${minApp} ≤ ${version}`);
    else bad("min-app-version", `${minApp} > ${version}`);
  }

  const modules = manifest?.requires?.serverModules || [];
  const missing = modules.filter((m) => !fs.existsSync(path.join(ROOT, "server", m)));
  if (modules.length && !missing.length) ok("server-modules", modules.join(", "));
  else bad("server-modules", `缺少：${missing.join(", ") || "(未声明 serverModules)"}`);

  const caps = (manifest.capabilities || []).map((c) => c.id);
  for (const id of ["compare", "measure", "custom-objects"]) {
    if (caps.includes(id)) ok(`capability-${id}`, "已声明");
    else bad(`capability-${id}`, "skill.json 缺少该能力");
  }
}

/* ---------- SKILL.md ---------- */
const skillMdPath = path.join(skillDir, "SKILL.md");
if (fs.existsSync(skillMdPath)) {
  const md = fs.readFileSync(skillMdPath, "utf8");
  const lines = md.split(/\r?\n/).length;
  const fmName = /^---\n[\s\S]*?^name:\s*(\S+)/m.exec(md);
  if (fmName && fmName[1] === SKILL_NAME) ok("skill-md-name", fmName[1]);
  else bad("skill-md-name", `frontmatter name: ${fmName ? fmName[1] : "缺失"}`);

  if (lines <= 130) ok("skill-md-size", `${lines} 行 / ${Buffer.byteLength(md)} B`);
  else bad("skill-md-size", `${lines} 行（目标 ≤130，当前偏厚）`);

  for (const [label, needle] of [
    ["compare", "compare"],
    ["measure", "measure"],
    ["custom-objects", "udo"],
  ]) {
    if (md.includes(needle)) ok(`skill-md-${label}`, "有入口");
    else bad(`skill-md-${label}`, `SKILL.md 没有 ${needle} 入口`);
  }

  const forbidden = [
    { re: /crates\//i, why: "内部源码路径 crates/" },
    { re: /Cargo\.(toml|lock)/i, why: "Cargo 清单" },
    { re: /\.rlib/i, why: "Rust 构建产物" },
    { re: /位流|bitstream|加密算法|密钥推导/i, why: "解码实现细节" },
  ];
  const hits = forbidden.filter((f) => f.re.test(md)).map((f) => f.why);
  if (!hits.length) ok("skill-md-boundary", "无源码路径/Cargo/位流实现细节");
  else bad("skill-md-boundary", `出现不该写的内容：${hits.join("、")}`);
}

/* ---------- 命令层可加载 ---------- */
for (const rel of ["scripts/cad.mjs", "scripts/commands/compare.mjs", "scripts/commands/measure.mjs", "scripts/commands/udo.mjs", "scripts/manifest.mjs"]) {
  const p = path.join(skillDir, rel);
  if (fs.existsSync(p)) ok(`file-${rel}`, `${fs.statSync(p).size} B`);
  else bad(`file-${rel}`, "缺失");
}

if (manifest && fs.existsSync(path.join(skillDir, "scripts", "cad.mjs"))) {
  const cli = fs.readFileSync(path.join(skillDir, "scripts", "cad.mjs"), "utf8");
  const missing = Object.keys(manifest.commands || {}).filter((cmd) => !cli.includes(`"${cmd}"`));
  if (!missing.length) ok("commands-wired", Object.keys(manifest.commands).join(", "));
  else bad("commands-wired", `cad.mjs 里找不到：${missing.join(", ")}`);
}

/* ---------- 包边界（仅 --package） ---------- */
if (PACKAGE_DIR) {
  if (!fs.existsSync(PACKAGE_DIR)) {
    bad("package-dir", `不存在：${PACKAGE_DIR}`);
  } else {
    const hits = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        const rel = path.relative(PACKAGE_DIR, p);
        if (e.isDirectory()) {
          if (["crates", "target", "node_modules", ".git"].includes(e.name.toLowerCase())) hits.push(rel + "/");
          else walk(p);
        } else if (/^(Cargo\.toml|Cargo\.lock)$/i.test(e.name) || /\.(rlib|rmeta|crate|pdb)$/i.test(e.name)) {
          hits.push(rel);
        }
      }
    };
    walk(PACKAGE_DIR);
    if (!hits.length) ok("package-boundary", "无 crates/ · Cargo* · target/ · *.rlib");
    else bad("package-boundary", hits.join("; "));

    if (PACKAGE_FLAT) ok("package-layout", "平铺：包根直接有 SKILL.md（agent 平台标准结构）");
    else bad("package-layout", "包根没有 SKILL.md（旧嵌套布局，agent 平台会报「不含 SKILL.md」）");

    const installerRels = PACKAGE_FLAT
      ? ["install.ps1", "install.sh", "README.md"]
      : ["Skill/install.ps1", "Skill/install.sh", "Skill/README.md"];
    const installers = installerRels.filter((f) => fs.existsSync(path.join(PACKAGE_DIR, f)));
    if (installers.length === installerRels.length) ok("package-installers", installers.join(", "));
    else bad("package-installers", `缺少：${installerRels.filter((f) => !installers.includes(f)).join(", ")}`);

    const udoDir = path.join(PACKAGE_DIR, "bin", "udo-cli");
    if (fs.existsSync(udoDir)) {      const need = [
        "licenses/acadrust-MPL-2.0.txt",
        "licenses/acadrust-SOURCE.txt",
        "licenses/udo-cli-LICENSE-MIT.txt",
        "licenses/udo-cli-NOTICE.md",
      ];
      const miss = need.filter((f) => !fs.existsSync(path.join(PACKAGE_DIR, f)));
      if (!miss.length) ok("mpl-attachments", need.join(", "));
      else bad("mpl-attachments", `分发闭源二进制但缺少：${miss.join(", ")}`);
    } else {
      ok("mpl-attachments", "包内无解析组件二进制，无需附件");
    }
  }
}

/* ---------- zip 布局（--zip，可重复；包外第一层必须是 skill 目录名） ---------- */
const LIGHT_FILES = [
  "SKILL.md",
  "skill.json",
  "scripts/cad.mjs",
  "references/cli.md",
  "install.ps1",
  "install.sh",
  "INSTALL.txt",
  "server/scanner.js",
  "shared/geometry/index.mjs",
];
const FULL_ONLY_FILES = [
  "LICENSE",
  "THIRD-PARTY.md",
  "start.bat",
  "server/index.js",
  "web/dist/index.html",
  "bin/udo-cli/udo-cli.exe",
  "licenses/acadrust-MPL-2.0.txt",
  "licenses/acadrust-SOURCE.txt",
  "licenses/acadrust-NOTICE.txt",
  "licenses/udo-cli-NOTICE.md",
  "licenses/udo-cli-LICENSE-MIT.txt",
  "licenses/udo-cli-LICENSE-APACHE.txt",
];

for (const zipPath of ZIP_PATHS) {
  const tag = path.basename(zipPath);
  if (!fs.existsSync(zipPath)) {
    bad(`zip-layout-${tag}`, `不存在：${zipPath}`);
    continue;
  }
  const isFull = /-full-/i.test(tag);
  try {
    const { entries } = assertSkillZipLayout(zipPath, {
      label: tag,
      files: isFull ? [...LIGHT_FILES, ...FULL_ONLY_FILES] : LIGHT_FILES,
    });
    const fileCount = entries.filter((e) => !e.endsWith("/")).length;
    ok(
      `zip-layout-${tag}`,
      `第一层 = ${SKILL_NAME}/，${fileCount} 个文件，${SKILL_NAME}/SKILL.md 直接位于第一层`
    );
  } catch (e) {
    bad(`zip-layout-${tag}`, e.message);
  }
}

/* ---------- 命令层纯函数自测 ---------- */
if (SELF_TEST) {
  const { pathToFileURL } = await import("node:url");
  const load = (rel) =>
    import(pathToFileURL(path.join(SKILL_SRC, "scripts", "commands", rel)).href);
  const { measure, parsePoints } = await load("measure.mjs");
  const { buildOptions } = await load("compare.mjs");

  const close = (a, b) => Math.abs(a - b) < 1e-6;

  const pts = parsePoints("0,0;3000,4000");
  if (pts.length === 2) ok("measure-parse", `${pts.length} 点`);
  else bad("measure-parse", JSON.stringify(pts));

  const d = measure({ kind: "distance", points: "0,0;3000,4000" });
  if (close(d.distance, 5000) && close(d.azimuthDeg, 53.13)) ok("measure-distance", `${d.distance}`);
  else bad("measure-distance", JSON.stringify(d));

  const len = measure({ kind: "length", points: "0,0;1000,0;1000,500" });
  if (close(len.total, 1500) && len.segments.length === 2) ok("measure-length", `${len.total}`);
  else bad("measure-length", JSON.stringify(len));

  const area = measure({ kind: "area", points: "0,0;4000,0;4000,3000;0,3000" });
  if (close(area.area, 12_000_000) && close(area.perimeter, 14000)) ok("measure-area", `${area.area}`);
  else bad("measure-area", JSON.stringify(area));

  const ang = measure({ kind: "angle", points: "1000,0;0,0;0,1000" });
  if (close(ang.angleDeg, 90)) ok("measure-angle", `${ang.angleDeg}`);
  else bad("measure-angle", JSON.stringify(ang));

  const opt = buildOptions({ tolerance: "0.01", props: "color,layer", "include-hatch": true });
  if (opt.tolerance === 0.01 && opt.compareProps.join(",") === "color,layer" && opt.includeHatch) {
    ok("compare-options", JSON.stringify(opt));
  } else bad("compare-options", JSON.stringify(opt));

  let rejected = false;
  try {
    buildOptions({ props: "color,not-a-prop" });
  } catch {
    rejected = true;
  }
  if (rejected) ok("compare-options-reject", "非法 --props 被拒");
  else bad("compare-options-reject", "非法 --props 未被拒绝");
}

const failed = results.filter((r) => !r.ok);
const output = {
  ok: failed.length === 0,
  target: PACKAGE_DIR || skillDir,
  zips: ZIP_PATHS,
  appVersion: version,
  skillName: SKILL_NAME,
  checks: results,
};
process.stdout.write(JSON.stringify(output, null, 2) + "\n");
process.exitCode = failed.length ? 1 : 0;
