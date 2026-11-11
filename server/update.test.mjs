/**
 * server/update.js 单元测试，全部离线运行。
 *   node --test server/update.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CURRENT_VERSION,
  compareVersions,
  readUpdateSources,
  fetchManifest,
  checkForUpdate,
  canSelfUpdate,
  updatePaths,
} from "./update.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

/** 构造一个假的 fetch，返回固定 JSON。 */
function fakeFetch(payload, { status = 200 } = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => payload,
  });
}

function plainManifest(overrides = {}) {
  return {
    version: "0.2.5",
    releasedAt: "2026-11-07T00:00:00Z",
    channel: "stable",
    minVersion: "0.2.0",
    notes: "",
    assets: {
      full: { file: "CADViewer-0.2.5-win64.zip", size: 1000, sha256: SHA_A },
      update: { file: "CADViewer-0.2.5-win64-update.zip", size: 200, sha256: SHA_B },
    },
    ...overrides,
  };
}

function githubRelease(overrides = {}) {
  return {
    tag_name: "v0.2.5",
    body: "修了几个问题",
    prerelease: false,
    published_at: "2026-11-07T00:00:00Z",
    assets: [
      {
        name: "CADViewer-0.2.5-win64.zip",
        size: 1000,
        browser_download_url: "https://example.test/download/CADViewer-0.2.5-win64.zip",
        digest: `sha256:${SHA_A}`,
      },
      {
        name: "CADViewer-0.2.5-win64-update.zip",
        size: 200,
        browser_download_url: "https://example.test/download/CADViewer-0.2.5-win64-update.zip",
        digest: `sha256:${SHA_B}`,
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------- compareVersions

test("compareVersions: 相等", () => {
  assert.equal(compareVersions("0.2.4", "0.2.4"), 0);
});

test("compareVersions: 补丁号差异", () => {
  assert.equal(compareVersions("0.2.4", "0.2.5"), -1);
  assert.equal(compareVersions("0.2.5", "0.2.4"), 1);
});

test("compareVersions: 次版本号差异", () => {
  assert.equal(compareVersions("0.2.9", "0.3.0"), -1);
  assert.equal(compareVersions("1.0.0", "0.9.9"), 1);
});

test("compareVersions: 缺段按 0 处理", () => {
  assert.equal(compareVersions("0.2", "0.2.0"), 0);
  assert.equal(compareVersions("1", "1.0.0"), 0);
  assert.equal(compareVersions("0.2", "0.2.1"), -1);
});

test("compareVersions: 容忍 v 前缀与空白", () => {
  assert.equal(compareVersions("v0.2.4", "0.2.4"), 0);
  assert.equal(compareVersions(" V1.2.3 ", "1.2.3"), 0);
});

test("compareVersions: 多位数字按数值比较", () => {
  assert.equal(compareVersions("0.2.10", "0.2.9"), 1);
  assert.equal(compareVersions("0.10.0", "0.9.0"), 1);
});

test("compareVersions: 预发布小于正式版", () => {
  assert.equal(compareVersions("0.2.4-beta.1", "0.2.4"), -1);
  assert.equal(compareVersions("0.2.4", "0.2.4-rc.1"), 1);
  assert.equal(compareVersions("0.2.4-beta.2", "0.2.4-beta.10"), -1);
});

// ---------------------------------------------------------------- 清单形态

test("fetchManifest: 识别普通 update.json", async () => {
  const url = "https://example.test/update.json";
  const result = await fetchManifest({
    root: process.cwd(),
    sources: [url],
    fetchImpl: fakeFetch(plainManifest()),
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, url);
  assert.equal(result.manifest.version, "0.2.5");
  assert.equal(result.manifest.channel, "stable");
  assert.equal(result.manifest.minVersion, "0.2.0");
  assert.deepEqual(result.manifest.assets.update, {
    file: "CADViewer-0.2.5-win64-update.zip",
    size: 200,
    sha256: SHA_B,
  });
});

test("fetchManifest: 普通清单去掉版本前缀 v", async () => {
  const result = await fetchManifest({
    root: process.cwd(),
    sources: ["https://example.test/update.json"],
    fetchImpl: fakeFetch(plainManifest({ version: "v0.2.5" })),
  });
  assert.equal(result.ok, true);
  assert.equal(result.manifest.version, "0.2.5");
});

test("fetchManifest: 识别 GitHub Release JSON", async () => {
  const url = "https://api.github.com/repos/NewbimAI/NewbimAI-CADViewer/releases/latest";
  const result = await fetchManifest({
    root: process.cwd(),
    sources: [url],
    fetchImpl: fakeFetch(githubRelease()),
  });

  assert.equal(result.ok, true);
  assert.equal(result.manifest.version, "0.2.5");
  assert.equal(result.manifest.notes, "修了几个问题");
  assert.equal(result.manifest.channel, "stable");
  assert.equal(result.manifest.releasedAt, "2026-11-07T00:00:00Z");
  // 更新包 = 名字以 -update.zip 结尾的资产；完整包 = 剩下的普通 zip。
  assert.equal(result.manifest.assets.update.file, "CADViewer-0.2.5-win64-update.zip");
  assert.equal(result.manifest.assets.update.size, 200);
  assert.equal(result.manifest.assets.update.sha256, SHA_B);
  assert.equal(
    result.manifest.assets.update.url,
    "https://example.test/download/CADViewer-0.2.5-win64-update.zip",
  );
  assert.equal(result.manifest.assets.full.file, "CADViewer-0.2.5-win64.zip");
  assert.equal(result.manifest.assets.full.sha256, SHA_A);
});

test("fetchManifest: GitHub 预发布标为 beta", async () => {
  const result = await fetchManifest({
    root: process.cwd(),
    sources: ["https://api.github.com/repos/x/y/releases/latest"],
    fetchImpl: fakeFetch(githubRelease({ prerelease: true })),
  });
  assert.equal(result.ok, true);
  assert.equal(result.manifest.channel, "beta");
});

test("fetchManifest: 第一个源失败后回落到第二个源", async () => {
  const sources = ["https://bad.test/update.json", "https://good.test/update.json"];
  let index = 0;
  const fetchImpl = async (url) => {
    if (url === sources[0]) {
      index += 1;
      return { ok: false, status: 503, headers: { get: () => null }, json: async () => ({}) };
    }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => plainManifest() };
  };

  const result = await fetchManifest({ root: process.cwd(), sources, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.source, sources[1]);
  assert.equal(index, 1);
});

test("fetchManifest: 无法识别的格式返回可读错误", async () => {
  const result = await fetchManifest({
    root: process.cwd(),
    sources: ["https://example.test/nope.json"],
    fetchImpl: fakeFetch({ hello: "world" }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.manifest, null);
  assert.match(result.error, /检查更新失败/);
});

test("fetchManifest: 网络异常不抛错", async () => {
  const result = await fetchManifest({
    root: process.cwd(),
    sources: ["https://example.test/update.json"],
    fetchImpl: async () => {
      throw new Error("connect ECONNREFUSED");
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /ECONNREFUSED/);
});

// ---------------------------------------------------------------- checkForUpdate

test("checkForUpdate: 新版本可用", async () => {
  const result = await checkForUpdate({
    root: process.cwd(),
    fetchImpl: fakeFetch(plainManifest({ version: "99.0.0", minVersion: "" })),
  });
  assert.equal(result.current, CURRENT_VERSION);
  assert.equal(result.latest, "99.0.0");
  assert.equal(result.available, true);
  assert.equal(result.error, undefined);
});

test("checkForUpdate: minVersion 不满足时不可自动更新", async () => {
  const result = await checkForUpdate({
    root: process.cwd(),
    fetchImpl: fakeFetch(plainManifest({ version: "99.0.0", minVersion: "99.0.0" })),
  });
  assert.equal(result.available, false);
  assert.match(result.error, /当前版本过低/);
});

// ---------------------------------------------------------------- 更新源

test("readUpdateSources: 环境变量优先且支持逗号分隔", () => {
  const previous = process.env.CADVIEWER_UPDATE_URL;
  process.env.CADVIEWER_UPDATE_URL = " https://a.test/u.json , https://b.test/u.json ";
  try {
    assert.deepEqual(readUpdateSources(process.cwd()), [
      "https://a.test/u.json",
      "https://b.test/u.json",
    ]);
  } finally {
    if (previous === undefined) delete process.env.CADVIEWER_UPDATE_URL;
    else process.env.CADVIEWER_UPDATE_URL = previous;
  }
});

test("readUpdateSources: 读取 data/update-source.json", () => {
  const previous = process.env.CADVIEWER_UPDATE_URL;
  delete process.env.CADVIEWER_UPDATE_URL;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cadviewer-src-"));
  try {
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "data", "update-source.json"),
      JSON.stringify({ urls: ["https://mirror.test/update.json"] }),
      "utf8",
    );
    assert.deepEqual(readUpdateSources(root), ["https://mirror.test/update.json"]);
  } finally {
    if (previous !== undefined) process.env.CADVIEWER_UPDATE_URL = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("readUpdateSources: 默认回落到 GitHub Releases", () => {
  const previous = process.env.CADVIEWER_UPDATE_URL;
  delete process.env.CADVIEWER_UPDATE_URL;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cadviewer-src-"));
  try {
    const sources = readUpdateSources(root);
    assert.equal(sources.length, 1);
    assert.match(sources[0], /api\.github\.com\/repos\/NewbimAI\/NewbimAI-CADViewer\/releases\/latest/);
  } finally {
    if (previous !== undefined) process.env.CADVIEWER_UPDATE_URL = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 权限与路径

test("canSelfUpdate: 可写的临时目录返回 ok", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cadviewer-root-"));
  try {
    fs.mkdirSync(path.join(root, "server"), { recursive: true });
    assert.deepEqual(canSelfUpdate(root), { ok: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("canSelfUpdate: 缺少 server 目录时给出中文原因", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cadviewer-root-"));
  try {
    const result = canSelfUpdate(root);
    assert.equal(result.ok, false);
    assert.match(result.reason, /server/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("canSelfUpdate: 目录不存在时给出中文原因", () => {
  const result = canSelfUpdate(path.join(os.tmpdir(), "cadviewer-not-exist-" + Date.now()));
  assert.equal(result.ok, false);
  assert.match(result.reason, /安装目录不存在/);
});

test("updatePaths: 目录布局符合约定", () => {
  const root = path.join("C:", "some dir", "CADViewer");
  const paths = updatePaths(root);
  assert.equal(paths.stateDir, path.join(root, "data", "updates"));
  assert.equal(paths.versionDir("0.2.5"), path.join(paths.stateDir, "0.2.5"));
  assert.equal(
    paths.zipPath("0.2.5"),
    path.join(paths.stateDir, "0.2.5", "CADViewer-0.2.5-win64-update.zip"),
  );
  assert.equal(paths.stageDir("0.2.5"), path.join(paths.stateDir, "0.2.5", "stage"));
});
