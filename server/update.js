/**
 * 自动更新核心逻辑（纯 Node，无新增依赖）。
 *
 * 设计要点：
 *   · 完整包（CADViewer-<ver>-win64.zip）用于首次安装；
 *   · 更新包（CADViewer-<ver>-win64-update.zip）只含 server/ web/dist/ start.bat 等，
 *     体积小，下载后解压到 data/updates/<ver>/stage 再由 scripts/apply-update.ps1 覆盖。
 *   · 所有“预期内”的失败都返回 { ok:false, error }，不抛异常；只有参数用错才抛 TypeError。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { once } from "node:events";
import { Readable } from "node:stream";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

// 更新包体积上限：400 MB，防止被异常清单或镜像带偏。
const MAX_ASSET_BYTES = 400 * 1024 * 1024;

// 默认清单地址：GitHub Releases 最新版 API。也支持直接给 update.json 形式的地址。
const DEFAULT_UPDATE_URL =
  "https://api.github.com/repos/NewbimAI/NewbimAI-CADViewer/releases/latest";

// 更新包内必须具备的文件，用于校验解压结果。
const REQUIRED_STAGE_FILES = ["server/index.js", "web/dist/index.html", "start.bat"];

/** 当前版本，导入时从 server/package.json 读取。 */
export const CURRENT_VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(MODULE_DIR, "package.json"), "utf8"));
    return typeof pkg.version === "string" && pkg.version.trim() ? pkg.version.trim() : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

// ---------------------------------------------------------------- 版本号

/** 把 "v0.2.4" / " 0.2.4 " 归一化，并拆出预发布段。 */
function parseVersion(value) {
  const raw = String(value ?? "").trim().replace(/^[vV]/, "");
  const withoutBuild = raw.split("+")[0];
  const dash = withoutBuild.indexOf("-");
  const core = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
  const pre = dash === -1 ? "" : withoutBuild.slice(dash + 1);
  const nums = core.split(".").map((part) => {
    const m = /^\d+/.exec(part.trim());
    return m ? Number(m[0]) : 0;
  });
  return { nums, pre };
}

function comparePrerelease(a, b) {
  if (!a && !b) return 0;
  if (!a) return 1; // 有正式版 > 有预发布
  if (!b) return -1;
  const pa = a.split(".");
  const pb = b.split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const dx = Number(x);
      const dy = Number(y);
      if (dx !== dy) return dx < dy ? -1 : 1;
    } else if (nx !== ny) {
      return nx ? -1 : 1; // 数字标识 < 字符串标识
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * 类 semver 比较，容忍 "0.2.4"、"v0.2.4"、缺段（"0.2" 视为 0.2.0）。
 * @returns {-1|0|1}
 */
export function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  const len = Math.max(va.nums.length, vb.nums.length);
  for (let i = 0; i < len; i += 1) {
    const x = va.nums[i] ?? 0;
    const y = vb.nums[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return comparePrerelease(va.pre, vb.pre);
}

// ---------------------------------------------------------------- 清单

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanVersion(value) {
  return text(value).replace(/^[vV]/, "");
}

function normalizeSha(value) {
  const s = text(value).replace(/^sha256:/i, "");
  return /^[0-9a-f]{64}$/i.test(s) ? s.toLowerCase() : "";
}

function basenameOfUrl(value) {
  const s = text(value);
  if (!s) return "";
  try {
    const name = new URL(s).pathname.split("/").pop() || "";
    return decodeURIComponent(name);
  } catch {
    return s.split(/[\\/]/).pop() || "";
  }
}

/** 归一化清单里的单个 asset（兼容字符串、file/name、url/browser_download_url、digest）。 */
function normalizeAsset(asset) {
  if (!asset) return null;
  if (typeof asset === "string") {
    return { file: basenameOfUrl(asset), size: 0, sha256: "", url: asset };
  }
  if (typeof asset !== "object" || Array.isArray(asset)) return null;
  const url = text(asset.url) || text(asset.browser_download_url);
  const file = text(asset.file) || text(asset.name) || basenameOfUrl(url);
  if (!file && !url) return null;
  const out = {
    file,
    size: Number.isFinite(Number(asset.size)) ? Number(asset.size) : 0,
    sha256: normalizeSha(asset.sha256 || asset.digest),
  };
  if (url) out.url = url;
  return out;
}

function normalizePlainManifest(json) {
  const assets =
    json.assets && typeof json.assets === "object" && !Array.isArray(json.assets) ? json.assets : {};
  const notes = json.notes ?? json.body;
  return {
    version: cleanVersion(json.version),
    releasedAt: text(json.releasedAt || json.released_at || json.publishedAt),
    channel: text(json.channel) || "stable",
    minVersion: cleanVersion(json.minVersion || json.min_version),
    notes: typeof notes === "string" ? notes : "",
    assets: {
      full: normalizeAsset(assets.full),
      update: normalizeAsset(assets.update),
    },
  };
}

function normalizeGitHubRelease(json) {
  const list = Array.isArray(json.assets) ? json.assets : [];
  const isUpdate = (a) => /-update\.zip$/i.test(text(a?.name));
  const update = list.find(isUpdate) || null;
  const full = list.find((a) => /\.zip$/i.test(text(a?.name)) && !isUpdate(a)) || null;
  return {
    version: cleanVersion(json.tag_name || json.name),
    releasedAt: text(json.published_at || json.created_at) || new Date().toISOString(),
    channel: json.prerelease ? "beta" : "stable",
    // GitHub Release 没有 minVersion 元数据，留空表示不限制。
    minVersion: "",
    notes: typeof json.body === "string" ? json.body : "",
    assets: {
      full: normalizeAsset(full),
      update: normalizeAsset(update),
    },
  };
}

/** 识别清单形态：普通 update.json 或 GitHub Release JSON，返回统一结构；无法识别返回 null。 */
function normalizeManifest(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  // GitHub Release：assets 是数组，且带 tag_name / published_at / prerelease 之一。
  if (
    Array.isArray(json.assets) &&
    (typeof json.tag_name === "string" || typeof json.published_at === "string" || "prerelease" in json)
  ) {
    const normalized = normalizeGitHubRelease(json);
    if (!normalized.version) return null;
    return normalized;
  }
  if (typeof json.version === "string" && json.version.trim()) {
    return normalizePlainManifest(json);
  }
  return null;
}

// ---------------------------------------------------------------- 更新源

/**
 * 读取清单地址列表，优先级：
 *   1. 环境变量 CADVIEWER_UPDATE_URL（逗号分隔，可多个）；
 *   2. <root>/data/update-source.json（{ "urls": [...] } 或数组）；
 *   3. 默认 GitHub Releases 最新版 API。
 */
export function readUpdateSources(root) {
  const fromEnv = text(process.env.CADVIEWER_UPDATE_URL);
  if (fromEnv) {
    const urls = fromEnv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (urls.length) return urls;
  }

  const sourceFile = path.join(String(root || "."), "data", "update-source.json");
  try {
    const raw = JSON.parse(fs.readFileSync(sourceFile, "utf8"));
    const list = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.urls)
        ? raw.urls
        : typeof raw?.url === "string"
          ? [raw.url]
          : [];
    const urls = list.map(text).filter(Boolean);
    if (urls.length) return urls;
  } catch {
    // 文件不存在或格式不对时静默回落到默认地址。
  }

  return [DEFAULT_UPDATE_URL];
}

function errorText(err) {
  if (!err) return "未知错误";
  if (err.name === "TimeoutError" || err.name === "AbortError") return "请求超时";
  const code = err.code || err.cause?.code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ENETUNREACH") return "网络不可用";
  return err.message || String(err);
}

/**
 * 依次尝试各个清单地址，返回第一个可用的清单。
 * @returns {Promise<{ok:boolean, manifest:object|null, source:string|null, error:string|null, attempts:string[]}>}
 */
export async function fetchManifest({ root, sources, timeoutMs = 20000, fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== "function") {
    return {
      ok: false,
      manifest: null,
      source: null,
      error: "当前运行环境不支持网络请求",
      attempts: [],
    };
  }

  const list = Array.isArray(sources) && sources.length ? sources : readUpdateSources(root);
  const attempts = [];

  for (const url of list) {
    try {
      const res = await doFetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          accept: "application/json",
          "user-agent": `CADViewer/${CURRENT_VERSION}`,
        },
      });
      if (!res || !res.ok) {
        attempts.push(`${url}：HTTP ${res?.status ?? "无响应"}`);
        continue;
      }
      const json = await res.json();
      const manifest = normalizeManifest(json);
      if (!manifest) {
        attempts.push(`${url}：无法识别的清单格式`);
        continue;
      }
      return { ok: true, manifest, source: url, error: null, attempts };
    } catch (err) {
      attempts.push(`${url}：${errorText(err)}`);
    }
  }

  return {
    ok: false,
    manifest: null,
    source: list[0] ?? null,
    error: `检查更新失败：${attempts.join("；") || "没有可用的更新地址"}`,
    attempts,
  };
}

// ---------------------------------------------------------------- 检查更新

/**
 * 检查是否需要更新。
 * @returns {Promise<{current:string, latest:string|null, available:boolean, manifest:object|null, source:string|null, error?:string}>}
 */
export async function checkForUpdate({ root, timeoutMs, fetchImpl } = {}) {
  const current = CURRENT_VERSION;
  const found = await fetchManifest({ root, timeoutMs, fetchImpl });

  if (!found.ok) {
    return {
      current,
      latest: null,
      available: false,
      manifest: null,
      source: found.source,
      error: found.error,
    };
  }

  const manifest = found.manifest;
  const latest = manifest.version;
  let available = compareVersions(latest, current) > 0;
  let error;

  if (available && manifest.minVersion && compareVersions(current, manifest.minVersion) < 0) {
    available = false;
    error = `当前版本过低（${current}），请先手动下载完整安装包升级到 ${manifest.minVersion} 或更高版本`;
  }

  return {
    current,
    latest,
    available,
    manifest,
    source: found.source,
    ...(error ? { error } : {}),
  };
}

// ---------------------------------------------------------------- 下载

function buildProgress(onProgress) {
  let last = 0;
  return (received, total, force = false) => {
    if (typeof onProgress !== "function") return;
    const now = Date.now();
    if (!force && now - last < 100) return; // 约 10 次/秒
    last = now;
    try {
      onProgress({ received, total });
    } catch {
      // 回调里的异常不能影响下载。
    }
  };
}

async function closeQuietly(stream) {
  if (!stream) return;
  try {
    stream.destroy();
  } catch {
    // 忽略
  }
  if (!stream.closed) {
    try {
      await once(stream, "close");
    } catch {
      // 忽略
    }
  }
}

/**
 * 流式下载更新包到 <root>/data/updates/<version>/。
 * 成功时先校验大小与 SHA256，再原子改名去掉 .part 后缀。
 * @returns {Promise<{ok:boolean, path?:string, size?:number, sha256?:string, error?:string}>}
 */
export async function downloadAsset({
  root,
  version,
  assetUrl,
  sha256,
  size,
  onProgress,
  timeoutMs = 600000,
  fetchImpl,
} = {}) {
  // 参数用错属于程序错误，直接抛。
  if (typeof root !== "string" || !root) throw new TypeError("downloadAsset: root 必须是非空字符串");
  if (typeof version !== "string" || !version) throw new TypeError("downloadAsset: version 必须是非空字符串");
  if (typeof assetUrl !== "string" || !assetUrl) {
    throw new TypeError("downloadAsset: assetUrl 必须是非空字符串");
  }

  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== "function") return { ok: false, error: "当前运行环境不支持网络请求" };

  const declared = Number(size) > 0 ? Number(size) : 0;
  if (declared > MAX_ASSET_BYTES) {
    return { ok: false, error: "更新包超过 400 MB 上限，已取消下载" };
  }

  const name = basenameOfUrl(assetUrl) || updatePaths(root).zipPath(version).split(/[\\/]/).pop();
  const dir = updatePaths(root).versionDir(version);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { ok: false, error: `无法创建下载目录：${errorText(err)}` };
  }

  const partPath = path.join(dir, `${name}.part`);
  const finalPath = path.join(dir, name);
  fs.rmSync(partPath, { force: true });

  let res;
  try {
    res = await doFetch(assetUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": `CADViewer/${CURRENT_VERSION}` },
    });
  } catch (err) {
    return { ok: false, error: `下载失败：${errorText(err)}` };
  }
  if (!res || !res.ok) {
    return { ok: false, error: `下载失败：HTTP ${res?.status ?? "无响应"}` };
  }
  if (!res.body) return { ok: false, error: "下载失败：响应内容为空" };

  const headerTotal = Number(res.headers?.get?.("content-length")) || 0;
  const total = declared || headerTotal;
  if (total > MAX_ASSET_BYTES) {
    return { ok: false, error: "更新包超过 400 MB 上限，已取消下载" };
  }

  const hash = crypto.createHash("sha256");
  let received = 0;
  const report = buildProgress(onProgress);
  const out = fs.createWriteStream(partPath);

  try {
    report(0, total);
    for await (const chunk of Readable.fromWeb(res.body)) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buf.length;
      if (received > MAX_ASSET_BYTES) throw new Error("更新包超过 400 MB 上限");
      hash.update(buf);
      // 显式处理背压，避免大文件把内存撑爆。
      if (!out.write(buf)) await once(out, "drain");
      report(received, total);
    }

    await new Promise((resolve, reject) => {
      out.end((err) => (err ? reject(err) : resolve()));
    });

    const digest = hash.digest("hex");
    if (declared && received !== declared) {
      throw new Error(`大小不一致（期望 ${declared} 字节，实际 ${received} 字节）`);
    }
    if (sha256 && digest.toLowerCase() !== String(sha256).toLowerCase()) {
      throw new Error("SHA256 校验失败");
    }

    // 落盘后再改名，尽量减少断电导致的半成品。
    const fd = fs.openSync(partPath, "r+");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    fs.rmSync(finalPath, { force: true });
    fs.renameSync(partPath, finalPath);
    report(received, total, true);

    return { ok: true, path: finalPath, size: received, sha256: digest };
  } catch (err) {
    await closeQuietly(out);
    fs.rmSync(partPath, { force: true });
    return { ok: false, error: `下载失败：${errorText(err)}` };
  }
}

// ---------------------------------------------------------------- 解压

function psQuote(value) {
  return String(value).replace(/'/g, "''");
}

function stageLooksValid(stageDir) {
  return REQUIRED_STAGE_FILES.every((rel) => fs.existsSync(path.join(stageDir, rel)));
}

/**
 * 把更新包解压到 <root>/data/updates/<version>/stage 并校验目录结构。
 * 优先用系统自带 tar.exe（Win10+ 的 bsdtar，可直接读 zip），失败再退回 Expand-Archive。
 * @returns {Promise<{stageDir:string, ok:boolean, error?:string, missing?:string[]}>}
 */
export async function stageUpdate({ root, version, zipPath } = {}) {
  if (typeof root !== "string" || !root) throw new TypeError("stageUpdate: root 必须是非空字符串");
  if (typeof version !== "string" || !version) throw new TypeError("stageUpdate: version 必须是非空字符串");
  if (typeof zipPath !== "string" || !zipPath) throw new TypeError("stageUpdate: zipPath 必须是非空字符串");

  const stageDir = updatePaths(root).stageDir(version);
  if (!fs.existsSync(zipPath)) {
    return { stageDir, ok: false, error: "更新包不存在，请重新下载" };
  }

  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });

  let tarError = null;
  try {
    execFileSync("tar.exe", ["-xf", zipPath, "-C", stageDir], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (!stageLooksValid(stageDir)) throw new Error("解压结果缺少必要文件");
  } catch (err) {
    tarError = err;
    // tar 失败或结果不对：清空后改用 PowerShell 再试一次。
    fs.rmSync(stageDir, { recursive: true, force: true });
    fs.mkdirSync(stageDir, { recursive: true });
    try {
      execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Expand-Archive -LiteralPath '${psQuote(zipPath)}' -DestinationPath '${psQuote(stageDir)}' -Force`,
        ],
        { stdio: "ignore", windowsHide: true },
      );
    } catch (err2) {
      fs.rmSync(stageDir, { recursive: true, force: true });
      return { stageDir, ok: false, error: `解压失败：${errorText(err2 || tarError)}` };
    }
  }

  const missing = REQUIRED_STAGE_FILES.filter((rel) => !fs.existsSync(path.join(stageDir, rel)));
  if (missing.length) {
    fs.rmSync(stageDir, { recursive: true, force: true });
    return { stageDir, ok: false, error: "更新包结构不正确", missing };
  }

  return { stageDir, ok: true };
}

// ---------------------------------------------------------------- 路径与权限

/**
 * 返回更新相关目录/文件路径。
 * @returns {{stateDir:string, versionDir:Function, zipPath:Function, stageDir:Function}}
 */
export function updatePaths(root) {
  if (typeof root !== "string" || !root) throw new TypeError("updatePaths: root 必须是非空字符串");
  const base = String(root);
  const stateDir = path.join(base, "data", "updates");
  const versionDir = (version) => path.join(stateDir, String(version));
  const zipPath = (version) =>
    path.join(versionDir(version), `CADViewer-${version}-win64-update.zip`);
  const stageDir = (version) => path.join(versionDir(version), "stage");
  return { stateDir, versionDir, zipPath, stageDir };
}

/**
 * 粗检查安装目录是否可写（Program Files 等位置通常需要管理员权限）。
 * @returns {{ok:boolean, reason?:string}}
 */
export function canSelfUpdate(root) {
  if (typeof root !== "string" || !root) throw new TypeError("canSelfUpdate: root 必须是非空字符串");

  try {
    if (!fs.statSync(root).isDirectory()) return { ok: false, reason: "安装目录不存在或不是文件夹" };
  } catch {
    return { ok: false, reason: "安装目录不存在" };
  }

  const serverDir = path.join(root, "server");
  try {
    if (!fs.statSync(serverDir).isDirectory()) throw new Error("not a directory");
  } catch {
    return { ok: false, reason: "安装目录不完整：找不到 server 目录" };
  }

  try {
    fs.accessSync(root, fs.constants.W_OK);
    fs.accessSync(serverDir, fs.constants.W_OK);
  } catch {
    return { ok: false, reason: "安装目录不可写，请把它移到用户目录后重试" };
  }

  return { ok: true };
}
