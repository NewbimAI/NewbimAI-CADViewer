/**
 * Skill 清单（skill.json）读取与版本解析。
 *
 * 版本策略：Skill 与 App 同版本，**唯一事实源是 server/package.json 的 version**。
 * 源码树里的 skill.json 不写 version；打包时由 scripts/build-skill.mjs 注入。
 * 因此这里先读 skill.json，缺 version 时回退 server/package.json，并如实报告来源。
 */
import fs from "node:fs";
import path from "node:path";

export const SKILL_NAME = "NewbimAI-CADViewer-Skill";

export function readJsonFile(file) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, "utf8")), error: null };
  } catch (e) {
    return { ok: false, value: null, error: e && e.message ? e.message : String(e) };
  }
}

/** @param {string} skillRoot 含 SKILL.md / skill.json 的目录 */
export function loadManifest(skillRoot) {
  const file = path.join(skillRoot, "skill.json");
  const res = readJsonFile(file);
  if (!res.ok) return { ok: false, path: file, error: res.error, manifest: null };
  return { ok: true, path: file, error: null, manifest: res.value };
}

/**
 * @param {{ root: string, skillRoot: string, manifest: object|null }} args
 */
export function resolveVersions({ root, skillRoot, manifest }) {
  const pkg = readJsonFile(path.join(root, "server", "package.json"));
  const appVersion = pkg.ok && pkg.value && pkg.value.version ? String(pkg.value.version) : null;

  const fromManifest =
    manifest && typeof manifest.version === "string" && manifest.version.trim()
      ? manifest.version.trim()
      : null;

  const skillVersion = fromManifest || appVersion;
  const versionSource = fromManifest
    ? path.relative(root, path.join(skillRoot, "skill.json")) + "#version（打包时注入）"
    : "server/package.json#version";

  const minAppVersion =
    manifest && typeof manifest.minAppVersion === "string" ? manifest.minAppVersion : null;

  return {
    appVersion,
    skillVersion,
    versionSource,
    minAppVersion,
    sameVersion: !!appVersion && appVersion === skillVersion,
    satisfiesMin:
      !minAppVersion || !appVersion ? null : compareVersions(appVersion, minAppVersion) >= 0,
    packageVersionError: pkg.ok ? null : pkg.error,
  };
}

/** 语义化版本的数值比较（只支持主.次.修订，足够本用途）。 */
export function compareVersions(a, b) {
  const pa = String(a)
    .split(/[.+-]/)
    .map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b)
    .split(/[.+-]/)
    .map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}
