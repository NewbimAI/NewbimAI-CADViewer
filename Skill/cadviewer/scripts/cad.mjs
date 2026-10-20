#!/usr/bin/env node
/**
 * CADViewer Skill CLI —— 供 agent 直接调用，完全脱离浏览器。
 *
 * 设计要点（勿随意改动）：
 *  1. 所有统计一律复用产品自己的 server/scanner.js 等模块（动态 import），
 *     所以这里的数字与界面显示的**必然是同一口径**。
 *  2. 项目根不在脚本里写死：Skill 目录可能被复制到 ~/.config/opencode/skills/，
 *     静态 import ../../../server 会断。因此先解析根目录，再按绝对路径动态 import。
 *  3. 输出永远是 JSON（stdout），失败是 stderr 上的 {"error":...} + exit 1。
 *  4. DWG 只转换一次，产物缓存在 server/cache/skill/<sha1(绝对路径) 前 12 位>/converted.dxf。
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

/* ───────────────────────── 通用工具 ───────────────────────── */

function sha1(text) {
  return crypto.createHash("sha1").update(text).digest("hex");
}

function hashFile(filePath, algorithm = "sha256") {
  return crypto.createHash(algorithm).update(fs.readFileSync(filePath)).digest("hex");
}

function printJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function fail(message) {
  const err = new Error(message);
  err.isCliError = true;
  throw err;
}

function toAbs(p) {
  return path.resolve(process.cwd(), p);
}

function parseNonNegativeInt(value, flag) {
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) {
    fail(`${flag} 需要一个非负整数，收到: ${value}`);
  }
  return Number.parseInt(text, 10);
}

/* ───────────────────────── 项目根解析 ───────────────────────── */

/**
 * 项目根判据：存在 server/scanner.js（文件）。
 * ⚠️ **不要求 `bin/`**：`bin/cadcraft/` 被 .gitignore 排除，新克隆里根本没有；而"只做 DXF 统计"
 *    并不需要 cadcraft。缺转换器只影响 DWG 输入与导出，那些路径会各自报明确错误，`doctor` 也会报。
 * 只把根用于定位 server/* 和 bin/cadcraft/，不依赖当前工作目录。
 */
function isProjectRoot(dir) {
  try {
    return fs.statSync(path.join(dir, "server", "scanner.js")).isFile();
  } catch {
    return false;
  }
}

function resolveProjectRoot(explicitRoot) {
  if (explicitRoot) {
    const abs = toAbs(explicitRoot);
    if (!isProjectRoot(abs)) {
      fail(
        `--root 指向的目录不是 CADViewer 项目根: ${abs}\n` +
          `判据：该目录下应有 server/scanner.js。`
      );
    }
    return abs;
  }

  const envRoot = process.env.CADVIEWER_ROOT;
  if (envRoot) {
    const abs = toAbs(envRoot);
    if (!isProjectRoot(abs)) {
      fail(
        `环境变量 CADVIEWER_ROOT 指向的目录不是 CADViewer 项目根: ${abs}\n` +
          `判据：该目录下应有 server/scanner.js。`
      );
    }
    return abs;
  }

  // 3) 从**脚本自身位置**向上找。
  //    轻量包的布局是 <包>/Skill/cadviewer/scripts/cad.mjs，所以只要 Skill 是从包里
  //    链接/复制到 agent skills 目录的，就无需 --root、也无需 CADVIEWER_ROOT。
  //    （Node 默认解析 symlink，import.meta.url 拿到的是包内真实路径。）
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    while (true) {
      if (isProjectRoot(dir)) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* 取脚本路径失败就继续走 cwd */
  }

  let dir = process.cwd();
  while (true) {
    if (isProjectRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  fail(
    `找不到 CADViewer 项目根。请用以下任一方式指定：\n` +
      `  1) node cad.mjs <命令> ... --root "<CADViewer 项目根>"\n` +
      `  2) set CADVIEWER_ROOT=<CADViewer 项目根>\n` +
      `  3) 运行 Skill\\install.ps1（或 install.sh）把 Skill 链进 agent 目录——装好后无需任何变量\n` +
      `判据：<根>/server/scanner.js 存在。`
  );
}

/* ───────────────────────── 模块加载（动态） ───────────────────────── */

async function loadServerModules(root) {
  const dir = path.join(root, "server");
  const load = (name) =>
    import(pathToFileURL(path.join(dir, name)).href);
  const [cadcraft, scanner, tch, svgPdf] = await Promise.all([
    load("cadcraft.js"),
    load("scanner.js"),
    load("tch-detect.js"),
    load("svg-pdf.js"),
  ]);
  return {
    resolveCliPath: cadcraft.resolveCliPath,
    CadcraftCli: cadcraft.CadcraftCli,
    scanDxf: scanner.scanDxf,
    decodeDxfName: scanner.decodeDxfName,
    detectTch: tch.detectTch,
    convertSvgToPdf: svgPdf.convertSvgToPdf,
  };
}

/* ───────────────────────── 缓存 ───────────────────────── */

/**
 * 每张源图一个缓存目录：server/cache/skill/<sha1(绝对路径) 前 12 位>/
 *  · converted.dxf —— DWG 转换产物（.dxf 输入直接使用源文件，绝不复制）
 *  · 导出默认产物 / PDF 临时 SVG 也放这里
 * server/cache/ 已被 .gitignore 覆盖，无需新增规则。
 */
function cacheDirFor(ctx, srcAbs) {
  const key = sha1(path.resolve(srcAbs)).slice(0, 12);
  return path.join(ctx.root, "server", "cache", "skill", key);
}

function ensureCacheDir(ctx, srcAbs) {
  const dir = cacheDirFor(ctx, srcAbs);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function fileLooksUsable(filePath) {
  try {
    return fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

/**
 * 取得可用于扫描/导出的 DXF：
 *  - .dxf 输入 → 直接用源文件（不复制、不缓存）；
 *  - .dwg 输入 → 走 cadcraft 转成缓存目录里的 converted.dxf。
 * 缓存命中条件：产物存在且不比源文件旧（源图被替换后自动重转）。
 */
async function ensureDxf(ctx, srcAbs) {
  const key = path.resolve(srcAbs);
  if (ctx._dxfMemo.has(key)) return ctx._dxfMemo.get(key);

  const task = (async () => {
    const ext = path.extname(srcAbs).toLowerCase();
    if (ext === ".dxf") {
      return { dxfPath: srcAbs, converted: false, fromCache: false };
    }
    if (ext !== ".dwg") {
      fail(`不支持的格式 ${ext}，仅支持 DWG/DXF`);
    }

    const dir = ensureCacheDir(ctx, srcAbs);
    const target = path.join(dir, "converted.dxf");
    const srcStat = fs.statSync(srcAbs);

    if (fileLooksUsable(target)) {
      const st = fs.statSync(target);
      if (st.mtimeMs >= srcStat.mtimeMs) {
        return { dxfPath: target, converted: true, fromCache: true };
      }
    }

    const cli = requireCli(ctx);
    const out = await cli.toDxf(srcAbs, target);
    if (!out || !fileLooksUsable(out)) {
      // 转换失败时清掉半成品，避免下次误命中空文件
      try {
        fs.rmSync(target, { force: true });
      } catch {
        /* ignore */
      }
      fail(
        `DWG→DXF 转换失败: ${srcAbs}\n` +
          `请确认 cadcraft-cli 可执行（node Skill/cadviewer/scripts/cad.mjs doctor）。`
      );
    }
    return { dxfPath: out, converted: true, fromCache: false };
  })();

  ctx._dxfMemo.set(key, task);
  try {
    return await task;
  } catch (e) {
    ctx._dxfMemo.delete(key);
    throw e;
  }
}

function requireCli(ctx) {
  if (!ctx.cli) {
    fail(
      `cadcraft-cli 未部署：未在 ${path.join(ctx.root, "bin")} 下找到 cadcraft-cli.exe。\n` +
        `请把 cadcraft 便携版解压到 bin/（需要 bin/cadcraft/**/cadcraft-cli.exe），详见 Skill/README.md。`
    );
  }
  return ctx.cli;
}

/* ───────────────────────── 文字扫描（TEXT/MTEXT） ───────────────────────── */

/** 整文件解码：cadcraft 产物多为 UTF-8/ASCII；老 DXF 可能是 GBK。 */
function decodeDxfBuffer(buf) {
  let body = buf;
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) {
    body = body.subarray(3);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    try {
      return new TextDecoder("gbk", { fatal: false }).decode(body);
    } catch {
      return body.toString("latin1");
    }
  }
}

/**
 * MTEXT/TEXT 可见文本清理：
 *  · 解 \U+XXXX（cadcraft 常把中文写成这种转义）；
 *  · 去掉 {\C256;...} 一类 MTEXT 格式码、\P 换行等；
 *  · 保留 DEC 控制码的常见显示（%%C → ∅、%%D → °、%%P → ±）。
 * 注意：这里只影响“给人看/搜索”的文本，不改动源文件。
 */
function cleanDxfText(raw, decodeName) {
  let t = decodeName(raw);
  for (let prev = null; prev !== t; ) {
    prev = t;
    t = t.replace(/\{[^{}]*;/g, "");
  }
  t = t.replace(/\\P/g, " ").replace(/\\~/g, " ");
  t = t.replace(/\\[A-Za-z][^;\\]*;/g, "");
  t = t.replace(/[{}]/g, "");
  t = t
    .replace(/%%C/gi, "\u2205")
    .replace(/%%D/gi, "\u00b0")
    .replace(/%%P/gi, "\u00b1")
    .replace(/%%%/g, "%");
  return t.replace(/[\r\n]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

/**
 * 自己扫一遍 ENTITIES 段的 TEXT/MTEXT（只收顶层实体；块定义里的文字没有插入变换，
 * 单独统计会答非所问）。返回 items，每项带图层/坐标/字高/样式/旋转。
 */
async function scanTextFile(ctx, dxfPath) {
  const buf = await fsp.readFile(dxfPath);
  const text = decodeDxfBuffer(buf);
  const lines = text.split(/\r?\n/);

  const items = [];
  let expectingCode = true;
  let code = 0;
  let section = null;
  let pendingSection = false;
  let ent = null;

  const finish = () => {
    if (!ent) return;
    const raw = ent.parts.join("");
    const value = cleanDxfText(raw, ctx.mod.decodeDxfName);
    items.push({
      layer: ent.layer || "0",
      text: value,
      x: ent.x,
      y: ent.y,
      h: ent.h,
      style: ent.style || "STANDARD",
      rotation: ent.rotation,
    });
    ent = null;
  };

  const newEntity = (type) => ({
    type,
    layer: null,
    x: null,
    y: null,
    h: 0,
    style: null,
    rotation: 0,
    parts: [],
  });

  for (const rawLine of lines) {
    if (expectingCode) {
      const line = rawLine.trim();
      if (!/^-?\d+$/.test(line)) continue; // 空行/脏行不作为组码，避免整份错位
      code = Number(line);
      expectingCode = false;
      continue;
    }
    expectingCode = true;
    const value = rawLine;

    // 段头 / 段尾
    if (pendingSection) {
      if (code === 2) {
        section = value.trim().toUpperCase();
        pendingSection = false;
      }
      continue;
    }

    if (code === 0) {
      const type = value.trim();
      if (type === "SECTION") {
        finish();
        pendingSection = true;
        continue;
      }
      if (type === "ENDSEC") {
        finish();
        section = null;
        continue;
      }
      if (type === "EOF") break;
      if (section === "ENTITIES") {
        finish();
        if (type === "TEXT" || type === "MTEXT") {
          ent = newEntity(type);
        }
      }
      continue;
    }

    if (section !== "ENTITIES" || !ent) continue;
    if (code === 8) ent.layer = ctx.mod.decodeDxfName(value.trim());
    else if (code === 10) ent.x = parseFloat(value);
    else if (code === 20) ent.y = parseFloat(value);
    else if (code === 40) {
      const h = parseFloat(value);
      if (Number.isFinite(h)) ent.h = h;
    } else if (code === 7) ent.style = ctx.mod.decodeDxfName(value.trim());
    else if (code === 50) {
      const r = parseFloat(value);
      if (Number.isFinite(r)) ent.rotation = r;
    } else if (code === 1 || code === 3) {
      // MTEXT 可能先给若干 3 码分片、最后给 1 码；按出现顺序拼接
      ent.parts.push(value);
    }
  }
  finish();

  return items;
}

/* ───────────────────────── 统计汇总 ───────────────────────── */

/** 一次拿到 scanDxf + cadcraft info + tch（info 仅用于天正 provenance 判定与告警）。 */
async function loadStats(ctx, srcAbs, preparedDxf = null) {
  const dxf = preparedDxf || (await ensureDxf(ctx, srcAbs));
  const infoPromise = ctx.cli ? ctx.cli.infoJson(srcAbs) : Promise.resolve(null);
  const [stats, info] = await Promise.all([ctx.mod.scanDxf(dxf.dxfPath), infoPromise]);
  const tch = ctx.mod.detectTch({ dxfPath: dxf.dxfPath, info });
  return { dxf, stats, info, tch };
}

function topObjectEntries(obj, limit) {
  return Object.entries(obj || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

function buildSummary(ctx, srcAbs, { dxf, stats, info, tch }, textItems) {
  const layers = stats.layers || [];
  const nonEmptyLayers = layers.filter((l) => l.entityCount > 0);
  const blocks = stats.blocks || [];

  const byLayer = new Map();
  for (const t of textItems) {
    byLayer.set(t.layer, (byLayer.get(t.layer) || 0) + 1);
  }
  const byLayerTop = [...byLayer.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([layer, count]) => ({ layer, count }));

  const warnings = [];
  if (tch.level === "objects") {
    warnings.push(
      `DXF CLASSES 段检出 TCH_* 对象（${tch.classes.length} 个类）：本版不解析天正自定义对象，几何/文字可能确实缺失；建议在天正中导出 T3 后再打开。`
    );
  }
  if (!stats.extents) {
    warnings.push("DXF 缺少可用的 $EXTMIN/$EXTMAX，无法给出图纸范围。");
  }
  if (stats.entities.total === 0) {
    warnings.push("模型空间未扫描到实体（可能为空白图纸或转换失败）。");
  }
  const dangling = blocks.filter((b) => !b.defined && (b.refCount || 0) > 0);
  if (dangling.length > 0) {
    const names = dangling.slice(0, 5).map((b) => `${b.name}(${b.refCount})`);
    warnings.push(
      `${dangling.length} 个块只被引用但本图没有块定义：${names.join("、")}${
        dangling.length > 5 ? "…" : ""
      }；这些块内的内容可能来自外部参照或已丢失。`
    );
  }
  const skipped = info?.skipped?.count || 0;
  if (skipped > 0) {
    warnings.push(
      `cadcraft 打开源图时跳过 ${skipped} 个实体（通常是不支持的代理对象），统计可能少于图面内容。`
    );
  }

  const namedBlocks = blocks.filter(
    (b) => !b.name.startsWith("*") && !/^A\$/i.test(b.name)
  );

  const summary = {
    file: path.resolve(srcAbs),
    format: path.extname(srcAbs).slice(1).toLowerCase(),
    sizeBytes: fs.statSync(srcAbs).size,
    header: stats.header,
    extents: stats.extents,
    contentBox: stats.contentBox,
    entities: {
      total: stats.entities.total,
      byType: Object.fromEntries(topObjectEntries(stats.entities.byType, 15)),
    },
    layers: {
      total: layers.length,
      nonEmpty: nonEmptyLayers.length,
      top: nonEmptyLayers.slice(0, 10).map((l) => ({
        name: l.name,
        entityCount: l.entityCount,
        colorHex: l.colorHex,
      })),
    },
    blocks: {
      named: namedBlocks.length,
      total: blocks.length,
      used: blocks.filter(isUsedBlock).length,
      unused: blocks.filter((b) => !isUsedBlock(b)).length,
      top: blocks.filter(isUsedBlock).slice(0, 10).map((b) => ({
        name: b.name,
        refCount: b.refCount || 0,
        entityCount: b.entityCount || 0,
        anonymousRefCount: b.anonymousRefCount || 0,
        aggregatedFrom: b.aggregatedFrom || [],
      })),
      hiddenAnonymous: stats.anonymousHiddenCount || 0,
    },
    text: {
      total: textItems.length,
      byLayerTop,
    },
    tch: { level: tch.level, evidence: tch.evidence },
    warnings,
  };

  // DWG 额外报告缓存命中，便于确认“没有重复转换”
  if (dxf.converted) {
    summary.cache = { hit: dxf.fromCache, dxf: dxf.dxfPath };
  }
  return summary;
}

/* ───────────────────────── 命令实现 ───────────────────────── */

async function cmdDoctor(ctx) {
  const checks = [];

  const major = Number(process.versions.node.split(".")[0]);
  checks.push({
    check: "node",
    required: true,
    ok: major >= 20,
    detail: `${process.version}（项目要求 >= 20）`,
  });

  checks.push({
    check: "project-root",
    required: true,
    ok: true,
    detail: ctx.root,
  });

  let cliOk = false;
  let cliDetail = "";
  try {
    const cliPath = ctx.mod.resolveCliPath(ctx.root);
    if (!cliPath) {
      cliDetail = `未找到 bin/cadcraft/**/cadcraft-cli.exe（应位于 ${path.join(
        ctx.root,
        "bin"
      )}）`;
    } else {
      const version = await new ctx.mod.CadcraftCli(cliPath).version();
      cliOk = !!version;
      cliDetail = `${cliPath}（version: ${version || "未知"}）`;
    }
  } catch (e) {
    cliDetail = `检测 cadcraft 失败: ${e.message}`;
  }
  // 可选：缺它只影响 DWG 转换与 svg/pdf/png 导出，DXF 统计照常可用
  checks.push({
    check: "cadcraft",
    required: false,
    ok: cliOk,
    detail: cliOk
      ? cliDetail
      : cliDetail + "（缺它只影响 DWG 转换与 svg/pdf/png 导出；DXF 功能不受影响）",
  });

  let fontsOk = false;
  let fontsDetail = "";
  try {
    const fontDir = path.join(ctx.root, "web", "public", "fonts");
    const fonts = fs
      .readdirSync(fontDir)
      .filter((f) => /\.(ttf|otf|ttc)$/i.test(f));
    fontsOk = fonts.length > 0;
    fontsDetail =
      fonts.length > 0
        ? `${fontDir}: ${fonts.join(", ")}`
        : `${fontDir} 下没有字体文件`;
  } catch (e) {
    fontsDetail = `字体目录不可读: ${e.message}`;
  }
  // 可选：字体只给界面渲染用，CLI 完全不读它（轻量包里没有 web/ 是正常的）
  checks.push({
    check: "fonts",
    required: false,
    ok: fontsOk,
    detail: fontsOk ? fontsDetail : fontsDetail + "（只影响界面，CLI 不需要）",
  });

  let cacheOk = false;
  let cacheDetail = "";
  const cacheDir = path.join(ctx.root, "server", "cache", "skill");
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const probe = path.join(cacheDir, `.doctor-${process.pid}`);
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    cacheOk = true;
    cacheDetail = `${cacheDir}（可写）`;
  } catch (e) {
    cacheDetail = `缓存目录不可写: ${cacheDir}（${e.message}）`;
  }
  checks.push({ check: "cache", required: true, ok: cacheOk, detail: cacheDetail });

  // ok 只由必需项决定；可选缺失放进 degraded，避免“DXF 明明能用却报红”
  const required = checks.filter((c) => c.required !== false);
  const degraded = checks
    .filter((c) => c.required === false && !c.ok)
    .map((c) => c.check);
  return { ok: required.every((c) => c.ok), degraded, checks };
}

async function cmdSummary(ctx, srcAbs) {
  const dxf = await ensureDxf(ctx, srcAbs);
  const infoPromise = ctx.cli ? ctx.cli.infoJson(srcAbs) : Promise.resolve(null);
  const [stats, info, textItems] = await Promise.all([
    ctx.mod.scanDxf(dxf.dxfPath),
    infoPromise,
    scanTextFile(ctx, dxf.dxfPath),
  ]);
  const tch = ctx.mod.detectTch({ dxfPath: dxf.dxfPath, info });
  return buildSummary(ctx, srcAbs, { dxf, stats, info, tch }, textItems);
}

async function cmdStats(ctx, srcAbs) {
  const { stats, tch } = await loadStats(ctx, srcAbs);
  // “完整原始输出 + tch + header”：保留 scanDxf 的所有字段，便于程序深度查询
  return { ...stats, tch, header: stats.header };
}

async function cmdLayers(ctx, srcAbs, opts) {
  const { stats } = await loadStats(ctx, srcAbs);
  const rows = (stats.layers || [])
    .filter((l) => opts.all || l.entityCount > 0)
    .map((l) => ({
      name: l.name,
      colorHex: l.colorHex,
      entityCount: l.entityCount,
      frozen: l.frozen,
      off: l.off,
      locked: l.locked,
    }));
  return rows;
}

/** "本图真的用到"的块：refCount 只数顶层 INSERT，定义仍可能被别的块内部引用（nestedRefCount）。 */
function isUsedBlock(b) {
  if (typeof b.used === "boolean") return b.used;
  return (b.refCount || 0) > 0 || (b.nestedRefCount || 0) > 0;
}

async function cmdBlocks(ctx, srcAbs, opts) {
  const { stats } = await loadStats(ctx, srcAbs);
  const minRef = opts["min-ref"] == null ? 0 : parseNonNegativeInt(opts["min-ref"], "--min-ref");
  const limit =
    opts.limit == null ? Infinity : parseNonNegativeInt(opts.limit, "--limit");
  const includeUnused = !!opts.all;
  let rows = (stats.blocks || []).filter(
    (b) => (includeUnused || isUsedBlock(b)) && (b.refCount || 0) >= minRef
  );
  if (Number.isFinite(limit)) rows = rows.slice(0, limit);
  return rows.map((b) => ({
    name: b.name,
    refCount: b.refCount || 0,
    nestedRefCount: b.nestedRefCount || 0,
    entityCount: b.entityCount || 0,
    anonymousRefCount: b.anonymousRefCount || 0,
    aggregatedFrom: b.aggregatedFrom || [],
    defined: !!b.defined,
    isLayout: !!b.isLayout,
    used: isUsedBlock(b),
  }));
}

async function cmdText(ctx, srcAbs, opts) {
  const dxf = await ensureDxf(ctx, srcAbs);
  const all = await scanTextFile(ctx, dxf.dxfPath);
  const find = opts.find == null ? null : String(opts.find);
  const needle = find == null ? null : find.toLowerCase();
  const layer = opts.layer == null ? null : String(opts.layer).toLowerCase();
  const limit =
    opts.limit == null ? 50 : parseNonNegativeInt(opts.limit, "--limit");

  const matched = all.filter((t) => {
    if (layer && t.layer.toLowerCase() !== layer) return false;
    if (needle != null && !t.text.toLowerCase().includes(needle)) return false;
    return true;
  });

  const byLayer = {};
  for (const t of matched) {
    byLayer[t.layer] = (byLayer[t.layer] || 0) + 1;
  }

  return {
    total: all.length,
    matched: matched.length,
    byLayer,
    samples: matched.slice(0, limit).map((t) => ({
      layer: t.layer,
      text: t.text,
      x: t.x,
      y: t.y,
      h: t.h,
      style: t.style,
      rotation: t.rotation,
    })),
  };
}

async function cmdTch(ctx, srcAbs) {
  // tch 只需要 CLASSES 段 + cadcraft info，不必整份 scanDxf（大图能省很多时间）
  const dxf = await ensureDxf(ctx, srcAbs);
  const info = ctx.cli ? await ctx.cli.infoJson(srcAbs) : null;
  return ctx.mod.detectTch({ dxfPath: dxf.dxfPath, info });
}

/* ───────────────────────── 导出 ───────────────────────── */

function pngInfo(filePath) {
  const b = fs.readFileSync(filePath);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (b.length < 24 || !b.subarray(0, 8).equals(signature)) return null;
  if (b.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function windowArg(box) {
  if (!box) return null;
  const nums = [box.minX, box.minY, box.maxX, box.maxY];
  if (!nums.every((n) => Number.isFinite(n))) return null;
  return nums.join(",");
}

async function cmdExport(ctx, srcAbs, opts) {
  const format = String(opts.to || "").toLowerCase();
  if (!format) fail("export 需要 --to dxf|svg|pdf|json|png");
  if (!["dxf", "svg", "pdf", "json", "png"].includes(format)) {
    fail(`不支持的导出格式: ${format}（可选 dxf|svg|pdf|json|png）`);
  }

  const cacheDir = ensureCacheDir(ctx, srcAbs);
  const key = sha1(path.resolve(srcAbs)).slice(0, 12);
  const out = opts.out
    ? path.resolve(process.cwd(), opts.out)
    : path.join(cacheDir, `export-${key}.${format}`);
  if (out === path.resolve(srcAbs)) {
    fail("--out 不能指向源图纸本身（任何格式都不允许覆盖原文件）");
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });

  const srcIsDxf = path.extname(srcAbs).toLowerCase() === ".dxf";

  if (format === "dxf") {
    /* ⚠️ 必须导出「原始」DXF：
     *   - DWG → cadcraft 的 converted.dxf
     *   - DXF → 源文件本身
     * 绝不能复用 dxf-web.js 的 web-vN.dxf —— 那是给 WebGL 看的派生文件：
     * 会删掉 ATTRIB、把块内文字展平、重画表格，交给 CAD 软件打开会缺内容。
     */
    const dxf = await ensureDxf(ctx, srcAbs);
    if (path.resolve(dxf.dxfPath) === out) {
      fail("--out 不能与源 DXF 是同一个文件");
    }
    fs.copyFileSync(dxf.dxfPath, out);
    if (!fileLooksUsable(out)) fail(`DXF 写出失败: ${out}`);
    return {
      ok: true,
      out,
      bytes: fs.statSync(out).size,
      format: "dxf",
      sha256: hashFile(out),
      source: srcIsDxf ? "original-dxf" : "converted-from-dwg",
      ...(dxf.converted ? { convertedFromCache: dxf.fromCache } : {}),
    };
  }

  if (format === "json") {
    const { stats, tch } = await loadStats(ctx, srcAbs);
    const payload = { ...stats, tch, header: stats.header };
    fs.writeFileSync(out, JSON.stringify(payload, null, 2), "utf8");
    return {
      ok: true,
      out,
      bytes: fs.statSync(out).size,
      format: "json",
      entities: stats.entities.total,
      layers: stats.layers.length,
      blocks: stats.blocks.length,
    };
  }

  const cli = requireCli(ctx);
  // SVG / PDF / PNG 都从“扫描用 DXF”出图，并用 stats.contentBox 取景：
  // 与界面 PDF 导出链路一致（cadcraft convert → SVG → svg-pdf.js），
  // 同时避免 $EXTMIN/$EXTMAX 里的飞点把画面撑空。
  const dxf = await ensureDxf(ctx, srcAbs);
  const stats = await ctx.mod.scanDxf(dxf.dxfPath);
  const box = stats.contentBox || stats.coreExtents || null;
  const win = windowArg(box);

  if (format === "svg") {
    await cli.convertToSvg(dxf.dxfPath, out, box);
    if (!fileLooksUsable(out)) fail(`SVG 转换失败: ${out}`);
    return {
      ok: true,
      out,
      bytes: fs.statSync(out).size,
      format: "svg",
      renderer: "cadcraft convert",
      ...(win ? { window: win } : {}),
    };
  }

  if (format === "pdf") {
    // 临时 SVG 放缓存目录，避免污染用户指定目录；成品 PDF 写到 --out。
    // 文件名带 pdf-src，避免覆盖用户用 --to svg 默认导出的 export-<key>.svg。
    const tmpSvg = path.join(cacheDir, `pdf-src-${key}.svg`);
    await cli.convertToSvg(dxf.dxfPath, tmpSvg, box);
    if (!fileLooksUsable(tmpSvg)) fail(`SVG 中间产物转换失败: ${tmpSvg}`);
    const info = ctx.mod.convertSvgToPdf(tmpSvg, out);
    if (!fileLooksUsable(out)) fail(`PDF 写出失败: ${out}`);
    return {
      ok: true,
      out,
      bytes: fs.statSync(out).size,
      format: "pdf",
      pageWidth: info.pageWidth,
      pageHeight: info.pageHeight,
      orientation: info.orientation,
      elements: info.elements,
      svgBytes: fs.statSync(tmpSvg).size,
      renderer: "cadcraft svg -> svg-pdf.js",
      ...(win ? { window: win } : {}),
    };
  }

  // ---- PNG ----
  // cadcraft 0.7.0 的 convert 明确支持 PNG（OUT.(dxf|dwg|svg|png|pdf)），
  // 仍按“先探测、失败再换 run --export”的方式处理，避免版本差异时假装成功。
  const attempts = [];
  const framing = win ? ["--window", win] : [];
  try {
    await cli.run(["convert", dxf.dxfPath, out, ...framing], { timeoutMs: 300000 });
    const png = pngInfo(out);
    if (png) {
      return {
        ok: true,
        out,
        bytes: fs.statSync(out).size,
        format: "png",
        width: png.width,
        height: png.height,
        renderer: "cadcraft convert",
        ...(win ? { window: win } : {}),
      };
    }
    attempts.push("convert 未产出有效 PNG");
  } catch (e) {
    attempts.push(`convert: ${e.message}`);
  }

  try {
    fs.rmSync(out, { force: true });
    await cli.run(["run", dxf.dxfPath, "--export", out, ...framing], {
      timeoutMs: 300000,
    });
    const png = pngInfo(out);
    if (png) {
      return {
        ok: true,
        out,
        bytes: fs.statSync(out).size,
        format: "png",
        width: png.width,
        height: png.height,
        renderer: "cadcraft run --export",
        ...(win ? { window: win } : {}),
      };
    }
    attempts.push("run --export 未产出有效 PNG");
  } catch (e) {
    attempts.push(`run --export: ${e.message}`);
  }

  fs.rmSync(out, { force: true });
  fail(
    `PNG 导出失败：cadcraft 在当前环境未能产出 PNG（${attempts.join("；")}）。\n` +
      `PNG 预览需要打开界面（start.bat）用顶栏「导出 → PNG」，那才是与界面一致的截图。`
  );
}

/* ───────────────────────── 参数解析 / 入口 ───────────────────────── */

const VALUE_OPTS = new Set(["root", "find", "layer", "limit", "min-ref", "to", "out"]);

function parseArgv(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      opts._.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      opts._.push(arg);
      continue;
    }
    let key = arg.slice(2);
    let value;
    const eq = key.indexOf("=");
    if (eq >= 0) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    }
    if (key === "help" || key === "h") {
      opts.help = true;
      continue;
    }
    if (key === "all") {
      opts.all = true;
      continue;
    }
    if (key === "status") {
      opts.status = true;
      continue;
    }
    if (!VALUE_OPTS.has(key)) fail(`未知参数: --${key}`);
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined) fail(`--${key} 需要一个值`);
    }
    opts[key] = value;
  }
  return opts;
}

/* ───────────────────────── serve：确保本机服务在跑 ───────────────────────── */

/**
 * 健康检查 + 必要时拉起服务。
 * ⚠️ 用 `start.bat` 经 explorer 启动，**不是**直接 spawn node：工具会话里直接起的 node
 *    会在 1~2 分钟内被回收，只有 start.bat 能长驻（本项目实测结论）。
 */
async function cmdServe(ctx, opts) {
  const port = String(opts.port || process.env.PORT || 3717);
  const base = `http://127.0.0.1:${port}`;
  const ping = async () => {
    try {
      const r = await fetch(base + "/api/health", { signal: AbortSignal.timeout(1500) });
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  };

  // --foreground：给"会回收 detached 后台进程"的环境用（沙箱 / 托管任务）。
  // 服务跑在当前进程里，stdout 直通，交给 agent 的任务管理器保活；结束本进程即停服。
  if (opts.foreground) {
    const entry = path.join(ctx.root, "server", "index.js");
    if (!fs.existsSync(entry)) fail(`找不到 ${entry}，无法启动服务`);
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, [entry], {
      cwd: path.join(ctx.root, "server"),
      stdio: "inherit",
      env: { ...process.env, PORT: port },
    });
    let healthy = null;
    for (let i = 1; i <= 120; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      healthy = await ping();
      if (healthy) break;
    }
    printJson({
      ok: !!healthy,
      mode: "foreground",
      running: !!healthy,
      url: base,
      port,
      pid: child.pid,
      host: healthy ? healthy.host : undefined,
      lanUrls: healthy && healthy.lanUrls ? healthy.lanUrls : [],
      note: "前台运行：结束本进程即停服（交给 agent 的任务管理器保活）",
    });
    await new Promise((resolve) => child.on("exit", resolve));
    process.exit(healthy ? 0 : 1);
  }

  const already = await ping();
  if (already) {
    return {
      ok: true,
      running: true,
      started: false,
      url: base,
      // health 里带着服务实际绑定的地址：host 不是回环时，lanUrls 就是"同网段可用地址"
      host: already.host,
      lanUrls: already.lanUrls || [],
      health: already,
    };
  }
  if (opts.status) {
    return {
      ok: false,
      running: false,
      url: base,
      hint:
        `服务未运行。用 cad.mjs open <图纸> 或 serve 静默启动（不弹窗口、不开浏览器）；` +
        `用完用 close 关，空闲 ${process.env.CADVIEWER_IDLE_EXIT_MIN ?? 30} 分钟也会自动退出。` +
        `要让同一局域网的另一台设备/agent 访问：启动前 set CADVIEWER_HOST=0.0.0.0`,
    };
  }

  // 直接后台起 server/index.js，**不经 start.bat / explorer**：
  //  · 不弹控制台窗口（windowsHide + stdio:ignore）
  //  · 不自动打开系统浏览器（那是 start.bat 给人双击时的行为）
  //  · detached + unref：CLI 退出后服务继续活着，直到 `close` 或空闲超时
  const entry = path.join(ctx.root, "server", "index.js");
  if (!fs.existsSync(entry)) {
    fail(`找不到 ${entry}，无法启动服务`);
  }
  // 全新 clone 里 server/node_modules 不存在（只有 express/cors/multer 三个生产依赖，约 3MB）。
  // 这里自动装一遍，避免 agent 卡在 "Cannot find package 'express'"。
  if (!fs.existsSync(path.join(ctx.root, "server", "node_modules"))) {
    try {
      const { execFileSync } = await import("node:child_process");
      process.stderr.write("[cadviewer] 首次启动：安装 server 依赖（约 3MB）…\n");
      execFileSync("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], {
        cwd: path.join(ctx.root, "server"),
        // 丢弃 npm 输出：保证本命令的 stdout 只有一个 JSON，agent 能直接 parse
        stdio: ["ignore", "ignore", "ignore"],
        shell: true,
      });
    } catch (e) {
      fail(
        `server 依赖缺失且自动安装失败（${e && e.message ? e.message : e}）。\n` +
          `请手动执行: cd "${path.join(ctx.root, "server")}" && npm ci --omit=dev`
      );
    }
  }
  const { spawn } = await import("node:child_process");
  let pid = null;
  try {
    const child = spawn(process.execPath, [entry], {
      cwd: path.join(ctx.root, "server"),
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: { ...process.env, PORT: port },
    });
    child.unref();
    pid = child.pid;
  } catch (e) {
    fail(`后台启动失败（${e && e.message ? e.message : e}）；请手动运行 node ${entry}`);
  }

  for (let i = 1; i <= 120; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const h = await ping();
    if (h) {
      return {
        ok: true,
        running: true,
        started: true,
        url: base,
        host: h.host,
        lanUrls: h.lanUrls || [],
        pid,
        autoExitMinutes: Number(process.env.CADVIEWER_IDLE_EXIT_MIN ?? 30),
        waitedMs: i * 1000,
        health: h,
      };
    }
  }
  fail(`120s 内服务未就绪（${base}/api/health 不通）。pid=${pid}`);
}

/* ───────────────────────── close：用完即关 ───────────────────────── */

/**
 * 关闭后台服务（POST /api/shutdown，仅接受回环来源）。
 * 服务本来就空闲 30 分钟自动退出，这个命令是用完立刻走、不留后台进程。
 */
async function cmdClose(ctx, opts) {
  const port = String(opts.port || process.env.PORT || 3717);
  const base = `http://127.0.0.1:${port}`;
  try {
    const r = await fetch(base + "/api/shutdown", {
      method: "POST",
      signal: AbortSignal.timeout(4000),
    });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, stopped: r.ok, url: base, response: j };
  } catch {
    return { ok: true, stopped: false, url: base, hint: "服务本来就没在跑（无需关闭）" };
  }
}

/* ───────────────────── open：SOP 一步到位（转 DXF → 链接 + 概要） ───────────────────── */

/**
 * 收到用户图纸后的标准动作：
 *   ① 解析成 DXF（DWG 走 cadcraft，带缓存）
 *   ② 确保本机服务在跑
 *   ③ 返回一个**可以直接在浏览器打开**的地址（带 ?open=），以及摘要
 *
 * 给 agent 的约定：拿到 url 就用内置浏览器打开（和普通网页一致），
 * 摘要可以直接用来跟用户讲图里有什么，再问下一步要做什么（导出 PDF 等）。
 */
async function cmdOpen(ctx, srcAbs, opts) {
  const dxf = await ensureDxf(ctx, srcAbs);
  const served = await cmdServe(ctx, opts);
  if (!served || served.ok === false) return served;

  const q = "?open=" + encodeURIComponent(dxf.dxfPath);
  // 服务对外监听时优先给局域网地址（远端 agent 的浏览器才够得着）；否则就是本机地址
  const primary = (served.lanUrls && served.lanUrls.length ? served.lanUrls[0] : served.url) + "/" + q;
  const local = served.url + "/" + q;

  const summary = await cmdSummary(ctx, srcAbs);
  return {
    ok: true,
    url: primary,
    localUrl: local,
    host: served.host,
    lanUrls: served.lanUrls || [],
    dxf: {
      path: dxf.dxfPath,
      converted: !!dxf.converted,
      fromCache: !!dxf.fromCache,
    },
    digest: {
      entities: summary.entities.total,
      byType: summary.entities.byType,
      layers: { total: summary.layers.total, nonEmpty: summary.layers.nonEmpty },
      blocks: summary.blocks,
      extents: summary.extents,
      contentBox: summary.contentBox ?? null,
      header: summary.header,
      text: summary.text,
      tch: summary.tch,
      warnings: summary.warnings,
    },
    next: [
      "用你的内置浏览器打开 url（界面与正常网页一致：缩放/平移、图层与图块面板、导出下拉）",
      "把 digest 里的数字讲给用户，并问接下来做什么",
      "可提示：导出 PDF（A3 打印）、PNG（发人看）、DXF（给别人编辑）、JSON（存档）",
      "用户看完了就跑 cad.mjs close（服务空闲 30 分钟也会自己退出）",
    ],
  };
}

const USAGE = {
  usage: "node Skill/cadviewer/scripts/cad.mjs <command> [file] [options]",
  commands: {
    doctor: "环境自检",
    open: "open <file> [--port N]（SOP 一步到位：转 DXF → 起服务 → 返回可直接打开的链接 + 概要）",
    serve: "serve [--status] [--port N] [--foreground]（确保服务在跑；--foreground 前台跑，给会回收后台进程的环境）",
    close: "close [--port N]（关闭后台服务；空闲 30 分钟也会自动退出）",
    summary: "summary <file>",
    stats: "stats <file>",
    layers: "layers <file> [--all]",
    blocks: "blocks <file> [--min-ref N] [--limit N] [--all（含未使用的定义）]",
    text: "text <file> [--find <子串>] [--layer <名>] [--limit N]",
    tch: "tch <file>",
    export: "export <file> --to dxf|svg|pdf|json|png [--out <path>]",
  },
  globalOptions: ["--root <dir>（或环境变量 CADVIEWER_ROOT）"],
};

async function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgv(argv);

  if (opts.help || opts._.length === 0) {
    printJson(USAGE);
    return;
  }

  const command = opts._[0];
  const fileArg = opts._[1];

  const root = resolveProjectRoot(opts.root);
  const mod = await loadServerModules(root);
  const cliPath = mod.resolveCliPath(root);
  const ctx = {
    root,
    mod,
    cliPath,
    cli: cliPath ? new mod.CadcraftCli(cliPath) : null,
    _dxfMemo: new Map(),
  };

  if (command === "doctor") {
    printJson(await cmdDoctor(ctx));
    return;
  }
  if (command === "serve") {
    printJson(await cmdServe(ctx, opts));
    return;
  }
  if (command === "close") {
    printJson(await cmdClose(ctx, opts));
    return;
  }

  if (!fileArg) fail(`命令 ${command} 需要一个图纸文件参数`);
  const srcAbs = path.resolve(process.cwd(), fileArg);
  if (!fs.existsSync(srcAbs) || !fs.statSync(srcAbs).isFile()) {
    fail(`文件不存在: ${srcAbs}`);
  }
  const ext = path.extname(srcAbs).toLowerCase();
  if (ext !== ".dwg" && ext !== ".dxf") {
    fail(`不支持的格式 ${ext}，仅支持 DWG/DXF`);
  }

  let result;
  switch (command) {
    case "open":
      result = await cmdOpen(ctx, srcAbs, opts);
      break;
    case "summary":
      result = await cmdSummary(ctx, srcAbs);
      break;
    case "stats":
      result = await cmdStats(ctx, srcAbs);
      break;
    case "layers":
      result = await cmdLayers(ctx, srcAbs, opts);
      break;
    case "blocks":
      result = await cmdBlocks(ctx, srcAbs, opts);
      break;
    case "text":
      result = await cmdText(ctx, srcAbs, opts);
      break;
    case "tch":
      result = await cmdTch(ctx, srcAbs);
      break;
    case "export":
      result = await cmdExport(ctx, srcAbs, opts);
      break;
    default:
      fail(`未知命令: ${command}\n可用命令: ${Object.keys(USAGE.commands).join(", ")}`);
  }
  printJson(result);
}

main().catch((e) => {
  const message = e && e.message ? e.message : String(e);
  process.stderr.write(JSON.stringify({ error: message }, null, 2) + "\n");
  process.exitCode = 1;
});
