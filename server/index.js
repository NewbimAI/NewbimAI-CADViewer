import express from "express";
import cors from "cors";
import multer from "multer";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { resolveCliPath, CadcraftCli } from "./cadcraft.js";
import { detectTch } from "./tch-detect.js";
import { scanDxf, aggregateAnonymousBlocks } from "./scanner.js";
import { DXF_WEB_VERSION, parseFocus } from "./dxf-web.js";
import { fork } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

/**
 * cadcraft 字体设置（README「Fonts」节）：
 *  - SHX 形字体（HZ/BZHZ/bzhz.shx 等国内标准标注字体）cadcraft 尚不读取，
 *    默认用自己的 stroke font 画西文、中文回落系统 CJK。
 *  - FONTALT：SHX 找不到时的替代字体 → 系统里的"长仿宋"。
 *    ⚠️ 2026-10-18 实测更正：本机安装的族名是 **长仿宋Simplex**（`长仿宋SIMPLEX` 不存在，
 *    族名表实测为 "长仿宋Simplex" / "ÛSimple"），写错名字 = 该设置整体失效。
 *  - FONTFALLBACK：缺字符回落优先级，同样仿宋优先。
 *  ⚠️ 但**SVG 导出不受这两个变量影响**：0.7.0 的 SVG writer 恒定把文字画成单线体
 *    （见 test/tmp 的对照实验：同一段文字换 4 种字体设置，导出逐字节相同）。
 *    所以网页里"字体没还原"是 cadcraft 导出的能力边界，不是这里的配置问题。
 */
process.env.CADCRAFT_FONTALT ??= "长仿宋Simplex";
process.env.CADCRAFT_FONTFALLBACK ??= "长仿宋Simplex,FangSong,SimSun,Microsoft JhengHei";

const CACHE_DIR = path.join(PROJECT_ROOT, "server", "cache");
/**
 * 用户数据目录：上传的**原始图纸**。刻意放在缓存之外——
 * `server/cache/` 是随时可以整目录删掉的派生缓存，用户原图不能跟着一起没。
 * 可用 CADVIEWER_DATA 指到别处（例如大容量盘）。
 */
const DATA_DIR = process.env.CADVIEWER_DATA
  ? path.resolve(process.env.CADVIEWER_DATA)
  : path.join(PROJECT_ROOT, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const PORT = process.env.PORT || 3717;

/**
 * 监听地址：默认只绑回环，图纸不出本机。
 * 只有显式设置 CADVIEWER_HOST 时才对外监听（例：0.0.0.0 让同一局域网里的
 * 另一个 agent / 手机浏览器访问），启动日志会列出可用地址并明确警告。
 */
const HOST = (process.env.CADVIEWER_HOST || "127.0.0.1").trim();
const LOOPBACK_HOST =
  HOST === "127.0.0.1" || HOST === "localhost" || HOST === "::1";

/** 对外监听时，列出本机所有非回环 IPv4 地址（给"同网段的另一台设备"用）。 */
function lanUrls() {
  const urls = [];
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list || []) {
        if (ni.family === "IPv4" && !ni.internal) urls.push(`http://${ni.address}:${PORT}`);
      }
    }
  } catch {
    /* 取网卡失败不影响启动 */
  }
  return urls;
}
/** 缓存格式版本：算法/导出策略变化时 +1，旧缓存自动失效 */
const CACHE_VERSION = "v14"; // v14: tch 改为分层结构 {level, classes, evidence}（老缓存不兼容）
/**
 * 统计结果版本（meta.json 里的 statsVersion）。
 * ⚠️ 刻意**不**并入 CACHE_VERSION：块统计新增字段不需要重跑 DWG→DXF，
 *    命中旧缓存时只需拿 outDir/converted.dxf 重扫一遍（09bb 9.4MB 实测 ~300ms）。
 *    v3: 匿名块并回原块（stats.blocks 不再含 anonymous 行；新增 anonymousHiddenCount）。
 */
const STATS_VERSION = 4; // v4: blocks[] 增加 used 标志 + unusedBlockDefCount（未使用的块定义不在列表显示）
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/**
 * 启动时清理过期上传件。
 * 默认保留 30 天（UPLOAD_RETENTION_DAYS 可改；设 0 = 永不清理）。
 * 注意：这里现在位于 data/ 下，属于**用户文件**而不是缓存——不要把保留期调回 24 小时，
 * 否则"昨天上传、今天才要用"的图纸会凭空消失。
 * 同时兜底清掉上传中断留下的临时文件（命名形如 <时间戳>_<随机>_<原名>）。
 */
(function cleanOldUploads() {
  const days = Number(process.env.UPLOAD_RETENTION_DAYS ?? 30);
  if (!Number.isFinite(days) || days <= 0) return;
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  try {
    for (const name of fs.readdirSync(UPLOAD_DIR)) {
      const p = path.join(UPLOAD_DIR, name);
      try {
        const st = fs.statSync(p);
        if (st.isFile() && st.mtimeMs < cutoff) fs.unlinkSync(p);
      } catch {
        /* 单个文件失败不影响其他 */
      }
    }
  } catch {
    /* 目录读取失败则跳过 */
  }
})();

const cliPath = resolveCliPath(PROJECT_ROOT);
const cli = cliPath ? new CadcraftCli(cliPath) : null;
console.log(`[cadviewer] cadcraft-cli: ${cliPath || "未找到（bin/ 下无 exe）"}`);

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

/**
 * 修复上传文件名乱码：busboy 把 UTF-8 文件名按 latin1 解出，中文会变成
 * "é¢å°å¤ªè¡..." 这类乱码（这正是"图纸名称未准确解析"的根因）。
 * 纯 ASCII 名 latin1→utf8 往返不变；已经是正确 UTF-8 的名字解出会含替换符，则保留原值。
 */
function fixUploadName(name) {
  if (!name || /^[\x20-\x7e]*$/.test(name)) return name;
  try {
    const decoded = Buffer.from(name, "latin1").toString("utf8");
    return decoded.includes("\uFFFD") ? name : decoded;
  } catch {
    return name;
  }
}

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => {
      const safe = fixUploadName(file.originalname).replace(
        /[^\w.\-()\u4e00-\u9fa5]/g,
        "_"
      );
      cb(null, `${Date.now()}_${crypto.randomBytes(3).toString("hex")}_${safe}`);
    },
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
});

/** 打开的图纸记录：id → 元信息 */
const openFiles = new Map();
/** 转换锁：id → Promise，防并发重复转换 */
const converting = new Map();
function makeId(absPath) {
  // 归一化路径（E:////a//b 与 E:\a\b 是同一文件，不该产生两份缓存）
  const norm = path.win32.normalize(String(absPath)).toLowerCase();
  const st = fs.statSync(absPath);
  const key = `${CACHE_VERSION}|${norm}|${st.size}|${st.mtimeMs}`;
  return crypto.createHash("sha1").update(key).digest("hex").slice(0, 12);
}

/**
 * 统计结果迁移：把 stats.blocks 收敛到"无匿名行"的形态。
 * 新扫描（scanner.js）已经并好；这里主要处理旧 statsVersion=2 的缓存
 * （那时 blocks 里还有 anonymous 行 + origin 字段），无需重扫文件即可就地并回原块。
 */
function normalizeStats(stats) {
  if (!stats || !Array.isArray(stats.blocks)) return stats;
  if (stats.blocks.some((b) => b && b.anonymous)) {
    const { blocks, anonymousHiddenCount } = aggregateAnonymousBlocks(stats.blocks);
    stats.blocks = blocks;
    stats.anonymousHiddenCount = anonymousHiddenCount;
  } else if (typeof stats.anonymousHiddenCount !== "number") {
    stats.anonymousHiddenCount = 0;
  }
  return stats;
}

async function processDrawing(absPath, originalName) {
  const id = makeId(absPath);
  const outDir = path.join(CACHE_DIR, id);
  fs.mkdirSync(outDir, { recursive: true });

  if (converting.has(id)) return converting.get(id);

  // 缓存命中：同文件（路径+大小+mtime）已转换过 → 秒开
  const metaPath = path.join(outDir, "meta.json");
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      const cached = { ...meta, outDir };
      // v13 的 tch 是 {detected, classes}；v14 起是分层结构 {level, classes, evidence}。
      // 若读到旧结构（无 level 字段）就退化成新结构；缺失则给 none。始终保证字段存在。
      const t = cached.tch;
      cached.tch =
        t && typeof t.level === "string"
          ? { level: t.level, classes: t.classes || [], evidence: t.evidence || [] }
          : {
              level: t && t.detected ? "objects" : "none",
              classes: (t && t.classes) || [],
              evidence: [],
            };
      // 统计结果版本迁移：旧缓存直接返回会永远缺新字段 / 仍显示匿名行。
      // 不 bump CACHE_VERSION（那会逼所有用户重跑 DWG→DXF），只重扫已有的扫描用 DXF。
      if (!(Number(cached.statsVersion) >= STATS_VERSION)) {
        const converted = path.join(outDir, "converted.dxf");
        let statsSrc = null;
        if (fs.existsSync(converted)) statsSrc = converted;
        else if (cached.format === "DXF" && cached.path && fs.existsSync(cached.path)) {
          statsSrc = cached.path;
        }
        if (statsSrc) {
          try {
            const fresh = await scanDxf(statsSrc);
            // 合并而不是整体替换：保留旧 stats 里可能存在的历史附加字段（如 svgExtents）
            cached.stats = normalizeStats({ ...cached.stats, ...fresh });
            cached.statsVersion = STATS_VERSION;
            delete cached.statsUpgradeSkipped;
            delete cached.statsUpgradeError;
          } catch (e) {
            // 重扫失败不影响开图：旧 stats 就地并一次（如有匿名行），下次再试
            cached.stats = normalizeStats(cached.stats);
            cached.statsUpgradeError = e.message;
          }
        } else {
          // 源 DXF 已不存在（如上传临时文件被清理）：不重扫，直接用旧 stats 里的 origin 并回原块
          cached.stats = normalizeStats(cached.stats);
          cached.statsVersion = STATS_VERSION;
          cached.statsUpgradeSkipped = "source-missing";
        }
        if (cached.statsVersion >= STATS_VERSION) {
          try {
            fs.writeFileSync(
              metaPath,
              JSON.stringify({ ...cached, outDir: undefined }, null, 2)
            );
          } catch {
            /* 回写失败不影响本次开图 */
          }
        }
      } else {
        cached.stats = normalizeStats(cached.stats);
      }
      openFiles.set(id, cached);
      return cached;
    } catch {
      /* 缓存损坏则重新处理 */
    }
  }

  const task = (async () => {
    if (!cli) {
      throw new Error("cadcraft-cli 未部署：请将 cadcraft 便携版解压到 bin/ 目录");
    }
    const ext = path.extname(absPath).toLowerCase();

    // 第一段并行：cadcraft info + DWG→DXF
    const [info, dxfForScan] = await Promise.all([
      cli.infoJson(absPath),
      ext === ".dxf"
        ? Promise.resolve(absPath)
        : cli.toDxf(absPath, path.join(outDir, "converted.dxf")),
    ]);
    const skippedEntities = info?.skipped?.count || 0;
    // 天正（TCH_*）检测：分层判定 —— 先确证「扫描用 DXF」的 CLASSES 段，再看 info 里的制作痕迹
    const tch = detectTch({ dxfPath: dxfForScan, info });

    // 第二段：流式扫描统计（产出主体范围 coreExtents）
    let stats = null;
    let statsError = null;
    if (dxfForScan) {
      try {
        stats = normalizeStats(await scanDxf(dxfForScan));
      } catch (e) {
        statsError = e.message;
      }
    } else {
      statsError = "DWG→DXF 转换失败，无法做深度统计";
    }

    // info 兜底：scanner 失败时至少给概要
    if (!stats && info) {
      const infoBlocks = info.blocks || [];
      stats = {
        layers: (info.layers || []).map((l) => ({
          name: l.name,
          color: 7,
          colorHex: "#ffffff",
          frozen: !!l.frozen,
          off: !l.on,
          locked: !!l.locked,
          entityCount: 0,
        })),
        blocks: infoBlocks.map((b) => ({
          name: b,
          isLayout: /^\*(?:model|paper)_space/i.test(b),
          entityCount: 0,
          refCount: 0,
          nestedRefCount: 0,
          defined: true,
          anonymous: b.startsWith("*") || /^A\$/i.test(b),
        })),
        // 与 scanner 一致：blockDefCount 沿用「不含 *」口径
        blockDefCount: infoBlocks.filter((b) => !b.startsWith("*")).length,
        anonymousBlockDefCount: infoBlocks.filter((b) => b.startsWith("*")).length,
        layoutBlockDefCount: infoBlocks.filter((b) =>
          /^\*(?:model|paper)_space/i.test(b)
        ).length,
        anonymousHiddenCount: infoBlocks.filter((b) => b.startsWith("*")).length,
        entities: {
          total: info.entityCount || 0,
          byType: info.counts || {},
          inserts: info.counts?.["Block Reference"] || 0,
        },
        extents: null,
        header: {},
      };
    }
    stats = normalizeStats(stats);

    const st = fs.statSync(absPath);
    const record = {
      id,
      name: originalName || path.basename(absPath),      path: absPath,
      format: ext.replace(".", "").toUpperCase(),
      sizeBytes: st.size,
      mtime: st.mtimeMs,
      outDir,
      statsOk: !!stats,
      statsError,
      stats,
      statsVersion: STATS_VERSION,
      skippedEntities,
      tch,
      cadcraftInfo: info
        ? {
            version: info.title,
            layouts: info.layouts || [],
            linetypes: info.linetypes?.length || 0,
            textStyles: info.textStyles?.length || 0,
          }
        : null,
      openedAt: Date.now(),
    };
    openFiles.set(id, record);
    fs.writeFileSync(
      metaPath,
      JSON.stringify({ ...record, outDir: undefined }, null, 2)
    );

    return record;
  })();

  converting.set(id, task);
  try {
    return await task;
  } finally {
    converting.delete(id);
  }
}

// ---- 健康检查 ----
app.get("/api/health", async (_req, res) => {
  res.json({
    ok: true,
    cli: cli ? { path: cliPath, version: await cli.version() } : null,
    // 让 CLI / 别的 agent 知道这份服务绑在哪个地址、能不能从别的机器访问
    host: HOST,
    port: PORT,
    lanUrls: LOOPBACK_HOST ? [] : lanUrls(),
  });
});

// ---- 打开图纸（两种方式：本地路径 / 文件上传） ----
/** 上传文件按内容哈希重命名，保证同一份文件始终落到同一路径（缓存可复用、不重复占盘） */
async function dedupeUpload(tmpPath, originalName) {
  const hash = await new Promise((resolve, reject) => {
    const h = crypto.createHash("sha1");
    const rs = fs.createReadStream(tmpPath);
    rs.on("data", (c) => h.update(c));
    rs.on("end", () => resolve(h.digest("hex").slice(0, 12)));
    rs.on("error", reject);
  }).catch(() => null);
  if (!hash) return tmpPath;
  // 只用内容哈希命名（不带原文件名）：同一份文件无论用什么文件名上传都落到同一路径，
  // 缓存 id 因而稳定；对外显示的名字仍取 req.file.originalname，与文件名无关。
  const ext = (path.extname(originalName || "") || ".dwg").toLowerCase();
  const target = path.join(UPLOAD_DIR, `${hash}${[".dwg", ".dxf"].includes(ext) ? ext : ".dwg"}`);
  try {
    if (path.resolve(target) === path.resolve(tmpPath)) return tmpPath;
    if (fs.existsSync(target)) {
      fs.unlinkSync(tmpPath);
      return target;
    }
    fs.renameSync(tmpPath, target);
    return target;
  } catch {
    return tmpPath;
  }
}

app.post("/api/open", upload.single("file"), async (req, res) => {
  try {
    let absPath = null;
    let name = null;
    if (req.file) {
      // 上传去重：文件名带时间戳会让同一张图每次上传都产生新缓存（实测同一张 3MB 图纸
      // 重复上传攒了 3 份 147MB 缓存并各自重转换一遍）。改为按内容哈希落盘，重复上传
      // 直接命中同一路径 → 缓存复用。
      absPath = await dedupeUpload(req.file.path, fixUploadName(req.file.originalname));
      name = fixUploadName(req.file.originalname);
    } else if (req.body?.path) {
      absPath = path.resolve(req.body.path);
      name = path.basename(absPath);
      if (!fs.existsSync(absPath)) {
        return res.status(404).json({ error: `文件不存在: ${absPath}` });
      }
    } else {
      return res
        .status(400)
        .json({ error: "请提供 file（上传）或 path（本地路径）" });
    }
    const ext = path.extname(absPath).toLowerCase();
    if (![".dwg", ".dxf"].includes(ext)) {
      return res
        .status(400)
        .json({ error: `不支持的格式 ${ext}，仅支持 DWG/DXF` });
    }

    const rec = await processDrawing(absPath, name);
    res.json({
      id: rec.id,
      name: rec.name,
      format: rec.format,
      sizeBytes: rec.sizeBytes,
      statsOk: rec.statsOk,
      statsError: rec.statsError,
      stats: rec.stats,
      skippedEntities: rec.skippedEntities,
      /** 天正（TCH_*）分层检测结果；始终给出对象，检测失败/不适用时为 { level:"none", classes:[], evidence:[] } */
      tch: rec.tch || { level: "none", classes: [], evidence: [] },
      cadcraftInfo: rec.cadcraftInfo,
      /** 派生数据（DXF 预处理）的版本号：前端要拼进 URL 做缓存失效键 */
      dxfVersion: DXF_WEB_VERSION,
    });
  } catch (e) {
    console.error("[cadviewer] open failed:", e);
    res.status(500).json({ error: e.message });
  }
});

/* ─────────────────── WebGL 引擎（DXF 直读）───────────────────
 * 用 dxf-viewer 在浏览器里直读 DXF，服务端只做两件预处理（见 dxf-web.js）：
 * 解 `\U+XXXX` 转义、把 ACAD_TABLE 的网格与单元格文字注回成原生实体。
 * 产物按 DXF_WEB_VERSION 命名，改规则就 +1，旧文件自动失效。
 */
/** 聚焦变体单独一份产物：文件名带 focus 的短哈希（图层/图块名含中文，不能直接当文件名）。 */
const focusHash = (focus) =>
  crypto.createHash("sha1").update(focus.spec).digest("hex").slice(0, 8);
const webDxfPath = (rec, focus) =>
  path.join(rec.outDir, `web-v${DXF_WEB_VERSION}${focus ? `-focus-${focusHash(focus)}` : ""}.dxf`);
const webDxfJobs = new Map();
/** 普通产物与每个聚焦变体各自一条 job 链 */
const webDxfKey = (rec, focus) => `${rec.id}|${focus ? focus.spec : ""}`;

/* ─────────────────── 导出（原始 DXF / 矢量 PDF）───────────────────
 * · 原始 DXF 与 PDF 的源文件相同：DWG → converted.dxf；DXF → 源文件本身。
 *   ⚠️ 绝不能复用 web DXF（web-vN.dxf 删了 ATTRIB、展平块文字、重画表格）。
 * · PDF 构建链在 export-worker.js 子进程里跑：cadcraft convert → SVG → svg-pdf.js。
 */
/** 导出产物版本：转换规则/布局变化时 +1，文件名自带版本，旧缓存自然不会命中 */
const EXPORT_VERSION = 1;
const PDF_MAX_SRC_MB = Number(process.env.PDF_MAX_SRC_MB) || 120;
const PDF_MAX_SVG_MB = Number(process.env.PDF_MAX_SVG_MB) || 600;

const exportSvgPath = (rec) =>
  path.join(rec.outDir, `export-v${EXPORT_VERSION}.svg`);
const exportPdfPath = (rec) =>
  path.join(rec.outDir, `export-v${EXPORT_VERSION}.pdf`);

/** 导出的源 DXF：DWG 用 converted.dxf，DXF 用原始路径；不存在返回 null */
function exportSourceDxf(rec) {
  if (rec.format === "DXF") {
    return rec.path && fs.existsSync(rec.path) ? rec.path : null;
  }
  const converted = path.join(rec.outDir, "converted.dxf");
  return fs.existsSync(converted) ? converted : null;
}

/** PDF 并发去重：id → job（building/ready/error），照 webDxfJobs 的写法 */
const exportPdfJobs = new Map();

function ensureExportPdf(rec) {
  const hit = exportPdfJobs.get(rec.id);
  if (hit) return hit;

  const svgPath = exportSvgPath(rec);
  const pdfPath = exportPdfPath(rec);
  if (fs.existsSync(pdfPath)) {
    const job = {
      status: "ready",
      bytes: fs.statSync(pdfPath).size,
      svgBytes: fs.existsSync(svgPath) ? fs.statSync(svgPath).size : null,
    };
    exportPdfJobs.set(rec.id, job);
    return job;
  }

  const job = { status: "building" };
  exportPdfJobs.set(rec.id, job);

  const src = exportSourceDxf(rec);
  if (!src) {
    Object.assign(job, {
      status: "error",
      statusCode: 404,
      error: "缺少可用的 DXF 源文件",
    });
    return job;
  }

  // 大图保护：超限直接 413，不启动转换
  const srcBytes = fs.statSync(src).size;
  if (srcBytes > PDF_MAX_SRC_MB * 1024 * 1024) {
    Object.assign(job, {
      status: "error",
      statusCode: 413,
      error: "图纸过大，暂不支持矢量 PDF 导出",
    });
    return job;
  }

  const windowBox = rec.stats?.contentBox ?? rec.stats?.coreExtents ?? null;
  job.promise = (async () => {
    try {
      const stats = await new Promise((resolve, reject) => {
        const child = fork(
          path.join(__dirname, "export-worker.js"),
          [
            src,
            svgPath,
            pdfPath,
            cliPath || "",
            windowBox ? JSON.stringify(windowBox) : "null",
            String(PDF_MAX_SVG_MB * 1024 * 1024),
          ],
          {
            stdio: ["ignore", "ignore", "inherit", "ipc"],
            execArgv: [
              `--max-old-space-size=${
                Number(process.env.PDF_MAX_HEAP_MB) || 4096
              }`,
            ],
          }
        );
        let settled = false;
        const done = (fn, v) => {
          if (settled) return;
          settled = true;
          fn(v);
        };
        child.on("message", (m) => {
          if (!m || typeof m !== "object") return;
          if (m.type === "done") done(resolve, m.stats || {});
          else if (m.type === "error") {
            const e = new Error(m.error || "PDF 导出失败");
            if (m.code) e.code = m.code;
            done(reject, e);
          }
        });
        child.on("error", (e) => done(reject, e));
        child.on("exit", (code) => {
          if (code !== 0) {
            done(reject, new Error(`PDF 导出子进程退出码 ${code}`));
          } else {
            done(resolve, null);
          }
        });
      });
      Object.assign(job, {
        status: "ready",
        bytes: stats?.bytes ?? fs.statSync(pdfPath).size,
        svgBytes:
          stats?.svgBytes ??
          (fs.existsSync(svgPath) ? fs.statSync(svgPath).size : null),
        elements: stats?.elements ?? null,
        svgMs: stats?.svgMs ?? null,
        pdfMs: stats?.pdfMs ?? null,
      });
      console.log(
        `[cadviewer] PDF 导出 ${rec.id}: svg=${job.svgBytes}B(${job.svgMs}ms) pdf=${job.bytes}B(${job.pdfMs}ms)`
      );
    } catch (e) {
      Object.assign(job, {
        status: "error",
        statusCode: e.code === "TOO_LARGE" ? 413 : 500,
        error:
          e.code === "TOO_LARGE"
            ? "图纸过大，暂不支持矢量 PDF 导出"
            : e.message,
      });
      // 子进程通常已清理；主进程再兜底一次，绝不留半成品
      for (const p of [svgPath, pdfPath]) {
        try {
          if (fs.existsSync(p)) fs.rmSync(p, { force: true });
        } catch {
          /* ignore */
        }
      }
    }
  })();
  return job;
}

/**
 * 聚焦名字集合：列表里的"原块"可能吞并了匿名表示块（*U8…），
 * 双击原块时必须把这些 INSERT 名字一起传给 applyFocus，否则一个都高亮不了。
 * `spec` 保持不变（缓存 key 仍按 `block:<原块名>`）。
 */
function focusWithNames(rec, focus) {
  if (!focus || focus.kind !== "block") return focus;
  const row = rec.stats?.blocks?.find((b) => b.name === focus.name);
  const extra = Array.isArray(row?.aggregatedFrom) ? row.aggregatedFrom : [];
  return { ...focus, names: [...new Set([focus.name, ...extra])] };
}

function ensureWebDxf(rec, focus) {
  focus = focusWithNames(rec, focus);
  const key = webDxfKey(rec, focus);
  const hit = webDxfJobs.get(key);
  /* ⚠️ 必须同时确认**文件还在**：运行中清掉缓存（或手动删掉某个聚焦变体）时，
   *    内存里仍记着 status:"ready"；只信它就会一直返回"就绪"而文件已不存在，
   *    该 URL 会持续 404 直到重启。实测踩过。 */
  if (hit?.status === "ready" && fs.existsSync(webDxfPath(rec, focus))) return hit;
  if (hit?.status === "building") return hit;
  const out = webDxfPath(rec, focus);
  if (fs.existsSync(out)) {
    const job = { status: "ready", bytes: fs.statSync(out).size };
    webDxfJobs.set(key, job);
    return job;
  }
  const job = { status: "building", progress: 0 };
  webDxfJobs.set(key, job);
  // 扫描/预处理的源 DXF：
  //   · DWG 输入：processDrawing 会转出 converted.dxf；
  //   · DXF 输入：从不写 converted.dxf（源文件本身就是 DXF）→ 回退到原始上传/本地路径。
  // 之前硬读 converted.dxf，导致 WebGL 引擎下任何 .dxf 都打不开（SVG 引擎兜底已删除）。
  const converted = path.join(rec.outDir, "converted.dxf");
  const src = fs.existsSync(converted) ? converted : rec.path;
  // 把 promise 挂在 job 上：路由可以 await 它直接拿成品，前端不用轮询
  job.promise = (async () => {
    try {
      if (!src || !fs.existsSync(src)) throw new Error("缺少可用的 DXF 源文件");
      const stats = await new Promise((resolve, reject) => {
        const child = fork(path.join(__dirname, "dxf-web-worker.js"), [src, out, rec.path || "", focus ? focus.spec : "", focus?.names ? JSON.stringify(focus.names) : ""], {
          stdio: ["ignore", "ignore", "inherit", "ipc"],
          // SVG 的 LOD/瓦片安全网移除后，大图预处理全靠这条 worker（默认堆可能不够）。
          // 可用 DXF_WEB_MAX_MB 覆盖。
          execArgv: [`--max-old-space-size=${Number(process.env.DXF_WEB_MAX_MB) || 4096}`],
        });
        let settled = false;
        const done = (fn, v) => {
          if (settled) return;
          settled = true;
          fn(v);
        };
        child.on("message", (m) => {
          if (!m || typeof m !== "object") return;
          if (m.type === "done") done(resolve, m.stats);
          else if (m.type === "error") done(reject, new Error(m.error));
        });
        child.on("error", (e) => done(reject, e));
        child.on("exit", (code) => {
          if (code !== 0) done(reject, new Error(`DXF 预处理子进程退出码 ${code}`));
          else done(resolve, null);
        });
      });
      Object.assign(job, { status: "ready", progress: 1, ...(stats || {}) });
    } catch (e) {
      Object.assign(job, { status: "error", error: e.message });
    }
  })();
  return job;
}

app.get("/api/file/:id/dxf", async (req, res) => {
  const rec = openFiles.get(req.params.id);
  if (!rec) return res.status(404).json({ error: "图纸未打开" });
  /* 原始 DXF 下载（?raw=1）：给用户在 CAD 里打开用，必须是未预处理的源文件。
   * 下面的无 raw 分支继续返回 web DXF（ATTRIB 删除、块文字展平、表格重画）。 */
  if (req.query.raw === "1") {
    const src = exportSourceDxf(rec);
    if (!src) return res.status(404).json({ error: "DXF 文件不存在" });
    const st = fs.statSync(src);
    const base = rec.name || path.basename(rec.path || src);
    const downloadName =
      path.basename(base, path.extname(base)) + ".dxf";
    res.setHeader("Content-Type", "application/dxf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`
    );
    res.setHeader("Content-Length", String(st.size));
    res.setHeader("Cache-Control", "no-store");
    return fs.createReadStream(src).pipe(res);
  }
  // 聚焦（双击图层/图块亮显）：非法串一律当"无聚焦"，绝不影响开图
  const focus = parseFocus(req.query.focus);
  if (req.query.status === "1") {
    const job = ensureWebDxf(rec, focus);
    return res.json({
      status: job.status,
      focus: focus ? focus.spec : null,
      focusMuted: job.focusMuted ?? null,
      focusKept: job.focusKept ?? null,
      bytes: job.bytes ?? null,
      tables: job.tables ?? null,
      cells: job.cells ?? null,
      decoded: job.decoded ?? null,
      error: job.error || null,
    });
  }
  const job = ensureWebDxf(rec, focus);
  // 首次请求就地等构建完成（子进程在跑，主线程不堵），省掉前端的轮询逻辑
  if (job.status === "building" && job.promise) {
    try {
      await job.promise;
    } catch {
      /* 失败状态已经在 job 里 */
    }
  }
  if (job.status !== "ready") {
    return res.status(job.status === "error" ? 500 : 503).json({
      status: job.status,
      error: job.error || null,
    });
  }
  const p = webDxfPath(rec, focus);
  if (!fs.existsSync(p)) return res.status(404).json({ error: "DXF 不存在" });
  res.setHeader("Content-Type", "application/dxf; charset=utf-8");
  res.setHeader("Content-Length", String(fs.statSync(p).size));
  /* ⚠️ 绝不能给强缓存：这份 DXF 是**派生数据**，预处理规则（DXF_WEB_VERSION）一变内容就变，
   *    但 URL 只有 `/api/file/<id>/dxf`，不含版本。之前设 max-age=604800，结果 v3→v8 升级后
   *    浏览器整整 7 天继续供应旧文件 —— 表现为"服务端明明修好了，用户页面还是缺字/错位"。
   *    现在：① 响应 no-store；② 前端 URL 带 `?v=<DXF_WEB_VERSION>` 强制换 key（见 App.tsx）。 */
  res.setHeader("Cache-Control", "no-store");
  fs.createReadStream(p).pipe(res);
});

/**
 * 矢量 PDF 导出。
 * - 首次请求就地等构建完成并直接返回 PDF（不返回 503 让前端轮询）；
 * - `?status=1` 只返回状态，供验证/未来进度使用；
 * - 构建产物 export-vN.svg / export-vN.pdf 缓存在图纸目录，N = EXPORT_VERSION。
 */
app.get("/api/file/:id/pdf", async (req, res) => {
  const rec = openFiles.get(req.params.id);
  if (!rec) return res.status(404).json({ error: "图纸未打开" });

  const job = ensureExportPdf(rec);

  if (req.query.status === "1") {
    return res.json({
      status: job.status,
      bytes: job.bytes ?? null,
      svgBytes: job.svgBytes ?? null,
      error: job.error || null,
    });
  }

  // 首次请求：子进程在跑，主线程不堵，直接 await 成品
  if (job.status === "building" && job.promise) {
    try {
      await job.promise;
    } catch {
      /* 失败状态已经在 job 里 */
    }
  }
  if (job.status !== "ready") {
    return res.status(job.statusCode || (job.status === "error" ? 500 : 503)).json({
      status: job.status,
      error: job.error || null,
    });
  }

  const p = exportPdfPath(rec);
  if (!fs.existsSync(p)) return res.status(404).json({ error: "PDF 不存在" });
  const base = rec.name || path.basename(rec.path || p);
  const downloadName = path.basename(base, path.extname(base)) + ".pdf";
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`
  );
  res.setHeader("Content-Length", String(fs.statSync(p).size));
  res.setHeader("Cache-Control", "no-store");
  fs.createReadStream(p).pipe(res);
});
/** 文字字体（dxf-viewer 只认传进去的 TTF，不看 DXF 里的样式）。
 *  只放行白名单，绝不把任意路径暴露成静态目录。 */
/**
 * 字体白名单。**全部从系统字体目录读取，绝不复制进项目**（授权姿态：与 simfang 一致，
 * 不随产品分发、也不嵌进任何导出）。
 * 顺序无关，实际优先级由前端 `FONT_URLS` 决定：
 *   isocp___.ttf        —— ISO CP（AutoCAD `isocp.shx` 的 TTF 版），细体拉丁/数字，贴近 CAD 观感
 *   S_Changfangsong.ttf —— 长仿宋，中文工程制图标准字形
 *   simfang.ttf         —— 仿宋，兜底
 */
const FONT_WHITELIST = new Set([
  "isocp___.ttf",
  "S_Changfangsong.ttf",
  "simfang.ttf",
  "simhei.ttf",
  "msyh.ttc",
]);
app.get("/api/font/:name", (req, res) => {
  const name = req.params.name;
  if (!FONT_WHITELIST.has(name)) return res.status(404).end();
  const dir = process.env.WINDIR || "C:\\Windows";
  const p = path.join(dir, "Fonts", name);
  if (!fs.existsSync(p)) return res.status(404).end();
  res.setHeader("Content-Type", "font/ttf");
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  fs.createReadStream(p).pipe(res);
});

// ---- 最近打开列表 ----
app.get("/api/recent", (_req, res) => {
  const list = [...openFiles.values()]
    .sort((a, b) => b.openedAt - a.openedAt)
    .slice(0, 20)
    .map(({ id, name, format, sizeBytes, statsOk, openedAt }) => ({
      id,
      name,
      format,
      sizeBytes,
      statsOk,
      openedAt,
    }));
  res.json(list);
});

// ---- 前端静态资源（生产模式） ----
const distDir = path.join(PROJECT_ROOT, "web", "dist");
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(distDir, "index.html"));
  });
}

const httpServer = app.listen(PORT, HOST, () => {
  if (LOOPBACK_HOST) {
    console.log(
      `[cadviewer] 服务已启动: http://127.0.0.1:${PORT} （仅本机访问，不上云）`
    );
    return;
  }
  console.log(`[cadviewer] 服务已启动（对外监听 ${HOST}:${PORT}）：`);
  console.log(`  http://127.0.0.1:${PORT}   （本机）`);
  for (const u of lanUrls()) console.log(`  ${u}   （同一局域网可访问）`);
  console.log("  ⚠ 同网段的其他设备能打开本服务，也就能看到你打开的图纸；用完请关掉。");
});
/**
 * 端口占用的常见成因：上一个实例刚被杀、Windows 上该端口的 TIME_WAIT 还没回收
 * （Node 在 Windows 不设 SO_REUSEADDR，TIME_WAIT 期间重绑会 EADDRINUSE）。
 * 默认行为是抛未捕获异常 + 一大段栈，对"关掉再开"的日常操作太吵，这里给一句人话。
 */
httpServer.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[cadviewer] 端口 ${PORT} 仍被占用（通常是上一个实例刚退出、套接字处于 TIME_WAIT）。稍等几秒重试，` +
        `或改用其他端口：set PORT=3727 && npm start`
    );
    process.exit(1);
  }
  throw err;
});
