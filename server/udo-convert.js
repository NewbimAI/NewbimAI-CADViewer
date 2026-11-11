/**
 * 天正（TCH_* / AEC_* 伪装的 TDb*）原生对象 → 标准 DXF 实体（v52 起按 TDb 类名匹配）。
 *
 * 背景（2026-11-10 实测，见 `docs/tch-reader-report.md`）：
 *   · 图纸里的墙体/门洞是**自定义对象**：DWG 的 C++ 类是 `TDbWall` / `TDbOpening` /
 *     `TDbText`，但 DXF 注册名可能被伪装成 `AEC_WALL` / `AEC_OPENING` / `AEC_TEXT`
 *     （机柜图就是这种 `AEC_KERNAL` 注册的图；施工图用 `TCH_*`），GstarCAD 导出的
 *     DXF 里又是 `IAEC_*`。cadcraft 转出的 DXF **静默丢弃**它们 —— 墙线、门窗成片消失。
 *   · `crates/udo-cli`（Rust，仓库内，MIT OR Apache-2.0）按 **C++ 类名**解出
 *     洞口 `TDbOpening`（525/525，端点误差中位 0.000000 mm）、墙体 `TDbWall`
 *     （1959/1959，中心线 + 左右宽度）与文字 `TDbText`（665/680，GBK 内容已解好）。
 *     ground truth：浩辰导出的 DXF。
 *   · 因此本模块所有按类名的分派都先归一：`TCH_*` 与 `AEC_*` 映射到同一分支
 *     （见 `udoKindOf`），单边 `startsWith("TCH_")` 判断会漏掉整张机柜图。
 *
 * 本模块只做三件事，全程不抛异常（解析失败绝不影响开图）：
 *   1. `detectUdo()`   —— 判定这张 DWG 里有没有自定义对象（先看 meta.json，再看 CLI）；
 *   2. `decodeUdo()`   —— 子进程跑 `udo-cli dump --out`，超时/崩溃都返回 `{ ok:false }`；
 *   3. `injectUdoGeometry()` —— 把 `status=decoded` 的对象转成标准实体
 *      插入 ENTITIES 段末尾：洞口 → 闭合 LWPOLYLINE；墙体 → 左右两条 LWPOLYLINE；
 *      文字 → TEXT；标注（v62）→ 尺寸线/界线/斜标记 LWPOLYLINE + 数值 MTEXT
 *      （保留图层、颜色、句柄规则）。其余状态/类一律不注入。
 *
 * 二进制：`bin/udo-cli/udo-cli.exe`（体积大、闭源分发，**不入库**，见 README「环境要求」）。
 * 没有二进制 / 未检出自定义对象 → 所有函数退化成"什么都不做"，`buildWebDxf` 产出**逐字节不变**。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

import { detectUdo as detectUdoFromDxf } from "./udo-detect.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

/** 默认超时：6.9s（2.4MB 样张实测）→ 60s 留足大图余量；`UDO_TIMEOUT_MS` 可覆盖。 */
export const UDO_TIMEOUT_MS = 60000;

/** 单次最多注入多少个洞口（防呆：坏文件里出现百万级实体时不会把 web DXF 撑爆）。 */
export const UDO_MAX_ENTITIES = 20000;

/** 写进 cache 的 dump 文件名（与 web-vN.dxf 同目录，属可随时删除的派生缓存）。 */
export const UDO_DUMP_FILE = "udo-dump.json";

/* ───────────────────────────── 开关 / 二进制 ───────────────────────────── */

/**
 * 读环境变量，旧名（0.3.0 之前）作为已弃用别名：读到一次就 `console.warn` 一次。
 * 旧名只做兼容，不再写进文档。
 */
const WARNED_ENV = new Set();
function envCompat(name, legacyName) {
  const v = process.env[name];
  if (v !== undefined && String(v).trim() !== "") return v;
  const old = process.env[legacyName];
  if (old === undefined || String(old).trim() === "") return undefined;
  if (!WARNED_ENV.has(legacyName)) {
    WARNED_ENV.add(legacyName);
    console.warn(
      `[cadviewer] 环境变量 ${legacyName} 已弃用（0.3.0 起改名），请改用 ${name}；本次仍按旧值生效。`
    );
  }
  return old;
}

/** 总开关：`CADVIEWER_UDO=0` 关闭；`=force` 跳过廉价预筛（见 probeUdoDwg）。 */
function udoMode() {
  const v = String(envCompat("CADVIEWER_UDO", "CADVIEWER_TCH") ?? "").trim().toLowerCase();
  if (v === "0" || v === "off" || v === "false" || v === "no") return "off";
  if (v === "force" || v === "1" || v === "on" || v === "true" || v === "yes") return "force";
  return "auto";
}

export function udoEnabled() {
  return udoMode() !== "off";
}

/** PATH 里找可执行文件（`which` / `where` 的等价物）；找不到 → null。 */
function findOnPath(exe) {
  const dirs = String(process.env.PATH || "").split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const p = path.join(dir, exe);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* 下一个 */
    }
  }
  return null;
}

/**
 * 找 `udo-cli` 可执行文件。顺序：
 *   1. 环境变量 `CADVIEWER_UDO_CLI`（绝对路径，给开发/调试用；旧名 `CADVIEWER_TCH_CLI` 兼容）；
 *   2. `bin/udo-cli/udo-cli[.exe]`（正式位置，安装包随附、仓库忽略）；
 *   3. `bin/tch-cli/tch-cli[.exe]`（0.3.0 之前的旧位置，过渡期回退）；
 *   4. `target/release/udo-cli[.exe]`（`cargo build --release` 之后直接可用）；
 *   5. PATH。
 * 都找不到 → null（= 完全不做自定义对象处理）。
 */
export function resolveUdoCli(root = PROJECT_ROOT) {
  const exe = process.platform === "win32" ? "udo-cli.exe" : "udo-cli";
  const legacyExe = process.platform === "win32" ? "tch-cli.exe" : "tch-cli";
  const candidates = [
    envCompat("CADVIEWER_UDO_CLI", "CADVIEWER_TCH_CLI"),
    process.env.UDO_CLI,
    path.join(root, "bin", "udo-cli", exe),
    path.join(root, "bin", "tch-cli", legacyExe),
    path.join(root, "target", "release", exe),
    path.join(root, "target", "release", legacyExe),
  ];
  for (const p of candidates) {
    if (!p || typeof p !== "string") continue;
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* 下一个 */
    }
  }
  return findOnPath(exe);
}

/* ───────────────────────────── 廉价预筛 ─────────────────────────────
 * 为什么要预筛：`udo-cli` 要完整读一遍 DWG（2.4MB 样张 6.9s，大图更久），
 * 每张 DWG 都跑一次是不可接受的开图成本。v52 起预筛交给 `udo-cli probe`：
 * 它只读 CLASSES 段、不解码几何，能识别被伪装成 `AEC_*` 的 `TDb*` 类
 * （机柜图整张都没有 `TCH_` 字节，旧版字节扫描会漏检）。
 *   · `has_udo_classes=true`  → 继续走 dump（真判定仍是 dump 里有没有 decoded 实体）；
 *   · `has_udo_classes=false` → 直接当作"没有自定义对象"，不启动解码进程。
 *
 * ⚠️ 必须防御旧版二进制：没有 `probe` 子命令 / 退出码非 0 / 输出不是 JSON 时，
 *    **回退到原来的字节预筛**（`probeUdoDwgBytes`），绝不能因此让图纸打不开。
 *    需要跳过预筛强制解析时设 `CADVIEWER_UDO=force`。
 */
const UDO_NEEDLES = ["TCH_", "$TCH", "$TwtSys$"].map((s) => Buffer.from(s, "latin1"));
const probeCache = new Map();

/** 原来的字节预筛（probe 不可用时的回退路径；读不到文件 → false，不抛）。 */
export function probeUdoDwgBytes(dwgPath) {
  if (!dwgPath || typeof dwgPath !== "string") return false;
  try {
    const buf = fs.readFileSync(dwgPath);
    return UDO_NEEDLES.some((n) => buf.includes(n));
  } catch {
    return false;
  }
}

/**
 * 解析 `udo-cli probe` 的 JSON 输出。
 * 契约（crates/udo-cli）：`{ schema_version:1, ok:true, data:{ has_udo_classes,
 * class_count, entity_count, dwg_version, ... } }`；也接受裸 data 对象。
 * 任何不合契约的输出（非 JSON / ok:false / 缺 has_udo_classes）→ null，
 * 调用方据此回退到字节预筛。
 * @returns {{hasUdoClasses:boolean,classCount:number,entityCount:number,dwgVersion:string|null}|null}
 */
export function parseProbeOutput(text) {
  let doc;
  try {
    doc = JSON.parse(String(text ?? "").trim());
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  if (doc.ok === false) return null;
  const data = doc.data && typeof doc.data === "object" && !Array.isArray(doc.data) ? doc.data : doc;
  // 旧版二进制（0.3.0 之前）输出的字段名是 has_tch_classes：过渡期一并接受。
  const hasClasses =
    typeof data.has_udo_classes === "boolean" ? data.has_udo_classes : data.has_tch_classes;
  if (typeof hasClasses !== "boolean") return null;
  return {
    hasUdoClasses: hasClasses,
    classCount: Number(data.class_count) || 0,
    entityCount: Number(data.entity_count) || 0,
    dwgVersion: typeof data.dwg_version === "string" ? data.dwg_version : null,
  };
}

/**
 * 文件里是否有天正对象。
 *
 * 顺序：`CADVIEWER_UDO=force` → true；否则跑 `udo-cli probe --dwg <path>`（带缓存）；
 * 子命令不存在 / 无二进制 / 超时 / 退出码非 0 / 输出非 JSON → 回退字节预筛。
 *
 * @param {string} dwgPath
 * @param {{ cli?: string, root?: string, timeoutMs?: number,
 *           runProbe?: (cli:string, dwg:string, timeoutMs:number) => Promise<{error?:string,stdout?:string}> }} [opts]
 * @returns {Promise<boolean>}
 */
export async function probeUdoDwg(dwgPath, opts = {}) {
  if (!dwgPath || typeof dwgPath !== "string") return false;
  if (udoMode() === "force") return true;

  let key;
  try {
    const st = fs.statSync(dwgPath);
    key = `${dwgPath}|${st.size}|${st.mtimeMs}`;
  } catch {
    return false;
  }

  const cli = opts.cli || resolveUdoCli(opts.root);
  const injected = typeof opts.runProbe === "function";
  // 注入的 runner 只用于测试：不落全局缓存，避免不同用例互相污染
  const cacheKey = `${key}|${injected ? "injected" : cli || "no-cli"}`;
  if (!injected) {
    const hit = probeCache.get(cacheKey);
    if (hit !== undefined) return hit;
  }

  let found = null;
  if (cli || injected) {
    try {
      const run = injected
        ? opts.runProbe
        : (c, p, t) => runCli(c, ["probe", "--dwg", p], t);
      const r = await run(cli || "udo-cli", dwgPath, timeoutOf(opts));
      // 退出码非 0（r.error 已由 runCli 归一）→ 不信任 stdout，走回退
      if (r && !r.error) {
        const parsed = parseProbeOutput(r.stdout);
        if (parsed) found = parsed.hasUdoClasses;
      }
    } catch {
      /* 子进程异常 → 回退 */
    }
  }
  if (found === null) found = probeUdoDwgBytes(dwgPath);

  if (!injected) {
    // 只留最近 64 条，避免长期运行时 Map 无界增长
    if (probeCache.size > 64) probeCache.clear();
    probeCache.set(cacheKey, found);
  }
  return found;
}

/* ───────────────────────────── udo-cli 子进程 ───────────────────────────── */

function timeoutOf(opts = {}) {
  const v = Number(opts.timeoutMs ?? process.env.UDO_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : UDO_TIMEOUT_MS;
}

/** 跑一次 CLI，返回 { code, stdout, stderr }；失败（含超时/无二进制）返回 { error }。 */
function runCli(cli, args, timeoutMs) {
  return new Promise((resolve) => {
    try {
      execFile(
        cli,
        args,
        {
          timeout: timeoutMs,
          windowsHide: true,
          maxBuffer: 8 * 1024 * 1024,
          encoding: "utf8",
        },
        (err, stdout, stderr) => {
          if (err) {
            // timeout / 非零退出 / spawn 失败都归一成 error，调用方只看 ok
            const timedOut = err.killed === true || err.signal != null;
            resolve({
              error: timedOut ? `udo-cli 超时（>${timeoutMs}ms）` : err.message,
              code: typeof err.code === "number" ? err.code : null,
              stdout: stdout || "",
              stderr: stderr || "",
            });
            return;
          }
          resolve({ code: 0, stdout: stdout || "", stderr: stderr || "" });
        }
      );
    } catch (e) {
      resolve({ error: e instanceof Error ? e.message : String(e) });
    }
  });
}

/** dump 结果的进程内缓存：同一次开图里 detect + decode 只跑一次进程。 */
const dumpMemo = new Map();

function fileKey(p) {
  try {
    const st = fs.statSync(p);
    return `${p}|${st.size}|${st.mtimeMs}`;
  } catch {
    return null;
  }
}

function rememberDump(key, value) {
  if (!key) return;
  if (dumpMemo.size > 16) dumpMemo.clear();
  dumpMemo.set(key, value);
}

/**
 * 跑 `udo-cli dump --dwg <dwg> --out <tmp.json>` 并读回 JSON。
 *
 * 契约（见 `crates/udo-cli/README.md`）：
 *   `{ schema_version: 1, ok: true, data: {...} }` / `{ schema_version:1, ok:false, error:{...} }`
 * 任何异常（无二进制、超时、退出码非零、JSON 坏、schema 不认）都返回 `{ ok:false, error }`，
 * **绝不抛** —— 调用方据此决定"不注入"。
 *
 * @param {string} dwgPath
 * @param {{ timeoutMs?: number, tmpDir?: string, cli?: string, root?: string }} [opts]
 * @returns {Promise<{ ok: true, data: any } | { ok: false, error: string }>}
 */
export async function decodeUdo(dwgPath, opts = {}) {
  if (!dwgPath || typeof dwgPath !== "string" || !/\.dwg$/i.test(dwgPath)) {
    return { ok: false, error: "不是 DWG 文件" };
  }
  const key = fileKey(dwgPath);
  const memo = key ? dumpMemo.get(key) : null;
  if (memo) return memo;

  const cli = opts.cli || resolveUdoCli(opts.root);
  if (!cli) return { ok: false, error: "udo-cli 未部署（bin/udo-cli/udo-cli.exe）" };

  const tmpDir = opts.tmpDir || os.tmpdir();
  const outJson = path.join(
    tmpDir,
    `udo-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.json`
  );

  let result;
  try {
    const r = await runCli(cli, ["dump", "--dwg", dwgPath, "--out", outJson], timeoutOf(opts));
    if (r.error) {
      result = { ok: false, error: r.error };
    } else {
      let doc = null;
      let parseError = null;
      try {
        doc = JSON.parse(fs.readFileSync(outJson, "utf8"));
      } catch (e) {
        parseError = e;
      }
      if (parseError) {
        result = { ok: false, error: `dump 输出不可读：${parseError.message}` };
      } else if (!doc || typeof doc !== "object") {
        result = { ok: false, error: "dump 输出不是 JSON 对象" };
      } else if (doc.schema_version !== 1) {
        result = { ok: false, error: `未知 schema_version：${doc.schema_version}` };
      } else if (doc.ok !== true || !doc.data || !Array.isArray(doc.data.entities)) {
        const msg = doc.error?.message || doc.error?.code || "dump 返回 ok=false";
        result = { ok: false, error: msg };
      } else {
        result = { ok: true, data: doc.data };
      }
    }
  } catch (e) {
    result = { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    try {
      fs.rmSync(outJson, { force: true });
    } catch {
      /* 临时文件删不掉不影响结果 */
    }
  }

  // 只缓存成功结果（失败可能是瞬时的：超时、文件正被写）
  if (result.ok) rememberDump(key, result);
  return result;
}

/* ───────────────────────────── 检测 ───────────────────────────── */

/** `2/ENTITIES` 这类段名（要求是独立的值行，避免命中 CLASSES 里的字符串）。 */
function sectionIndex(text, name) {
  const re = new RegExp(`(?:^|\\n)[ \\t]*2[ \\t]*\\r?\\n${name}[ \\t]*(?=\\r?\\n)`);
  const m = re.exec(text);
  return m ? m.index : -1;
}

/** 从 dump 的 `data` 汇总统计（类名、实体数、解出数，按类分开）。 */
export function summarizeUdo(data) {
  const list = Array.isArray(data?.entities) ? data.entities : [];
  const counts = data?.counts && typeof data.counts === "object" ? data.counts : {};
  const classes = Object.keys(counts);
  const decodedByKind = { opening: 0, wall: 0, text: 0, dimension: 0 };
  let decoded = 0;
  for (const e of list) {
    if (e?.decode?.status !== "decoded") continue;
    decoded++;
    const k = e?.decode?.kind;
    if (k === "opening" || k === "wall" || k === "text" || k === "dimension") decodedByKind[k]++;
  }
  /* `stats.udo_entities` 是整份 DWG 的自定义对象实体总数（含没有解码器的类），
   * 比 `entities.length` 更全；没有统计时退回列表长度。 */
  const statsTotal = Number(data?.stats?.udo_entities);
  const entities = Number.isFinite(statsTotal) ? Math.max(statsTotal, 0) : list.length;
  return {
    classCount: Number(data?.udo_class_count) || classes.length,
    classes,
    entities,
    detected: entities > 0,
    decoded,
    decodedByKind,
  };
}

/** 读 meta.json 里的自定义对象信息（老缓存可能只有 level/classes，没有计数）。 */
function readMetaUdo(metaPath) {
  if (!metaPath || typeof metaPath !== "string") return null;
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    // 0.3.0 之前的 meta.json 把这个字段叫 tch：过渡期只读兼容。
    const t = meta?.udo || meta?.tch;
    if (!t || typeof t !== "object") return null;
    const entities = Number(t.entities);
    const classes = Array.isArray(t.classes) ? t.classes : [];
    if (!(entities > 0) && classes.length === 0) return null;
    return {
      classes,
      entities: Number.isFinite(entities) && entities > 0 ? entities : 0,
      classCount: Number(t.classCount) || classes.length,
      decoded: Number(t.decoded) || 0,
      decodedByKind: t.decodedByKind && typeof t.decodedByKind === "object" ? t.decodedByKind : null,
      dumpFile: typeof t.dumpFile === "string" ? t.dumpFile : null,
    };
  } catch {
    return null;
  }
}

/** 同目录的 meta.json（DXF 直开 / uploads 目录常见）。 */
function siblingMeta(dwgPath) {
  try {
    return path.join(path.dirname(dwgPath), "meta.json");
  } catch {
    return null;
  }
}

/**
 * 判定这张 DWG 里有没有天正实体 —— 契约（形状固定）：
 *   `{ detected, classes, entities, classCount, decoded, source }`
 * 顺序：
 *   1. 已有 dump（参数 / 进程内缓存）→ 直接汇总，不跑进程；
 *   2. 已有 meta.json（`server/cache/<id>/meta.json`）→ 用缓存的类名/计数；
 *   3. `server/udo-detect.js` 的 DXF 侧判定（CLASSES 段确证 `TCH_*`）→ 有类名就算检出；
 *   4. 都没有 → 跑 CLI：默认 `--summary-only`（只要计数）；
 *      `opts.full` 时跑整份 dump（调用方接着要几何，省一次 7s 的进程）。
 * 任何一步失败都退化成 `{ detected:false }`，不抛。
 *
 * @param {string} dwgPath
 * @param {{ metaPath?: string, dxfPath?: string, info?: any, dump?: any, full?: boolean,
 *           timeoutMs?: number, cli?: string, root?: string }} [opts]
 */
export async function detectUdo(dwgPath, opts = {}) {
  const empty = {
    detected: false,
    classes: [],
    entities: 0,
    classCount: 0,
    decoded: 0,
    source: "none",
  };
  if (!udoEnabled()) return empty;
  if (!dwgPath || typeof dwgPath !== "string" || !/\.dwg$/i.test(dwgPath)) return empty;

  /* 1) 已有 dump */
  const supplied = opts.dump && (opts.dump.data || opts.dump);
  if (supplied && Array.isArray(supplied.entities)) {
    return { ...summarizeUdo(supplied), source: "dump" };
  }
  const memo = dumpMemo.get(fileKey(dwgPath));
  if (memo?.ok) {
    return { ...summarizeUdo(memo.data), source: "dump" };
  }

  /* 2) meta.json */
  const meta = readMetaUdo(opts.metaPath || siblingMeta(dwgPath));
  if (meta) {
    return {
      detected: meta.entities > 0 || meta.classes.length > 0,
      classes: meta.classes,
      entities: meta.entities,
      classCount: meta.classCount,
      decoded: meta.decoded,
      decodedByKind: meta.decodedByKind || { opening: 0, wall: 0, text: 0, dimension: 0 },
      source: "meta",
    };
  }

  /* 3) DXF 侧确证（扫描用 DXF 的 CLASSES 段） */
  if (opts.dxfPath) {
    try {
      const dxfTch = detectUdoFromDxf({ dxfPath: opts.dxfPath, info: opts.info });
      if (dxfTch?.classes?.length) {
        return {
          detected: true,
          classes: dxfTch.classes,
          entities: 0,
          classCount: dxfTch.classes.length,
          decoded: 0,
          source: "dxf-classes",
        };
      }
    } catch {
      /* 落到 CLI */
    }
  }

  /* 4) CLI（先过 `udo-cli probe` 预筛；旧二进制/失败时回退字节预筛） */
  if (!(await probeUdoDwg(dwgPath, opts))) return empty;
  const cli = opts.cli || resolveUdoCli(opts.root);
  if (!cli) return { ...empty, source: "no-cli" };

  if (opts.full) {
    const r = await decodeUdo(dwgPath, opts);
    if (!r.ok) return { ...empty, source: "cli-error" };
    return { ...summarizeUdo(r.data), source: "cli" };
  }

  const r = await runCli(cli, ["dump", "--dwg", dwgPath, "--summary-only"], timeoutOf(opts));
  if (r.error) return { ...empty, source: "cli-error" };
  const text = `${r.stdout}\n${r.stderr}`;
  /* 汇总行由 CLI 打印；旧版二进制（0.3.0 之前）打的是 TCH，过渡期两种都认。 */
  const entities = Number((/(?:UDO|TCH) entities\s+(\d+)/.exec(text) || [])[1]) || 0;
  const classCount = Number((/(?:UDO|TCH) classes\s+(\d+)/.exec(text) || [])[1]) || 0;
  let decoded = 0;
  for (const m of text.matchAll(/^\s*decoded\s+\S+\s+(\d+)\s*$/gm)) decoded += Number(m[1]) || 0;
  return {
    detected: entities > 0 || classCount > 0,
    classes: [],
    entities,
    classCount,
    decoded,
    source: "cli",
  };
}

/* ───────────────────────────── dump 读写 ───────────────────────────── */

/** 把 dump 的 data 落到 `<dir>/udo-dump.json`（先写临时文件再改名，避免读到半截）。 */
export function persistUdoDump(dir, data) {
  if (!dir || !data || !Array.isArray(data.entities)) return null;
  const target = path.join(dir, UDO_DUMP_FILE);
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(
      tmp,
      JSON.stringify({ schema_version: 1, source: "udo-cli", savedAt: Date.now(), data })
    );
    fs.renameSync(tmp, target);
    return target;
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    return null;
  }
}

/**
 * 这份 dump 是不是**旧的**：CLI gen-47 之前不知道块内对象属于哪个块，产出的坐标语义与
 * 现在不同，server 不能拿它按记录回注（v63 的双重变换就是这么来的）。判据只用 dump
 * 自述的字段，不需要 DWG：
 *
 *   · 旧格式（0.3.0 之前字段名是 `stats.tch_entities`）→ 一律重解，避免沿用旧计数；
 *   · 作用域方言（AC1018 + 注册了 `AEC_*` 类名，与 CLI 的 `--origins auto` 同一判据）
 *     之外的 dump 一律不旧（施工005 / 机柜图纸永远不会被重新解码）；
 *   · 作用域内：有 `origin` 但**一条都没有 `origin.block`** → v63 的 dump（旧）；
 *   · 作用域内：完全没有 `diagnostics.origins`（连 `origin` 都没有）→ gen-47 之前的 dump（旧）；
 *   · 有 `origin.block`，或本来就没有块内对象（`diagnostics.origins` 在、`origin` 0 条）→ 新。
 *
 * @param {any} data dump 的 `data` 段
 */
export function udoDumpNeedsRefresh(data) {
  if (!data || typeof data !== "object") return false;
  // 0.3.0 改名前的 dump 用 tch_entities 记数：字段名变了，必须重解一次。
  if (data.stats && typeof data.stats === "object" && !Number.isFinite(Number(data.stats.udo_entities))) {
    return true;
  }
  if (data.dwg_version !== "AC1018") return false;
  const entities = Array.isArray(data.entities) ? data.entities : [];
  const aec = entities.some((e) => typeof e?.class === "string" && e.class.startsWith("AEC_"));
  if (!aec) return false;
  let origins = 0;
  let blocks = 0;
  for (const e of entities) {
    const o = e?.decode?.origin;
    if (!o || typeof o !== "object") continue;
    origins++;
    if (typeof o.block === "string" && o.block) blocks++;
  }
  if (origins > 0) return blocks === 0;
  return data.diagnostics?.origins == null;
}

/**
 * 取一份可用的 dump（给 `buildWebDxf` 用）。顺序：
 *   1. `dumpPath` 存在且可解析，且**不是旧格式**（`udoDumpNeedsRefresh`）→ 直接用；
 *   2. `sourcePath` 是 DWG 且字节预筛命中 → 就地跑 CLI 并落盘（缓存尚未生成、或缓存里的
 *      dump 是旧 CLI 产出的兜底；v64 的双重变换修复必须拿到 `origin.block`）；
 *   3. 重新解码失败但旧 dump 还能解析 → 用旧 dump（graceful，至少不比之前差）；
 *   4. 否则 `{ ok:false }`。
 * 绝不抛。
 * @param {{ dumpPath?: string, sourcePath?: string, cacheDir?: string, timeoutMs?: number }} [opts]
 */
export async function loadUdoDump(opts = {}) {
  if (!udoEnabled()) return { ok: false, reason: "disabled" };

  let cached = null;
  /* 0.3.0 改名前的缓存叫 tch-dump.json：新文件读不到时回退读旧名（只读不写）。 */
  let dumpPath = opts.dumpPath;
  if (dumpPath && !fs.existsSync(dumpPath)) {
    const legacy = path.join(path.dirname(dumpPath), "tch-dump.json");
    if (fs.existsSync(legacy)) dumpPath = legacy;
  }
  if (dumpPath) {
    try {
      const doc = JSON.parse(fs.readFileSync(dumpPath, "utf8"));
      const data = doc?.data || doc;
      if (data && Array.isArray(data.entities)) cached = data;
    } catch {
      /* 文件不存在/半截 → 走兜底 */
    }
  }
  if (cached && !udoDumpNeedsRefresh(cached)) return { ok: true, data: cached, source: "cache" };

  const src = opts.sourcePath;
  if (!src || typeof src !== "string" || !/\.dwg$/i.test(src)) {
    if (cached) return { ok: true, data: cached, source: "cache", stale: true };
    return { ok: false, reason: "no-source" };
  }
  if (!(await probeUdoDwg(src, opts))) {
    if (cached) return { ok: true, data: cached, source: "cache", stale: true };
    return { ok: false, reason: "no-objects" };
  }

  const r = await decodeUdo(src, { timeoutMs: opts.timeoutMs });
  if (!r.ok) {
    if (cached) return { ok: true, data: cached, source: "cache", stale: true };
    return { ok: false, reason: r.error };
  }
  if (opts.cacheDir) persistUdoDump(opts.cacheDir, r.data);
  return { ok: true, data: r.data, source: "cli" };
}

/* ───────────────────────────── 几何 → DXF ───────────────────────────── */

/** DXF 数值：最多 6 位小数，去掉多余的 0，不要 -0、不要科学计数法。 */
function num(v) {
  if (!Number.isFinite(v)) return null;
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(6).replace(/0+$/, "").replace(/\.$/, "") || "0";
}

const isPt = (p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]);

/**
 * 洞口 → 矩形四角（按周长顺序，不自交）。
 * 优先用 CLI 给的 `wall_face_segments`（两条墙面线段，已与 ground truth 逐个重合验证）；
 * 缺失时用中心点 + 旋转 + 宽/半墙厚反算同一条矩形。
 * @returns {[number,number][]|null} 4 个点；几何不合法 → null
 */
export function openingQuad(o) {
  if (!o || typeof o !== "object") return null;
  const faces = o.wall_face_segments;
  if (Array.isArray(faces) && faces.length >= 2) {
    const [f0, f1] = faces;
    if (Array.isArray(f0) && f0.length >= 2 && Array.isArray(f1) && f1.length >= 2) {
      const a = f0[0];
      const b = f0[1];
      const c = f1[0];
      const d = f1[1];
      if (isPt(a) && isPt(b) && isPt(c) && isPt(d)) {
        // 沿 f0 正向，再用 f1 的**反序**闭合（f1 与 f0 同向时直接 a,b,c,d 会画成蝴蝶结）
        return [
          [a[0], a[1]],
          [b[0], b[1]],
          [d[0], d[1]],
          [c[0], c[1]],
        ];
      }
    }
  }
  const x = Number(o.x);
  const y = Number(o.y);
  const w = Number(o.width);
  const ht = Number(o.half_thickness);
  const rot = Number(o.rotation);
  if (![x, y, w, ht, rot].every(Number.isFinite) || !(w > 0)) return null;
  const u = [Math.cos(rot), Math.sin(rot)];
  const n = [-u[1], u[0]];
  const hw = w / 2;
  const at = (su, sn) => [
    x + u[0] * hw * su + n[0] * ht * sn,
    y + u[1] * hw * su + n[1] * ht * sn,
  ];
  const quad = [at(-1, 1), at(1, 1), at(1, -1), at(-1, -1)];
  return quad.every(isPt) ? quad : null;
}

/** 四角是否有面积（退化矩形不注入，免得画出一条线）。 */
function quadArea(quad) {
  if (!quad || quad.length < 4) return 0;
  let a = 0;
  for (let i = 0; i < quad.length; i++) {
    const p = quad[i];
    const q = quad[(i + 1) % quad.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

/**
 * 墙体 → 两条墙面线（`left` / `right`，各是一条 2 点折线）。
 *
 * CLI 给的是**中心线 + 两侧宽度**（`start/end/left_offset/right_offset`），
 * 实测 1959/1959 满足 `thickness === left_offset + right_offset`；
 * 单侧为 0 的墙（100 + 125 面）也真实存在 —— 那就是有一面压在中心线上，
 * 照常画出（不做"猜厚度"）。
 * @returns {{left:[number,number][], right:[number,number][]}|null}
 */
export function wallFaces(w) {
  if (!w || typeof w !== "object") return null;
  const s = w.start;
  const e = w.end;
  if (!isPt(s) || !isPt(e)) return null;
  const dx = e[0] - s[0];
  const dy = e[1] - s[1];
  const len = Math.hypot(dx, dy);
  if (!(len > 1e-9)) return null;
  const left = Number(w.left_offset);
  const right = Number(w.right_offset);
  const lo = Number.isFinite(left) ? left : 0;
  const ro = Number.isFinite(right) ? right : 0;
  if (lo === 0 && ro === 0) return null; // 没有厚度信息：不画，免得画出中心线冒充墙面
  // 单位法向（逆时针 90°）：左面 +n*left，右面 -n*right
  const nx = -dy / len;
  const ny = dx / len;
  const out = { left: null, right: null };
  if (lo > 0) {
    out.left = [
      [s[0] + nx * lo, s[1] + ny * lo],
      [e[0] + nx * lo, e[1] + ny * lo],
    ];
  }
  if (ro > 0) {
    out.right = [
      [s[0] - nx * ro, s[1] - ny * ro],
      [e[0] - nx * ro, e[1] - ny * ro],
    ];
  }
  return out;
}

/* ───────────────────────────── 洞口局部坐标系 / 门符号 ─────────────────────────────
 * 下面两条规则不是拍脑袋的：都是从 `施工005` 与 ground truth（浩辰导出的 DXF 里
 * `IAEC_OPENING` 代理图形）逐洞口配对统计出来的，脚本 `scripts/tch-doors.mjs` 可复算：
 *   · 门扇长度 / 弧半径 = 洞口宽 × 0.975（541 段弧里 291 段 r/w = 0.9750，35 段 = 1.0，
 *     其余是双扇门 0.4875 = 0.975/2；用 0.975 时半径中位误差 0.0 mm、p90 2.5 mm）；
 *   · 铰链在洞口**宽度轴的一端**、墙厚方向的**中心线**上（|cN| 中位数 0.0 mm）；
 *   · 开启弧恒为 90°（541 段弧里 89–90° 占 463 段），弧心就是铰链点；
 *   · 铰链在**离墙端更近的那一端**：333 个单弧洞口 283 个符合（85.0%）；
 *   · 门扇朝**更空的一侧**开（该侧沿法向到最近墙面的距离更远）：296 个可判洞口 229 个符合（77.4%）。
 * 天正的洞口对象里**没有**存左右开/铰链端的字段（`udo-core` 的七个 BitDouble 就是
 * x,y,z,width,half_thickness,height,rotation），所以上两条只能按统计规则推断，
 * 不能当成精确还原；命中率在报告里如实给出。
 */

/** 门扇相对洞口宽的收缩比（= 弧半径 / 洞口宽）。 */
export const DOOR_LEAF_RATIO = 0.975;

/** 双扇门每扇的长度比（T3 `$DorLib2D$00000002` 实测：0.4875 = 0.975/2）。 */
export const DOUBLE_LEAF_RATIO = 0.4875;

/** 开启弧离散成折线的段数（ground truth 用 10 个点 = 9 段）。 */
export const DOOR_ARC_SEGMENTS = 9;

/* ───────────────────────────── 洞口语义：门 / 窗 ─────────────────────────────
 * `TDbOpening` 的载荷里**没有**门/窗类型字段（七个 BitDouble = x,y,z,w,ht,h,rot），
 * 但 `z` 是洞口的**底标高**：门贴地（z≈0，卫生间隔断门 z=400），窗有窗台
 * （本图 175 扇窗全部 z=900）。这是比图层名更可靠的判据 —— 本图有 8 个窗
 * 画在 DOOR_FIRE 层、10 樘门画在 WINDOW 层，只看层名会两边都判错。
 *
 * 判据（按优先级，全部可解释，没有按图层名写死的白名单）：
 *   1. 底标高 ≥ 600 mm → 窗（窗台），门族图层也不例外；
 *   2. 门族图层（DOOR / LATRINE / 门）→ 门；
 *   3. 窗族图层（WINDOW / 窗）→ 只有“贴地 + 门高 + 门宽”才翻成门；
 *      本图 10 樘窗层真门：z=0、宽 900–2000、高 2100–2500；
 *      施工005 的窗层洞口高 1800–2000，不会被误翻；
 *   4. 中性图层（建筑 / 0）→ 底标高 > 200 mm 判窗，其余判门（施工005 的
 *      8 扇窗 z=300/500 就落在这里）。
 *   5. A_ABOVE / WINNUM 这类“洞口上方/窗编号”层一律按窗，不参与第 3 条翻门。
 * 对 `智能化图纸` 的 T3 真值：319/319（144 门 + 175 窗）逐一命中，0 误判。
 */
export const WINDOW_SILL_MIN = 600;
export const WINDOW_LAYER_DOOR_HEIGHT_MIN = 2050;
export const WINDOW_LAYER_DOOR_WIDTH_MAX = 2000;

const DOOR_LAYER_RE = /(?:^|[-_$\s])DOOR(?:$|[-_$\s])|LATRINE|门洞|门$/i;
const WINDOW_LAYER_RE = /WINDOW|窗|WINNUM|ABOVE/i;
/** 只有真正的窗层允许“窗层上的门”例外；A_ABOVE/WINNUM 不参与。 */
const WINDOW_DOOR_EXCEPTION_RE = /WINDOW|窗/i;

/**
 * 判定一个洞口是门还是窗（纯函数）。
 * @param {any} opening dump 的 `decode.opening`
 * @param {string} rawLayer 洞口原始图层
 * @returns {{kind:"door"|"window", reason:string, sill:number|null, doorLayer:boolean, windowLayer:boolean}}
 */
export function classifyOpening(opening, rawLayer) {
  const layer = typeof rawLayer === "string" ? rawLayer : "";
  const w = Number(opening?.width);
  const h = Number(opening?.height);
  const zRaw = Number(opening?.z);
  const sill = Number.isFinite(zRaw) ? zRaw : null;
  const doorLayer = DOOR_LAYER_RE.test(layer);
  const windowLayer = WINDOW_LAYER_RE.test(layer);
  const out = { kind: "door", reason: "", sill, doorLayer, windowLayer };

  /* ① 窗台：门洞贴地，窗洞有底标高。卫生间隔断门 z=400 仍低于 600。 */
  if (sill !== null && sill >= WINDOW_SILL_MIN) {
    out.kind = "window";
    out.reason = `sill ${sill} >= ${WINDOW_SILL_MIN}`;
    return out;
  }
  /* ② 门族图层：DOOR_FIRE / A-DOOR / A-DOOR-FIRE / LATRINE / 人防门 */
  if (doorLayer) {
    out.reason = "door-layer";
    return out;
  }
  /* ③ 窗族图层：贴地 + 门高 + 门宽的才翻成门（本图 10 樘） */
  if (windowLayer) {
    const canBeDoor =
      WINDOW_DOOR_EXCEPTION_RE.test(layer) &&
      sill !== null &&
      sill <= 100 &&
      Number.isFinite(w) &&
      Number.isFinite(h) &&
      w >= 850 &&
      w <= WINDOW_LAYER_DOOR_WIDTH_MAX &&
      h >= WINDOW_LAYER_DOOR_HEIGHT_MIN;
    if (canBeDoor) {
      out.reason = "window-layer floor-level door-sized opening";
      return out;
    }
    out.kind = "window";
    out.reason = "window-layer";
    return out;
  }
  /* ④ 中性图层：底标高 > 200 → 窗（施工005 的 300/500 窗台） */
  if (sill !== null && sill > 200) {
    out.kind = "window";
    out.reason = `neutral layer sill ${sill} > 200`;
    return out;
  }
  out.reason = "neutral layer floor-level";
  return out;
}

/**
 * 门型：`double`（双扇 + 两段 90° 弧）/ `single`（单扇 + 一段弧）/ `sliding`（两扇贴墙、无弧）。
 *
 * T3 真值（`智能化图纸`，144 樘解出的门）：
 *   · 126 双扇：`$DorLib2D$00000002`（900/1500/1800）—— 两块 0.4875w 门扇 + 两段弧；
 *   · 8 单扇：`$DorLib2D$00000001`（窗层 900）+ `$TCHSYS$APDOOR2D`（LATRINE 600）；
 *   · 10 无弧：`$DORLIB2D$00000127`（1300）、`$DorLib2D$00000138`（2000）、
 *     `$DorLib2D$00000213`（3900）—— 块内 0 段 ARC，按推拉/卷帘画两扇贴墙。
 * 规则命中 144/144（只看“双扇/单扇/无弧”三类）。
 */
export function doorTypeOf(opening, rawLayer) {
  const w = Number(opening?.width);
  const layer = typeof rawLayer === "string" ? rawLayer : "";
  const doorLayer = DOOR_LAYER_RE.test(layer);
  const windowLayer = WINDOW_LAYER_RE.test(layer) && !doorLayer;
  if (!Number.isFinite(w) || w <= 0) return "single";
  /* 卷帘/推拉：3.9 m 的 213、窗层 1.3/2.0 m 的 127/138 在 T3 都没有开启弧。 */
  if (w >= 3000) return "sliding";
  if (windowLayer && w >= 1200) return "sliding";
  /* 窗层 900 是单扇 `$DorLib2D$00000001`；门层 900 是双扇 `00000002`。 */
  if (windowLayer && w < 1000) return "single";
  if (doorLayer && w >= 850 && w <= 950) return "double";
  if (w >= 1200) return "double";
  return "single";
}

const vsub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const vlen = (v) => Math.hypot(v[0], v[1]);
const vunit = (v) => {
  const n = vlen(v);
  return n > 1e-12 ? [v[0] / n, v[1] / n] : null;
};
const vdot = (a, b) => a[0] * b[0] + a[1] * b[1];
const vcross = (a, b) => a[0] * b[1] - a[1] * b[0];
const vadd = (a, b) => [a[0] + b[0], a[1] + b[1]];
const vmul = (a, k) => [a[0] * k, a[1] * k];

/** 点到线段距离。 */
function distPointSeg(p, seg) {
  const ab = vsub(seg[1], seg[0]);
  const l2 = vdot(ab, ab);
  if (l2 < 1e-12) return vlen(vsub(p, seg[0]));
  let t = vdot(vsub(p, seg[0]), ab) / l2;
  t = Math.max(0, Math.min(1, t));
  return vlen(vsub(p, vadd(seg[0], vmul(ab, t))));
}

/** 两条直线（各由两点给出）的交点；平行/退化 → null。 */
function lineIntersect(a0, a1, b0, b1) {
  const da = vsub(a1, a0);
  const db = vsub(b1, b0);
  const den = vcross(da, db);
  if (Math.abs(den) < 1e-9) return null;
  const t = vcross(vsub(b0, a0), db) / den;
  return [a0[0] + da[0] * t, a0[1] + da[1] * t];
}

/**
 * 洞口局部坐标系。
 * `u` = 宽度轴（= CLI 的 `direction`），`n` = 墙厚轴（= CLI 的 `normal`，指向 faces[0] 一侧），
 * `P` = 洞口中心，`w` = 宽，`ht` = 半墙厚。
 * 优先用 `wall_face_segments`（两条面线就是真值），缺失时按中心/旋转/宽反算；
 * `x,y` 解出来是 0（个别对象解偏了）但面线正常时，用面线中位点当中心。
 * @returns {{P:[number,number],u:[number,number],n:[number,number],w:number,ht:number}|null}
 */
export function openingFrame(o) {
  if (!o || typeof o !== "object") return null;
  const faces = o.wall_face_segments;
  if (Array.isArray(faces) && faces.length >= 2) {
    const [f0, f1] = faces;
    if (Array.isArray(f0) && f0.length >= 2 && Array.isArray(f1) && f1.length >= 2) {
      const a = f0[0];
      const b = f0[1];
      const c = f1[0];
      const d = f1[1];
      if (isPt(a) && isPt(b) && isPt(c) && isPt(d)) {
        const u = vunit(vsub(b, a));
        const uu = u ? vunit(vsub(d, c)) : null;
        const n = vunit(vsub(a, c));
        if (u && uu && n && vdot(u, uu) > 0.99) {
          const w = (vlen(vsub(b, a)) + vlen(vsub(d, c))) / 2;
          const span = (vlen(vsub(a, c)) + vlen(vsub(b, d))) / 2;
          const mid = [
            (a[0] + b[0] + c[0] + d[0]) / 4,
            (a[1] + b[1] + c[1] + d[1]) / 4,
          ];
          const x = Number(o.x);
          const y = Number(o.y);
          const placed =
            Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) + Math.abs(y) > 1e-6;
          if (w > 1e-9) {
            return { P: placed ? [x, y] : mid, u, n, w, ht: span / 2 };
          }
        }
      }
    }
  }
  const x = Number(o.x);
  const y = Number(o.y);
  const w = Number(o.width);
  const ht = Number(o.half_thickness);
  const rot = Number(o.rotation);
  if (![x, y, w, ht, rot].every(Number.isFinite) || !(w > 0)) return null;
  const u = [Math.cos(rot), Math.sin(rot)];
  return { P: [x, y], u, n: [-u[1], u[0]], w, ht };
}

/** 沿 `dir` 从 `from` 走的射线，到任一墙线段的最近交点距离；没有交点 → Infinity。 */
function rayDistance(from, dir, limit, segs) {
  let best = Infinity;
  for (const [a, b] of segs) {
    const ab = vsub(b, a);
    const den = vcross(dir, ab);
    if (Math.abs(den) < 1e-9) continue;
    const t = vcross(vsub(a, from), ab) / den;
    if (!(t > 1e-6) || t >= best || t > limit) continue;
    const s = vcross(vsub(a, from), dir) / den;
    if (s < -1e-6 || s > 1 + 1e-6) continue;
    best = t;
  }
  return best;
}

/**
 * 铰链端：`-1` = 洞口 `-u` 一侧，`+1` = `+u` 一侧。
 * 规则（ground truth 统计 85.0%）：取离洞口更近的那个**墙端**所在的一侧 ——
 * 也就是门贴着墙角装（洞口到墙端 0 距离那一侧几乎没有例外）。
 */
function hingeSide(f, walls) {
  let gapNeg = Infinity;
  let gapPos = Infinity;
  const reach = f.w * 5;
  for (const w of walls || []) {
    if (!w || !isPt(w.start) || !isPt(w.end)) continue;
    if (distPointSeg(f.P, [w.start, w.end]) > reach) continue;
    for (const q of [w.start, w.end]) {
      const t = vdot(vsub(q, f.P), f.u);
      if (t < -f.w / 2) gapNeg = Math.min(gapNeg, -f.w / 2 - t);
      else if (t > f.w / 2) gapPos = Math.min(gapPos, t - f.w / 2);
    }
  }
  if (gapNeg === gapPos) return -1; // 两侧一样（或都没有墙端）：固定取 -u，至少是确定的
  return gapNeg < gapPos ? -1 : 1;
}

/**
 * 开启侧：`-1` / `+1` 指 `-n` / `+n` 一侧。
 * 规则（ground truth 统计 77.4%）：朝**更空的一侧**开 —— 从洞口中心沿 ±n 打射线，
 * 先碰到墙面的那侧是"挡住的"，另一侧就是门扇扫过的空间。
 */
function swingSide(f, faces) {
  /* 注意：这里用**未修剪**的原始墙面线 —— 天正的墙在洞口处是断开的，
   * 哪一侧的墙还在延伸、哪一侧是空地，正是"门往哪边开"的统计信号（77.4%）。
   * 修剪后的面线在洞口附近被切掉，这个信号就没有了。 */
  const segs = Array.isArray(faces) ? faces : [];
  const dPos = rayDistance(f.P, f.n, f.w, segs);
  const dNeg = rayDistance(f.P, [-f.n[0], -f.n[1]], f.w, segs);
  if (dPos === dNeg) return 1; // 两侧一样空：固定取 +n
  return dPos > dNeg ? 1 : -1;
}

/**
 * 门符号（纯函数）：门扇线 + 90° 开启弧。
 *
 * 返回 `{ leaf, arc, hinge, swing, leafLength }`，其中
 *   `leaf` = `[[hinge],[tip]]`（世界坐标，门扇画在开启位置、垂直于墙）；
 *   `arc`  = `{cx,cy,r,a0,a1}`（弧心 = 铰链点，`a0` = 门扇方向，`a1` = 关闭位置方向）。
 *
 * `ctx.walls`（洞口所属墙的中心线）与 `ctx.faces`（已修正的墙面线）可选：给了就用
 * ground truth 统计出来的铰链端 / 开启侧规则，没给就退化成固定一侧（仍是合法门符号）。
 * @param {any} opening dump 里的 `decode.opening`
 * @param {{walls?:{start:number[],end:number[]}[], faces:[number,number][][]}} [ctx]
 */
export function doorSymbol(opening, ctx = {}) {
  const f = openingFrame(opening);
  if (!f) return null;
  const inset = f.w * (1 - DOOR_LEAF_RATIO);
  const leafLength = f.w - inset;
  if (!(leafLength > 1e-6)) return null;
  const hinge = hingeSide(f, ctx.walls);
  const swing = swingSide(f, ctx.faces);
  const anchor = vadd(f.P, vmul(f.u, hinge * (f.w / 2 - inset)));
  const tip = vadd(anchor, vmul(f.n, swing * leafLength));
  const closed = vadd(anchor, vmul(f.u, -hinge * leafLength));
  const a0 = Math.atan2(tip[1] - anchor[1], tip[0] - anchor[0]);
  const a1 = Math.atan2(closed[1] - anchor[1], closed[0] - anchor[0]);
  return {
    leaf: [anchor, tip],
    arc: { cx: anchor[0], cy: anchor[1], r: leafLength, a0, a1 },
    hinge,
    swing,
    leafLength,
  };
}

/** 由铰链点 / 开位置 / 关位置生成一段 90° 弧（弧心 = 铰链）。 */
function arcOf(anchor, tip, closed) {
  return {
    cx: anchor[0],
    cy: anchor[1],
    r: vlen(vsub(tip, anchor)),
    a0: Math.atan2(tip[1] - anchor[1], tip[0] - anchor[0]),
    a1: Math.atan2(closed[1] - anchor[1], closed[0] - anchor[0]),
  };
}

/**
 * 按门型生成**一组**门符号（纯函数）。
 *
 * `type` 默认由 `doorTypeOf(opening, rawLayer)` 推断；也可由调用方显式给。
 * 返回：
 *   `{ type, leaves:[[a,b],...], arcs:[{cx,cy,r,a0,a1},...], hinge, swing, leafLength }`
 *   · double  —— 两扇 0.4875w，铰链在洞口两端，关闭位置都在洞口中心；
 *   · single  —— 一扇 0.975w，铰链在离墙端更近的一端（沿用 `doorSymbol` 统计规则）；
 *   · sliding —— 两扇贴墙（关闭位置），不画开启弧（T3 的 127/138/213 块内 0 段 ARC）。
 *
 * @param {any} opening dump 的 `decode.opening`
 * @param {{walls?:{start:number[],end:number[]}[], faces:[number,number][][]}} [ctx]
 * @param {{rawLayer?:string, type?:string}} [opts]
 */
export function doorSymbols(opening, ctx = {}, opts = {}) {
  const f = openingFrame(opening);
  if (!f) return null;
  const type = opts.type || doorTypeOf(opening, opts.rawLayer);
  const swing = swingSide(f, ctx.faces);

  if (type === "single") {
    const sym = doorSymbol(opening, ctx);
    if (!sym) return null;
    return {
      type,
      leaves: [sym.leaf],
      arcs: [sym.arc],
      hinge: sym.hinge,
      swing: sym.swing,
      leafLength: sym.leafLength,
    };
  }

  const off = f.w * (DOUBLE_LEAF_RATIO);
  const leafLength = f.w * DOUBLE_LEAF_RATIO;
  if (!(leafLength > 1e-6)) return null;

  if (type === "sliding") {
    /* 两扇贴墙、从两端向中心，留 0.025w 的中缝；无弧。 */
    const leftHinge = vadd(f.P, vmul(f.u, -f.w / 2));
    const rightHinge = vadd(f.P, vmul(f.u, f.w / 2));
    return {
      type,
      leaves: [
        [leftHinge, vadd(leftHinge, vmul(f.u, leafLength))],
        [rightHinge, vadd(rightHinge, vmul(f.u, -leafLength))],
      ],
      arcs: [],
      hinge: 0,
      swing,
      leafLength,
    };
  }

  /* double：铰链在 ±0.4875w，两扇都朝同一侧开，关闭位置都在中心。 */
  const leftHinge = vadd(f.P, vmul(f.u, -off));
  const rightHinge = vadd(f.P, vmul(f.u, off));
  const leftTip = vadd(leftHinge, vmul(f.n, swing * leafLength));
  const rightTip = vadd(rightHinge, vmul(f.n, swing * leafLength));
  return {
    type: "double",
    leaves: [
      [leftHinge, leftTip],
      [rightHinge, rightTip],
    ],
    arcs: [arcOf(leftHinge, leftTip, f.P), arcOf(rightHinge, rightTip, f.P)],
    hinge: 0,
    swing,
    leafLength,
  };
}

/**
 * 把 `doorSymbol().arc` 离散成折线点（与 ground truth 同样的近似：10 个点）。
 * 走短弧方向，总转角 = |a1-a0| ≤ π。
 */
export function arcPolyline(arc, segments = DOOR_ARC_SEGMENTS) {
  if (!arc || !Number.isFinite(arc.cx) || !Number.isFinite(arc.cy) || !(arc.r > 0)) return null;
  const n = Math.max(2, Math.min(180, Math.round(segments)));
  let delta = arc.a1 - arc.a0;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta <= -Math.PI) delta += 2 * Math.PI;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = arc.a0 + (delta * i) / n;
    pts.push([arc.cx + Math.cos(a) * arc.r, arc.cy + Math.sin(a) * arc.r]);
  }
  return pts;
}

/* ───────────────────────────── 墙接头：miter / 延伸-裁剪 ─────────────────────────────
 * ground truth（`施工005` 的 1959 段 TCH_WALL → 浩辰 DXF 里 7345 条墙面线）里，
 * 悬空端点只有 0.5%，说明导出方在每个 L/T/十字/转角处都把面线**接上了**：
 *   · L 转角：四条面线两两求交（凸角、凹角各一个交点），外面那圈是闭合的；
 *   · T / 十字：被穿过的墙保持连续，断头墙的面线延伸到对面墙上；
 *   · 洞口：面线在洞口边被**切开**（ground truth 里每条面线都在洞口处断开）。
 * 所以这里不是"把线简单延长"，而是按与邻线的**交点**搬端点（延伸或裁剪都由交点决定），
 * 再过一遍洞口裁剪。
 */

/**
 * 墙面线接头修正。就地不改入参，返回新的面线数组。
 * @param {{points:[number,number][], thickness?:number}[]} faces
 * @param {{slack?:number, factor?:number}} [opts]
 * @returns {{faces:any[], mitered:number, snapped:number}}
 */
export function connectWallFaces(faces, opts = {}) {
  if (!Array.isArray(faces) || faces.length === 0) return { faces: [], mitered: 0, snapped: 0 };
  const slack = Number.isFinite(opts.slack) ? Math.max(0, opts.slack) : 20;
  const factor = Number.isFinite(opts.factor) ? Math.max(0, opts.factor) : 0.75;
  const out = faces.map((f) => ({
    ...f,
    points: f.points.map((p) => [p[0], p[1]]),
  }));
  /* 所有判定都基于**原始**面线（快照）：面线只会在自己的直线上伸缩，方向不变；
   * 若拿"已经被别人搬过"的端点当基准，结果就和处理顺序有关（实测会漏掉 T 形接头）。 */
  const orig = out.map((f) => f.points.map((p) => [p[0], p[1]]));
  /* 每个端点的"够得着"半径：墙越厚，端点到交点的距离越大（斜角还要再大一点）。 */
  const tol = out.map((f) =>
    Math.max(slack, Math.abs(Number(f.thickness) || 0) * factor + slack)
  );
  const maxTol = Math.max(...tol);
  const cell = Math.max(500, maxTol * 2);
  const grid = new Map();
  const kk = (cx, cy) => `${cx},${cy}`;
  for (let i = 0; i < orig.length; i++) {
    const [a, b] = orig[i];
    if (!isPt(a) || !isPt(b)) continue;
    const t = tol[i];
    const x0 = Math.floor((Math.min(a[0], b[0]) - t) / cell);
    const x1 = Math.floor((Math.max(a[0], b[0]) + t) / cell);
    const y0 = Math.floor((Math.min(a[1], b[1]) - t) / cell);
    const y1 = Math.floor((Math.max(a[1], b[1]) + t) / cell);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const k = kk(x, y);
        const list = grid.get(k);
        if (list) list.push(i);
        else grid.set(k, [i]);
      }
    }
  }
  const nearOf = (p) => grid.get(kk(Math.floor(p[0] / cell), Math.floor(p[1] / cell))) || [];
  let mitered = 0;
  let snapped = 0;

  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < out.length; i++) {
      const seg = out[i].points;
      const base = orig[i];
      if (!isPt(base[0]) || !isPt(base[1])) continue;
      for (let e = 0; e < 2; e++) {
        const E = seg[e];
        const dir = vunit(vsub(base[1 - e], base[e]));
        if (!dir) continue;
        const lenS = vlen(vsub(base[1 - e], base[e]));
        const reach = tol[i];
        let best = null;
        let snap = null;
        for (const j of nearOf(E)) {
          if (j === i) continue;
          const c = orig[j];
          if (!isPt(c[0]) || !isPt(c[1])) continue;
          const cd = vunit(vsub(c[1], c[0]));
          if (!cd) continue;
          const lenC = vlen(vsub(c[1], c[0]));
          const span = Math.max(tol[i], tol[j]);
          if (Math.abs(vcross(dir, cd)) < 1e-3) {
            /* 平行且共线（同一堵墙被切成了两段）：端点直接贴上去，消灭 0.1mm 级的缝。
             * 单独记，不能让它把真正的角部 miter 挤掉（重复墙那种 0 距离吸附很常见）。 */
            if (distPointSeg(E, c) > span) continue;
            if (Math.abs(vcross(cd, vsub(c[0], E))) > 1.5) continue;
            for (const q of c) {
              const gap = vlen(vsub(q, E));
              if (gap > 1e-6 && gap <= reach && (!snap || gap < snap.gap)) {
                snap = { gap, p: q };
              }
            }
            continue;
          }
          /* 用**直线**的垂距筛选：对面那条面线可能已经被别的接头缩短了，
           * 只要交点还在"够得着"的范围内就该接上（T 形接头就是这样）。 */
          if (Math.abs(vcross(cd, vsub(c[0], E))) > span) continue;
          const P = lineIntersect(base[e], base[1 - e], c[0], c[1]);
          if (!P) continue;
          const move = vlen(vsub(E, P));
          if (move > reach) continue;
          const tS = vlen(vsub(base[e], P)) / (lenS || 1);
          const tC = vlen(vsub(c[0], P)) / (lenC || 1);
          const room = reach / Math.max(1, Math.min(lenS, lenC));
          if (tS > 1 + room || tC > 1 + room) continue;
          if (best && move >= best.gap) continue;
          best = { gap: move, p: P, j };
        }
        if (!best && snap) best = { ...snap, j: -1 };
        if (!best) continue;
        E[0] = best.p[0];
        E[1] = best.p[1];
        if (best.j < 0) {
          snapped++;
          continue;
        }
        mitered++;
        /* 角部：邻线也在这个交点上有端点 → 一起搬过来（真正的 miter，不是叠线） */
        const c = out[best.j].points;
        for (let k = 0; k < 2; k++) {
          if (vlen(vsub(orig[best.j][k], best.p)) <= reach) {
            c[k][0] = best.p[0];
            c[k][1] = best.p[1];
          }
        }
      }
    }
  }

  return {
    faces: out.filter((f) => vlen(vsub(f.points[0], f.points[1])) > 1e-6),
    mitered,
    snapped,
  };
}

/**
 * 用洞口把墙面线切开（ground truth 画法：面线在洞口边断开，
 * 洞口两侧由洞口矩形的短边闭合）。
 * @param {{points:[number,number][]}[]} faces
 * @param {{P:number[],u:number[],n:number[],w:number,ht:number}[]} frames `openingFrame()` 的结果
 * @param {{gap?:number, slant?:number}} [opts]
 * @returns {any[]} 切开后的面线（可能一条变多条）
 */
export function trimWallFacesAtOpenings(faces, frames, opts = {}) {
  if (!Array.isArray(faces) || faces.length === 0) return [];
  if (!Array.isArray(frames) || frames.length === 0) return faces;
  const gap = Number.isFinite(opts.gap) ? Math.max(0, opts.gap) : 1.5;
  const slant = Number.isFinite(opts.slant) ? Math.max(1e-6, opts.slant) : 0.02;

  /* 洞口空间索引（洞口数量级 10²–10³，按 bbox 装桶） */
  const cell = 4000;
  const grid = new Map();
  const kk = (cx, cy) => `${cx},${cy}`;
  for (const f of frames) {
    if (!f || !isPt(f.P)) continue;
    const r = f.w / 2 + Math.abs(f.ht) + 1;
    const x0 = Math.floor((f.P[0] - r) / cell);
    const x1 = Math.floor((f.P[0] + r) / cell);
    const y0 = Math.floor((f.P[1] - r) / cell);
    const y1 = Math.floor((f.P[1] + r) / cell);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const k = kk(x, y);
        const list = grid.get(k);
        if (list) list.push(f);
        else grid.set(k, [f]);
      }
    }
  }
  const nearOf = (p) => grid.get(kk(Math.floor(p[0] / cell), Math.floor(p[1] / cell))) || [];

  const out = [];
  for (const f of faces) {
    let pieces = [f.points.map((p) => [p[0], p[1]])];
    const seen = new Set();
    const cand = [...nearOf(pieces[0][0]), ...nearOf(pieces[0][1])];
    for (const fr of cand) {
      if (!fr || seen.has(fr)) continue;
      seen.add(fr);
      pieces = pieces.flatMap((seg) => cutSegmentAtOpening(seg, fr, gap, slant));
      if (pieces.length === 0) break;
    }
    for (const points of pieces) {
      if (vlen(vsub(points[0], points[1])) > 1e-6) out.push({ ...f, points });
    }
  }
  return out;
}

/** 一条面线被一个洞口切掉中间段后的剩余部分（洞口外的两侧）。 */function cutSegmentAtOpening(seg, fr, gap, slant) {
  const d = vunit(vsub(seg[1], seg[0]));
  if (!d) return [seg];
  if (Math.abs(vcross(d, fr.u)) > slant) return [seg];
  const off = Math.abs(vcross(fr.u, vsub(fr.P, seg[0])));
  if (off > Math.abs(fr.ht) + gap) return [seg];
  const t0 = vdot(vsub(seg[0], fr.P), fr.u);
  const t1 = vdot(vsub(seg[1], fr.P), fr.u);
  const lo = Math.min(t0, t1);
  const hi = Math.max(t0, t1);
  const a = -fr.w / 2;
  const b = fr.w / 2;
  if (hi <= a || lo >= b) return [seg];
  const at = (t) => vadd(seg[0], vmul(fr.u, t - t0));
  const out = [];
  if (lo < a) out.push([seg[0], at(a)]);
  if (hi > b) out.push([at(b), seg[1]]);
  return out;
}

/**
 * 墙端封口：ground truth 里每条墙的**自由端**都有一条封口线（两片面线端点之间连一条），
 * 接头处（L/T/十字）则已经被 miter 接上、不需要封口。
 *
 * 判据只看几何：这一侧的两条面线端点都还在原地、且**没有别的面线挨着**（>tol），
 * 就是一个自由端 → 补一条封口线。这样既不碰接头，也不会在洞口处乱加线。
 *
 * @param {{points:[number,number][], wall:number, side:string}[]} faces 已接头/已修剪的面线
 * @param {{start:number[], end:number[], thickness:number}[]} walls 与 `face.wall` 对齐
 * @returns {{faces:any[], caps:number}}
 */
export function closeWallEnds(faces, walls, opts = {}) {
  if (!Array.isArray(faces) || faces.length === 0) return { faces, caps: 0 };
  if (!Array.isArray(walls) || walls.length === 0) return { faces, caps: 0 };
  const tol = Number.isFinite(opts.tol) ? opts.tol : 1;
  const segs = faces.map((f) => f.points);
  const grid = new Map();
  const cell = 2000;
  const kk = (cx, cy) => `${cx},${cy}`;
  for (let i = 0; i < segs.length; i++) {
    const [a, b] = segs[i];
    const x0 = Math.floor(Math.min(a[0], b[0]) / cell);
    const x1 = Math.floor(Math.max(a[0], b[0]) / cell);
    const y0 = Math.floor(Math.min(a[1], b[1]) / cell);
    const y1 = Math.floor(Math.max(a[1], b[1]) / cell);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const k = kk(x, y);
        const list = grid.get(k);
        if (list) list.push(i);
        else grid.set(k, [i]);
      }
    }
  }
  const around = (p) => grid.get(kk(Math.floor(p[0] / cell), Math.floor(p[1] / cell))) || [];
  /** 这个端点是"悬空"的吗（别的面线都不在 tol 以内） */
  const isolated = (p, self) => {
    for (const j of around(p)) {
      if (j === self) continue;
      if (distPointSeg(p, segs[j]) <= tol) return false;
    }
    return true;
  };

  const caps = [];
  for (let w = 0; w < walls.length; w++) {
    const def = walls[w];
    if (!def || !isPt(def.start) || !isPt(def.end)) continue;
    const th = Math.abs(Number(def.thickness) || 0);
    if (!(th > 0)) continue;
    const u = vunit(vsub(def.end, def.start));
    if (!u) continue;
    const side = { left: [], right: [] };
    for (let i = 0; i < faces.length; i++) {
      const f = faces[i];
      if (f.wall !== w) continue;
      if (f.side === "left" || f.side === "right") side[f.side].push({ i, points: f.points });
    }
    if (!side.left.length || !side.right.length) continue;
    const pick = (list, end) => {
      let best = null;
      for (const item of list) {
        for (const p of item.points) {
          const t = vdot(vsub(p, end), u);
          const off = Math.abs(vcross(u, vsub(p, end)));
          if (Math.abs(t) > th * 1.1 + 30 || off > th * 1.1 + 30) continue;
          if (!best || Math.abs(t) < Math.abs(best.t)) best = { t, p, i: item.i };
        }
      }
      return best;
    };
    for (const end of [def.start, def.end]) {
      const a = pick(side.left, end);
      const b = pick(side.right, end);
      if (!a || !b) continue;
      const gap = vlen(vsub(a.p, b.p));
      if (!(gap > 1e-6) || gap > th * 1.6 + 40) continue;
      if (!isolated(a.p, a.i) || !isolated(b.p, b.i)) continue;
      caps.push({ wall: w, points: [[a.p[0], a.p[1]], [b.p[0], b.p[1]]], cap: true });
    }
  }
  return { faces: caps.length ? [...faces, ...caps] : faces, caps: caps.length };
}

/** 一条 LWPOLYLINE（组码形状与 dxf-web.js 的注入实体一致）。 */
function lwpolyline(handle, layer, points, closed) {
  const rows = [
    "0", "LWPOLYLINE",
    "5", handle,
    "100", "AcDbEntity",
    "8", layer,
    "100", "AcDbPolyline",
    "90", String(points.length),
    "70", closed ? "1" : "0",
  ];
  for (const [x, y] of points) rows.push("10", num(x), "20", num(y));
  return rows.join("\r\n");
}

/**
 * 一条 TEXT（组码形状与 block-text.js / buildLayoutSpace 的 emitText 一致：
 * `100 AcDbText / 10 20 / 40 字高 / 1 内容`）。调用方负责把多行拆成多条。
 * `rotationDeg`（可选）写 50 组码：注入到被旋转 INSERT 的块时，世界坐标的文字要跟着转。
 */
function textEntity(handle, layer, x, y, height, line, rotationDeg = 0) {
  const text = String(line ?? "").trim();
  if (!text) return null;
  const rows = [
    "0", "TEXT",
    "5", handle,
    "100", "AcDbEntity",
    "8", layer,
    "100", "AcDbText",
    "10", num(x),
    "20", num(y),
    "40", num(height),
  ];
  if (Number.isFinite(rotationDeg) && Math.abs(rotationDeg) > 1e-6) {
    rows.push("50", num(rotationDeg));
  }
  rows.push("1", text);
  return rows.join("\r\n");
}

/** 多行文字的行距系数（× 字高）。天正的多行标注（如"无障碍电梯\r\n兼担架梯"）按原样分行。 */
const TEXT_LINE_SPACING = 1.25;

/**
 * 一条 MTEXT，附着点固定 **5 = 正中**（v62，天正标注数值文字专用）。
 * 组码取法与时序（施工005 的 T3 真值标注块内同款 MTEXT：
 * `10/20 插入点 · 40 字高 · 71 5 · 72 1 · 1 内容 · 50 旋转(度)`），
 * 因为 `text_point.p` 是**文字中点**：用 TEXT 的基线起点语义会让整串数字沿尺寸线
 * 方向偏出半个字长（6 位 × 446.25 字高 ≈ 0.9 m）。
 * `layer` 由调用方归一；不写 62 = BYLAYER，与同层的尺寸线/界线一致。
 */
function mtextEntity(handle, layer, x, y, height, line, rotationDeg = 0) {
  const text = String(line ?? "").trim();
  if (!text) return null;
  const rows = [
    "0", "MTEXT",
    "5", handle,
    "100", "AcDbEntity",
    "8", layer,
    "100", "AcDbMText",
    "10", num(x),
    "20", num(y),
    "30", "0",
    "40", num(height),
    "71", "5", // 附着点：正中
    "72", "1", // 书写方向：由左向右
    "1", text,
  ];
  if (Number.isFinite(rotationDeg) && Math.abs(rotationDeg) > 1e-6) {
    rows.push("50", num(rotationDeg));
  }
  return rows.join("\r\n");
}

/* ──────────────── 天正标注（TDbDimension2）：几何 + 数值文字（v62） ────────────────
 * v62 起载荷给全了：`decode.dimension = { p1, angle, style, segments[], dim_line_offset… }`，
 * `segments[i] = { value, p1, p2, text?, dim_line?, ext_lines?, ticks?, text_point? }`。
 * 一条段落的几何（实测施工005：16 条 decoded 链 / 388 段，字段 388/388 齐全）：
 *   · `dim_line { a, b }`            —— 尺寸线（2 点）；
 *   · `ext_lines [{a,b}, {a,b}]`     —— 两条界线；
 *   · `ticks [{ p, rotation, size, a, b }]` —— 两个 45° 斜标记，`a`/`b` 已是斜线两端
 *     （T3 真值里是 `_ArchTick` 块 INSERT，rotation 90°/270°、scale=arrow_size）；
 *   · `text_point { p, rotation }`   —— 数值文字的**中点**与旋转（弧度）。
 *     T3 真值交叉验证：`p` 与 DIMENSION 组码 11/21（"middle point of dimension text"）
 *     以及标注块内 MTEXT 的 10/20 + 71=5（正中附着）**逐位相等**，所以注入时用
 *     MTEXT 正中附着把这个点当**中点**用；把它当 TEXT 基线起点会整串数字沿尺寸线
 *     偏出半个字长（本图 6 位数字 ≈ 0.9 m）。
 * 一句话：**位置/角度一律取自载荷**，不再按统计值猜；只有当 `text_point` 缺失
 * （老 dump / 字段被裁掉）时才回退 v59 的 `DIM_TEXT_OFFSET_K` 估算（见 dimensionTextItems）。
 * 字高仍取 `style.text_height`（施工005 实测 446.25，与 T3 真值 388/388 相等）。
 */
export const DIM_TEXT_OFFSET_K = 1.2;

/**
 * 一条段落的数值文字：`format(value, dec) + postfix`。
 * `dec` 是小数位（施工005 实测 0 → "112060"）；缺省/异常时退回 CLI 已格式化好的
 * `segment.text`，两者都没有才退回原始 value 字符串（绝不写空 TEXT）。
 * @param {{value?:number, text?:string}} segment
 * @param {{dec?:number, postfix?:string}} [style]
 * @returns {string}
 */
export function formatDimensionLabel(segment, style) {
  const dec = Number(style?.dec);
  const postfix = typeof style?.postfix === "string" ? style.postfix : "";
  let body = "";
  const value = Number(segment?.value);
  if (Number.isFinite(dec) && dec >= 0 && dec <= 8 && Number.isFinite(value)) {
    body = value.toFixed(Math.trunc(dec));
  }
  if (!body) {
    const t = typeof segment?.text === "string" ? segment.text.trim() : "";
    if (t) body = t;
    else if (Number.isFinite(value)) body = String(value);
  }
  return body ? body + postfix : "";
}

/**
 * 一条标注链的**线段几何**（2 点折线），坐标与 `p1` 同一坐标系（dump 原坐标）。
 * 一律原样取载荷字段，不做任何角度/长度推算：
 *   · `segments[].dim_line`    → 1 条（a→b，尺寸线）；
 *   · `segments[].ext_lines[]` → 各 1 条（施工005 实测 2 条界线）；
 *   · `segments[].ticks[].a/b` → 各 1 条（2 个 45° 斜标记；`a`/`b` 已是斜线两端，
 *     真值里是 `_ArchTick` 块的旋转 INSERT，自己按 `rotation`/`size` 再算一遍会偏）。
 * 缺字段 / 非有限坐标 / 零长度 → 该条跳过（宁可少画一条，不画假几何）。
 * @param {any} dim `decode.dimension`
 * @returns {Array<[[number,number],[number,number]]>}
 */
export function dimensionGeomSegments(dim) {
  const segments = Array.isArray(dim?.segments) ? dim.segments : [];
  const out = [];
  const push = (a, b) => {
    if (!isPt(a) || !isPt(b)) return;
    if (!(Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-9)) return;
    out.push([[a[0], a[1]], [b[0], b[1]]]);
  };
  for (const seg of segments) {
    if (!seg || typeof seg !== "object") continue;
    const dl = seg.dim_line;
    if (dl && typeof dl === "object") push(dl.a, dl.b);
    if (Array.isArray(seg.ext_lines)) {
      for (const el of seg.ext_lines) if (el && typeof el === "object") push(el.a, el.b);
    }
    if (Array.isArray(seg.ticks)) {
      for (const tk of seg.ticks) if (tk && typeof tk === "object") push(tk.a, tk.b);
    }
  }
  return out;
}

/**
 * 弧度 → DXF 组码 50 的度，归一化到 (−90°, 90°]：与载荷角度平行、但不倒着写
 * （`text_point.rotation` 实测只有 0 与 π/2，归一化对它们是恒等变换）。
 * @param {number} rad
 * @returns {number}
 */
function radToDimDegrees(rad) {
  let deg = (rad * 180) / Math.PI;
  deg = ((deg % 180) + 180) % 180; // [0,180)
  if (deg > 90) deg -= 180;
  return deg;
}

/**
 * 把一条 decoded 标注链变成待写文字的清单（每个 `segments[]` 一条）。
 * 与 `text` 分支共用同一套坐标约定：坐标是 dump 原坐标（与墙/文字相同），
 * 落到哪个块由 `ownerAnchor` + 归属判定决定，写块时再乘 INSERT 矩阵。
 *
 * 位置优先级（v62）：
 *   ① `seg.text_point.p` + `seg.text_point.rotation` ——**载荷原文**，`p` 是文字中点，
 *      因此该项带 `centered: true`，落盘用 MTEXT 正中附着（见 `mtextEntity`）；
 *   ② 回退：`text_point` 缺失（老 dump）→ v59 的估算
 *      位置 = 段中点沿 `p1→p2` 左法向偏 `DIM_TEXT_OFFSET_K × 字高`，
 *      旋转 = 段方向（退化时用 `dim.angle`），落盘用 TEXT 基线起点。
 *      实测该估算在施工005 上偏 3,627–5,073 mm（中位 3,873），只作兜底。
 * @param {any} dim `decode.dimension`
 * @param {string} layer 已归一的图层名（颜色跟随图层，不写 62 组码 = BYLAYER）
 * @param {number|null} fallbackHeight 样式没给字高时的兜底
 * @returns {Array<{kind:"dimension",layer:string,x:number,y:number,height:number,
 *                  line:string,rotation:number,centered:boolean}>}
 */
export function dimensionTextItems(dim, layer, fallbackHeight) {
  const segments = Array.isArray(dim?.segments) ? dim.segments : [];
  const style = dim?.style && typeof dim.style === "object" ? dim.style : {};
  const styleH = Number(style.text_height);
  const height =
    Number.isFinite(styleH) && styleH > 0
      ? styleH
      : Number.isFinite(fallbackHeight) && fallbackHeight > 0
        ? fallbackHeight
        : 2.5;
  const dimAngle = Number(dim?.angle);
  const items = [];
  for (const seg of segments) {
    const line = formatDimensionLabel(seg, style);
    if (!line) continue; // 没有数值也没有文字：不写空 TEXT
    /* ① 载荷给了 text_point（中点 + 弧度）：直接用，一个数都不算 */
    const tp = seg?.text_point;
    const anchor = isPt(tp?.p) ? tp.p : null;
    const tpRot = Number(tp?.rotation);
    if (anchor && Number.isFinite(tpRot)) {
      items.push({
        kind: "dimension",
        layer,
        x: anchor[0],
        y: anchor[1],
        height,
        line,
        rotation: radToDimDegrees(tpRot),
        centered: true,
      });
      continue;
    }
    /* ② 回退（`text_point` 缺失 / 坏值）：v59 的估算位置，别让老 dump 少画字 */
    const a = seg?.p1;
    const b = seg?.p2;
    if (!isPt(a) || !isPt(b)) continue;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    let deg =
      len > 1e-9
        ? (Math.atan2(dy, dx) * 180) / Math.PI
        : Number.isFinite(dimAngle)
          ? (dimAngle * 180) / Math.PI
          : 0;
    deg = ((deg % 180) + 180) % 180; // [0,180)
    if (deg > 90) deg -= 180; // (−90,90]：与尺寸线平行，正着读
    const nx = len > 1e-9 ? -dy / len : 0;
    const ny = len > 1e-9 ? dx / len : 1;
    const off = DIM_TEXT_OFFSET_K * height;
    items.push({
      kind: "dimension",
      layer,
      x: (a[0] + b[0]) / 2 + nx * off,
      y: (a[1] + b[1]) / 2 + ny * off,
      height,
      line,
      rotation: deg,
      centered: false,
    });
  }
  return items;
}

/**
 * HEADER 里的 `$TEXTSIZE`（图纸默认字高）。
 * ⚠️ 这只是**兜底**：CLI 的 `decode.text` 目前不带字高（只有 position/content/charset），
 * 等 crates 侧补上 `text.height` 后会自动优先用它（见 `textHeightOf`）。
 */
export function headerTextSize(dxfText) {
  if (typeof dxfText !== "string") return null;
  const i = dxfText.indexOf("$TEXTSIZE");
  if (i < 0) return null;
  const m = /(?:^|\n)[ \t]*40[ \t]*\r?\n([^\r\n]+)/.exec(dxfText.slice(i, i + 400));
  if (!m) return null;
  const v = Number(m[1].trim());
  return Number.isFinite(v) && v > 0 && v < 1e6 ? v : null;
}

/** 环境变量 `UDO_TEXT_HEIGHT`：显式的字高兜底（给"图纸没有 $TEXTSIZE"或调试用）。 */
function envTextHeight() {
  const v = Number(process.env.UDO_TEXT_HEIGHT);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/* ───────────────────────── 注入范围自检（v65） ─────────────────────────
 * v63 的 BZZ 事故：注入几何被塞进块 `BZZ`，而 BZZ 又被 建筑2F/GFFDSDSSS
 * 引用，世界坐标整体偏了约 1.3 km，但没有任何构建期告警。
 * 自检范围 = 服务端 contentBox（meta.json）∪ 图纸 HEADER 的 EXTMIN/EXTMAX，
 * 再放宽 25% 对角线。只检查**几何**（洞口/墙/标注），不拿文字位置当越界证据
 * （房间名/标注本来就可能落在图框外）。HEADER 明显损坏（跨度 > 1e8）时忽略。
 */
function headerExtents(dxfText) {
  if (typeof dxfText !== "string") return null;
  const read = (key) => {
    const i = dxfText.indexOf(key);
    if (i < 0) return null;
    const slice = dxfText.slice(i, i + 800);
    const mx = /(?:^|\n)[ \t]*10[ \t]*\r?\n([^\r\n]+)/.exec(slice);
    const my = /(?:^|\n)[ \t]*20[ \t]*\r?\n([^\r\n]+)/.exec(slice);
    if (!mx || !my) return null;
    const x = Number(mx[1].trim());
    const y = Number(my[1].trim());
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
  };
  const min = read("$EXTMIN");
  const max = read("$EXTMAX");
  if (!min || !max) return null;
  const width = max[0] - min[0];
  const height = max[1] - min[1];
  if (!(width > 0) || !(height > 0) || width > 1e8 || height > 1e8) return null;
  return { minX: min[0], minY: min[1], maxX: max[0], maxY: max[1], width, height };
}

function normBox(b) {
  if (!b || typeof b !== "object") return null;
  const minX = Number(b.minX);
  const minY = Number(b.minY);
  const maxX = Number(b.maxX);
  const maxY = Number(b.maxY);
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null;
  if (!(maxX > minX) || !(maxY > minY)) return null;
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function unionBox(a, b) {
  if (!a) return b;
  if (!b) return a;
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
    width: Math.max(a.maxX, b.maxX) - Math.min(a.minX, b.minX),
    height: Math.max(a.maxY, b.maxY) - Math.min(a.minY, b.minY),
  };
}

function expandBox(b, margin) {
  return {
    minX: b.minX - margin,
    minY: b.minY - margin,
    maxX: b.maxX + margin,
    maxY: b.maxY + margin,
    width: b.width + margin * 2,
    height: b.height + margin * 2,
  };
}

function boxInside(outer, inner) {
  return (
    !!outer &&
    !!inner &&
    inner.minX >= outer.minX &&
    inner.minY >= outer.minY &&
    inner.maxX <= outer.maxX &&
    inner.maxY <= outer.maxY
  );
}

/** 自检范围；没有可用 contentBox/HEADER → null（不做越界裁剪，只保持旧行为）。 */
function guardBoxOf(dxfText, contentBox) {
  const cbox = normBox(contentBox);
  const hbox = headerExtents(dxfText);
  const union = unionBox(cbox, hbox);
  if (!union) return null;
  const diag = Math.hypot(union.width, union.height);
  return expandBox(union, Math.max(1000, diag * 0.25));
}

/**
 * 单条文字的字高，优先级：
 *   ① JSON 里的 `text.height/size/text_height`（crates 侧补字段后自动生效）
 *   ② 环境变量 `UDO_TEXT_HEIGHT`
 *   ③ 图纸 HEADER 的 `$TEXTSIZE`
 *   ④ 2.5（DXF 规范的默认字高，最后的保底）
 */
export function textHeightOf(text, fallback) {
  for (const k of ["height", "size", "text_height", "h"]) {
    const v = Number(text?.[k]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  const env = envTextHeight();
  if (env) return env;
  const fb = Number(fallback);
  return Number.isFinite(fb) && fb > 0 ? fb : 2.5;
}

/** ENTITIES 段末尾（`0/ENDSEC` 之前）的插入位置；找不到返回 -1。 */
function entitiesEnd(text) {
  const at = sectionIndex(text, "ENTITIES");
  if (at < 0) return -1;
  const m = /(\r?\n)[ \t]*0\r?\nENDSEC/.exec(text.slice(at));
  if (!m) return -1;
  // ⚠️ 只能插在 `0` 之前：插在 `0` 与 `ENDSEC` 之间会让 ENDSEC 变成实体类型名
  return at + m.index + m[1].length;
}

/* ───────────────────────────── 类名归一 ─────────────────────────────
 * 同一个 C++ 类在 DWG 里可能注册成不同 DXF 名：
 *   · `TDbWall`    → `TCH_WALL` 或 `AEC_WALL`  （机柜图是 AEC_KERNAL 注册的 `AEC_*`）
 *   · `TDbOpening` → `TCH_OPENING` / `AEC_OPENING`
 *   · `TDbText`    → `TCH_TEXT` / `AEC_TEXT`；`TDbMText` → `TCH_MTEXT` / `AEC_MTEXT`
 *   · `TDbDimension2` → `TCH_DIMENSION2`（v59；只有数值文字，没有几何）
 * 所以**不能**按前缀单边判断：`startsWith("TCH_")` 会让整张机柜图一个对象都不注入。
 * 这里统一先归一成 `opening|wall|text|dimension`，所有分派只认归一结果。
 * C++ 类名（dump 的 `cpp_class`）优先：有它时 `AEC_WALL` 才是天正的墙；
 * 没有 C++ 名（老 dump / DXF 侧）才看注册名，且只认 `TCH_*` / `AEC_*` 两种拼写。
 */
const UDO_KIND_BY_NAME = {
  OPENING: "opening",
  WALL: "wall",
  TEXT: "text",
  MTEXT: "text",
  DIMENSION: "dimension",
  DIMENSION2: "dimension",
};

/**
 * 把一个 dump 实体归一成 `opening` / `wall` / `text` / `dimension`；不是天正对象 → null。
 * @param {{class?:string, cpp_class?:string, decode?:{kind?:string}}} entity
 * @returns {"opening"|"wall"|"text"|"dimension"|null}
 */
export function udoKindOf(entity) {
  if (!entity || typeof entity !== "object") return null;

  const cpp = typeof entity.cpp_class === "string" ? entity.cpp_class.trim() : "";
  if (cpp) {
    if (cpp === "TDbOpening") return "opening";
    if (cpp === "TDbWall") return "wall";
    if (cpp === "TDbText" || cpp === "TDbMText") return "text";
    if (cpp === "TDbDimension" || cpp === "TDbDimension2") return "dimension";
    // 有 C++ 名但不是 TDb*（如 Autodesk 的 AecDbWall）→ 不是天正对象
    return null;
  }

  const cls = typeof entity.class === "string" ? entity.class.trim() : "";
  const m = /^(?:TCH|AEC)_([A-Za-z0-9]+)$/.exec(cls);
  if (m) {
    const kind = UDO_KIND_BY_NAME[m[1].toUpperCase()];
    if (kind) return kind;
  }

  /* 兜底：类名不认识但 CLI 已按 C++ 类给出 kind（新 dump 一定有；老 dump 通常没有） */
  const dk = entity.decode?.kind;
  return dk === "opening" || dk === "wall" || dk === "text" || dk === "dimension" ? dk : null;
}

/* ───────────────────────── 图块归属（v57） ─────────────────────────
 * 天正的墙/洞口/文字常常画在**块定义**里：机柜图 `6d12aa7dfb1f.dwg` 的 305 墙 + 113 洞口
 * + 250 文字**全部**属于块 `0727-3FF ditu`，模型空间直属于 0 条（同一张图由浩辰导出的
 * `887ab95e7a53.dxf` 里它们写作 `IAEC_WALL` / `IAEC_OPENING` / `IAEC_TEXT`，也全在那一个
 * `BLOCK … ENDBLK` 之间）。
 *
 * 旧实现把它们一律追加到 ENTITIES（模型空间顶层），于是被画在**块内坐标**（x ≈ 1.0e6）上，
 * 而用户看的楼层平面在世界坐标 x ≈ 0 —— 平面上自然"没墙线、没房间名"：实测 v56 产物
 * `WALL` 层注入的 120 条 LWPOLYLINE bbox = `x 1,003,586..1,071,186 / y −258,387..−184,287`，
 * 与楼层平面的 `DOOR_FIRE`（`x −2,835..160,757`）相隔约 100 万单位。
 *
 * 这里解析 DXF 的 BLOCKS / INSERT，把每条自定义对象送回宿主块定义：
 *   · **几何**（LWPOLYLINE）写进该块的 `BLOCK … ENDBLK` 之间，由已有的 INSERT 矩阵负责
 *     平移/旋转/缩放；一个块被多次 INSERT 也只写一份几何（副本由 INSERT 负责）。
 *   · **文字**写顶层（世界坐标按 INSERT 链换算）。原因：dxf-web 会整段删掉 BLOCKS 段里的
 *     TEXT/MTEXT（引擎渲染块内文字时不用块变换，留着只会在原点堆垃圾），而展平逻辑读的是
 *     **原始文件**，看不到我们新注入的块内文字。
 * 找不到 owner（没有块 / 点落在任何块外 / 两个块同样可疑）时**回退顶层注入并记 warning**，
 * 绝不因为归属判断失败而少画或打不开图。
 *
 * v64：归属不再"整张图挑一个 dominant owner"。CLI 现在逐条给出 `decode.origin.block`，
 * server 按**记录**回注（几何先减 `origin.point` 回到块内坐标）。老 dump 没有 origin 字段，
 * 仍走上面 v57 的启发式 —— 两条路径的产物必须互不影响（见 `originShift` / `localizeEntity`）。 */

const SPACE_BLOCK_RE = /^\*(?:model|paper)_space$/i;
const OWNER_CHAIN_MAX = 8;
/** 一组自定义对象要有这么大比例落在同一个块里，才认它是这个块的（否则回退顶层）。 */
const OWNER_DOMINANCE = 0.9;

/** 2D 仿射矩阵 `[a,b,c,d,e,f]`：`(x,y) → (a·x + b·y + c, d·x + e·y + f)`。 */
function matMultiply(m, n) {
  return [
    m[0] * n[0] + m[1] * n[3],
    m[0] * n[1] + m[1] * n[4],
    m[0] * n[2] + m[1] * n[5] + m[2],
    m[3] * n[0] + m[4] * n[3],
    m[3] * n[1] + m[4] * n[4],
    m[3] * n[2] + m[4] * n[5] + m[5],
  ];
}

function matPoint(m, x, y) {
  return [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]];
}

/** INSERT 的局部矩阵：`p → T(at) · R(rot) · S(sx,sy) · T(-base) · p`。 */
function insertMatrix(ref, base) {
  const sx = Number.isFinite(ref.scale?.[0]) && ref.scale[0] !== 0 ? ref.scale[0] : 1;
  const sy = Number.isFinite(ref.scale?.[1]) && ref.scale[1] !== 0 ? ref.scale[1] : 1;
  const rad = ((Number.isFinite(ref.rot) ? ref.rot : 0) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const bx = Number.isFinite(base?.[0]) ? base[0] : 0;
  const by = Number.isFinite(base?.[1]) ? base[1] : 0;
  const at = ref.at && Number.isFinite(ref.at[0]) ? ref.at[0] : 0;
  const aty = ref.at && Number.isFinite(ref.at[1]) ? ref.at[1] : 0;
  const rotateScale = [cos * sx, -sin * sy, 0, sin * sx, cos * sy, 0];
  const shiftBase = [1, 0, -bx, 0, 1, -by];
  const place = [1, 0, at, 0, 1, aty];
  return matMultiply(place, matMultiply(rotateScale, shiftBase));
}

/** 点是否在 bbox 内（含边界）。 */
function boxHas(box, x, y) {
  return !!box && x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3];
}

function boxArea(box) {
  if (!box) return Infinity;
  const w = box[2] - box[0];
  const h = box[3] - box[1];
  if (!(w >= 0) || !(h >= 0)) return Infinity;
  return w * h;
}

/** DXF 组码值 → 数字（`num()` 是输出用的格式化函数，别拿来做解析）。 */
function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * 字高中位数：天正 dump 不带字高，用图里**已有** TEXT/MTEXT 的字高做兜底。
 * 少于 3 个样本返回 null（样本太少不敢猜，交给 2.5 的规范默认值）。
 */
function medianTextHeight(samples) {
  if (!Array.isArray(samples) || samples.length < 3) return null;
  const a = samples.slice().sort((x, y) => x - y);
  const mid = a[Math.floor(a.length / 2)];
  return Number.isFinite(mid) && mid > 0 ? mid : null;
}

/**
 * 扫一遍 DXF，拿到"块定义坐标系"和 INSERT 引用：
 *   · `blocks`: 块名 → `{ base, bbox, prims, endAt }`（`endAt` = 该块 `0/ENDBLK` 的字符偏移）
 *   · `inserts`: 被引用的块名 → `[{ container, at, scale, rot }]`（`container` 是 `` 表示
 *     模型/图纸空间顶层，否则是宿主块名）
 * 只认 BLOCKS 段：ENTITIES 段里的实体只用来收集 INSERT。
 * @param {string} text
 */
export function describeDxfFrames(text) {
  const blocks = new Map();
  const inserts = new Map();
  /** 图里已有 TEXT/MTEXT 的字高样本（推断天正文字字高用；上限 20000 条） */
  const textHeights = [];
  if (typeof text !== "string" || text.length === 0) return { blocks, inserts, textHeights };

  const pushInsert = (name, ref) => {
    if (!name) return;
    const list = inserts.get(name);
    if (list) list.push(ref);
    else inserts.set(name, [ref]);
  };

  const len = text.length;
  let pos = 0;
  let section = "";
  let wantSection = false;
  let cur = null; // 正在定义的块
  let entType = "";
  let entInsert = null;
  let entAt = null;
  let entScale = [1, 1];
  let entRot = 0;
  let entXs = [];
  let entYs = [];
  let entHeights = [];

  const addPoint = (x, y) => {
    if (!cur || !cur.bbox) return;
    if (x < cur.bbox[0]) cur.bbox[0] = x;
    if (y < cur.bbox[1]) cur.bbox[1] = y;
    if (x > cur.bbox[2]) cur.bbox[2] = x;
    if (y > cur.bbox[3]) cur.bbox[3] = y;
  };

  const flushEntity = () => {
    if (entType === "INSERT" && entInsert) {
      pushInsert(entInsert, {
        container: cur ? cur.name : "",
        at: entAt || [0, 0],
        scale: entScale,
        rot: entRot,
      });
    }
    if (cur && cur.bbox && entType && entType !== "INSERT") {
      const n = Math.min(entXs.length, entYs.length);
      for (let k = 0; k < n; k++) addPoint(entXs[k], entYs[k]);
      if (n > 0) cur.prims++;
    }
    if ((entType === "TEXT" || entType === "MTEXT") && textHeights.length < 20000) {
      for (const h of entHeights) textHeights.push(h);
    }
    entType = "";
    entInsert = null;
    entAt = null;
    entScale = [1, 1];
    entRot = 0;
    entXs = [];
    entYs = [];
    entHeights = [];
  };

  while (pos < len) {
    const startPos = pos;
    let nl = text.indexOf("\n", pos);
    if (nl < 0) break;
    const code = text.slice(pos, nl).trim();
    const vStart = nl + 1;
    let nl2 = text.indexOf("\n", vStart);
    if (nl2 < 0) nl2 = len;
    const value = text.slice(vStart, nl2);
    const v = value.trim();
    pos = nl2 + 1;

    if (code === "0") {
      flushEntity();
      if (v === "SECTION") {
        wantSection = true;
        continue;
      }
      if (v === "ENDSEC") {
        section = "";
        cur = null;
        continue;
      }
      if (v === "EOF") break;
      if (v === "BLOCK") {
        cur = { name: null, base: [0, 0], bbox: [Infinity, Infinity, -Infinity, -Infinity], prims: 0, endAt: -1, header: true };
        continue;
      }
      if (v === "ENDBLK") {
        if (cur && cur.name) {
          cur.endAt = startPos;
          blocks.set(cur.name, {
            base: cur.base,
            bbox: Number.isFinite(cur.bbox[0]) ? cur.bbox : null,
            prims: cur.prims,
            endAt: cur.endAt,
          });
        }
        cur = null;
        continue;
      }
      if (cur) cur.header = false;
      entType = v;
      continue;
    }

    if (wantSection && code === "2") {
      section = v;
      wantSection = false;
      continue;
    }

    /* 块头：`2` 是块名，`10/20` 是基点（块内坐标 → 世界坐标的锚） */
    if (cur && cur.header) {
      if (code === "2") cur.name = v;
      else if (code === "10") cur.base[0] = toNum(v);
      else if (code === "20") cur.base[1] = toNum(v);
      continue;
    }

    if (!entType) continue;

    if (code === "2" && entType === "INSERT") {
      entInsert = v;
      continue;
    }
    if (code === "10" || code === "11" || code === "12") {
      const x = toNum(v);
      if (!Number.isFinite(x)) continue;
      if (code === "10" && entType === "INSERT") entAt = [x, 0];
      entXs.push(x);
      continue;
    }
    if (code === "20" || code === "21" || code === "22") {
      const y = toNum(v);
      if (!Number.isFinite(y)) continue;
      if (code === "20" && entType === "INSERT" && entAt) entAt[1] = y;
      entYs.push(y);
      continue;
    }
    if (code === "41" && entType === "INSERT") {
      entScale[0] = toNum(v);
      continue;
    }
    if (code === "42" && entType === "INSERT") {
      entScale[1] = toNum(v);
      continue;
    }
    if (code === "50" && entType === "INSERT") {
      entRot = toNum(v);
      continue;
    }
    if (code === "40" && (entType === "TEXT" || entType === "MTEXT")) {
      const h = toNum(v);
      if (Number.isFinite(h) && h > 0 && h < 1e6) entHeights.push(h);
      continue;
    }
  }
  flushEntity();
  return { blocks, inserts, textHeights };
}

/** 取一个块的**世界矩阵链**（块可能被嵌在别的块里）。找不到引用 → 空数组。 */
function blockWorldMatrices(name, frames, depth = 0, trail = new Set()) {
  if (depth > OWNER_CHAIN_MAX || trail.has(name)) return [];
  const refs = frames.inserts.get(name);
  const block = frames.blocks.get(name);
  if (!refs || !refs.length || !block) return [];
  const nextTrail = new Set(trail);
  nextTrail.add(name);
  const out = [];
  for (const ref of refs) {
    const local = insertMatrix(ref, block.base);
    if (!ref.container) {
      out.push(local);
      continue;
    }
    const parents = blockWorldMatrices(ref.container, frames, depth + 1, nextTrail);
    for (const m of parents) out.push(matMultiply(m, local));
  }
  return out;
}

/** 把块内 bbox 按该块所有 INSERT 链变换到世界坐标并取并集；顶层原样返回。 */
function worldBoxOfGroup(name, box, frames) {
  if (!box) return null;
  if (!name) return box;
  const mats = blockWorldMatrices(name, frames);
  if (!mats.length) return box;
  let out = null;
  for (const m of mats) {
    for (const [x, y] of [
      [box.minX, box.minY],
      [box.maxX, box.minY],
      [box.maxX, box.maxY],
      [box.minX, box.maxY],
    ]) {
      const p = matPoint(m, x, y);
      if (!out) out = { minX: p[0], minY: p[1], maxX: p[0], maxY: p[1] };
      else {
        if (p[0] < out.minX) out.minX = p[0];
        if (p[1] < out.minY) out.minY = p[1];
        if (p[0] > out.maxX) out.maxX = p[0];
        if (p[1] > out.maxY) out.maxY = p[1];
      }
    }
  }
  return out;
}

/** 一条自定义对象的"锚点"（墙中心点 / 洞口插入点 / 文字插入点）；没有可用坐标 → null。 */
function ownerAnchor(d) {
  const dec = d.e?.decode;
  if (!dec) return null;
  if (d.kind === "wall" && dec.wall) {
    const a = dec.wall.start;
    const b = dec.wall.end;
    if (isPt(a) && isPt(b)) return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (isPt(a)) return [a[0], a[1]];
  }
  if (d.kind === "opening" && dec.opening) {
    const o = dec.opening;
    const x = Number(o.x);
    const y = Number(o.y);
    if (Number.isFinite(x) && Number.isFinite(y)) return [x, y];
  }
  if (d.kind === "text" && dec.text) {
    const p = dec.text.position;
    if (isPt(p)) return [p[0], p[1]];
  }
  if (d.kind === "dimension" && dec.dimension) {
    /* 标注链只有一个定义点 `p1`（段首）；用它判断宿主块，和文字的插入点等价。 */
    const dim = dec.dimension;
    const s0 = Array.isArray(dim.segments) ? dim.segments[0] : null;
    for (const p of [dim.p1, s0?.p1]) {
      if (isPt(p)) return [p[0], p[1]];
    }
  }
  return null;
}

/* ───────────────────────── 记录级容器（v64） ─────────────────────────
 * v63 起 CLI 把块内天正对象**翻译到世界坐标**，并在 `decode.origin` 里交代这一步：
 *   {"point":[…], "block":"建筑2F", "source":"block_insert", "applied":true}
 * `block` 是**直接宿主块**（存这条记录的那个 BLOCK_RECORD），`point` 是块内 → 世界的
 * 平移量（块基点与 INSERT 插入点的差，沿 owner 链累加；只接受纯平移）。
 *
 * v63 的 server 仍拿世界坐标去和块 bbox 做包含判定、挑"唯一的 dominant owner"，
 * 于是把**已经变换过**的几何又塞进某个块定义，再被那个块的 INSERT 变换一次 —— 双重
 * 变换。实测 `智能化图纸`：墙全被塞进 `BLOCK:BZZ`，而 BZZ 自己又嵌在 `建筑2F` /
 * `GFFDSDSSS` 里，整张平面被搬到约 1.3 km 外，和原图完全对不上。
 *
 * v64 的规则：**按记录**决定容器，四类（墙/洞口/文字/尺寸）同一套。
 *   · `origin.applied && origin.block` 且该块定义可写 → 写进这个块定义，坐标先减
 *     `origin.point` 变回块内坐标；副本交给该块已有的 INSERT（插两次就画两份）。
 *   · 没有 origin（`施工005`/机柜图纸的旧 dump、模型空间里的对象）→ 顶层世界坐标。
 * 位置解不出来的记录 CLI 已经降级成 `candidate`，这里连看都看不到，绝不猜。
 */

/** 一条记录"回注哪个块定义"的意图；没有 → null。 */
export function originShift(dec) {
  const o = dec && typeof dec === "object" ? dec.origin : null;
  if (!o || o.applied !== true) return null;
  if (typeof o.block !== "string" || !o.block) return null;
  const p = o.point;
  if (!Array.isArray(p) || p.length < 2) return null;
  if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null;
  return { block: o.block, dx: p[0], dy: p[1], dz: Number.isFinite(p[2]) ? p[2] : 0 };
}

/** 世界坐标点 → 块内坐标：只减 `origin.point`。 */
function shiftPoint(p, s) {
  if (!isPt(p)) return p;
  const out = [p[0] - s.dx, p[1] - s.dy];
  if (Array.isArray(p) && p.length > 2) out.push(Number.isFinite(p[2]) ? p[2] - s.dz : p[2]);
  return out;
}

/**
 * 把一条已翻译到世界坐标的记录改写成**块内坐标**（v64）。
 *
 * 只做平移，几何形状一个数字都不动：`origin.point` 是 CLI 加上去的那个量，减回来
 * 就是载荷原文。返回浅拷贝，调用方的 dump 不会被改（同一份 dump 可能被多次注入）。
 * @param {any} e dump 里的一条实体
 * @param {{block:string,dx:number,dy:number,dz:number}} s `originShift()` 的结果
 */
export function localizeEntity(e, s) {
  const d = e?.decode;
  if (!d || typeof d !== "object" || !s) return e;
  const decode = { ...d };
  if (d.wall && typeof d.wall === "object") {
    decode.wall = {
      ...d.wall,
      start: shiftPoint(d.wall.start, s),
      end: shiftPoint(d.wall.end, s),
    };
  }
  if (d.opening && typeof d.opening === "object") {
    const o = d.opening;
    const faces = Array.isArray(o.wall_face_segments)
      ? o.wall_face_segments.map((f) => (Array.isArray(f) ? f.map((p) => shiftPoint(p, s)) : f))
      : o.wall_face_segments;
    decode.opening = {
      ...o,
      x: Number.isFinite(o.x) ? o.x - s.dx : o.x,
      y: Number.isFinite(o.y) ? o.y - s.dy : o.y,
      z: Number.isFinite(o.z) ? o.z - s.dz : o.z,
      wall_face_segments: faces,
    };
  }
  if (d.text && typeof d.text === "object") {
    decode.text = { ...d.text, position: shiftPoint(d.text.position, s) };
  }
  if (d.dimension && typeof d.dimension === "object") {
    const dim = d.dimension;
    const segs = Array.isArray(dim.segments)
      ? dim.segments.map((seg) => {
          if (!seg || typeof seg !== "object") return seg;
          const out = { ...seg, p1: shiftPoint(seg.p1, s), p2: shiftPoint(seg.p2, s) };
          if (seg.dim_line && typeof seg.dim_line === "object") {
            out.dim_line = {
              ...seg.dim_line,
              a: shiftPoint(seg.dim_line.a, s),
              b: shiftPoint(seg.dim_line.b, s),
            };
          }
          if (Array.isArray(seg.ext_lines)) {
            out.ext_lines = seg.ext_lines.map((l) =>
              l && typeof l === "object"
                ? { ...l, a: shiftPoint(l.a, s), b: shiftPoint(l.b, s) }
                : l
            );
          }
          if (Array.isArray(seg.ticks)) {
            out.ticks = seg.ticks.map((t) =>
              t && typeof t === "object"
                ? { ...t, p: shiftPoint(t.p, s), a: shiftPoint(t.a, s), b: shiftPoint(t.b, s) }
                : t
            );
          }
          if (seg.text_point && typeof seg.text_point === "object") {
            out.text_point = { ...seg.text_point, p: shiftPoint(seg.text_point.p, s) };
          }
          return out;
        })
      : dim.segments;
    decode.dimension = {
      ...dim,
      p1: shiftPoint(dim.p1, s),
      text_anchor: shiftPoint(dim.text_anchor, s),
      segments: segs,
    };
  }
  return { ...e, decode };
}

/**
 * 把 dump 里的天正几何注入 DXF 文本。四类**只认 `status === "decoded"`**：
 *   · `TDbOpening`（`TCH_OPENING` / `AEC_OPENING`）→ 闭合 LWPOLYLINE（洞口矩形）
 *                                 + 门扇线 + 90° 开启弧；
 *   · `TDbWall`（`TCH_WALL` / `AEC_WALL`）→ 每条墙 1–n 条 LWPOLYLINE（左右墙面线，
 *                                 先做接头 miter、再在洞口处切开，所以一条墙可能变成几条）；
 *   · `TDbText`/`TDbMText`（`TCH_TEXT`/`TCH_MTEXT`/`AEC_TEXT`/`AEC_MTEXT`）→ 1 条 TEXT
 *                                 （内容已由 CLI 从 GBK 解好，此处直接写 UTF-8）；
 *   · `TDbDimension2`（`TCH_DIMENSION2`，v62）→ 每条 `segments[]`：
 *       尺寸线 ×1 + 界线 ×2 + 斜标记 ×2 条 2 点 LWPOLYLINE（端点取自 `dim_line` /
 *       `ext_lines` / `ticks.a|b`）+ 1 条数值文字（MTEXT 正中附着于 `text_point.p`）。
 *       v59 只补数值文字、位置靠统计值估算；v62 起几何与位置全部取自载荷。
 * 类名归一由 `udoKindOf` 负责（`TCH_*` 与 `AEC_*` 走同一分支）。
 * 其余状态（`candidate` 未验证编码由 CLI 安全门降级、`not_found`、`not_attempted`）与
 * 几何退化的实体一律算 `skipped`，绝不注入 —— 宁可少画，也不能画出假几何。
 *
 * @param {string} dxfText
 * @param {any} dump `udo-cli dump` 的 `data`（也接受整份 `{ok,data}` 文档）
 * @param {{ startHandle?: number, layers?: Set<string>, hiddenLayers?: Set<string>|Map<string,any>,
 *           maxEntities?: number, textHeight?: number, blockInjection?: boolean }} [opts]
 *   `blockInjection === false` 关掉 v57 的"回宿主块定义"行为（退回全部顶层注入，调试用）。
 * @returns {{ text: string, injected: number, primitives: number, skipped: number,
 *             decoded: number, detected: number, missingLayer: number, hidden: number,
 *             byKind: {opening:number, wall:number, text:number, dimension:number},
 *             primitivesByKind: {opening:number, wall:number, text:number, dimension:number},
 *             textHeight: number|null, used: number,
 *             owners: Record<string,number>, warnings: string[] }}
 *   `owners`：注入目标 → 对象数（`` = 模型空间顶层，其余是块名）。
 *   `warnings`：归属判断的降级说明（找不到 owner / 不唯一 / 块没被 INSERT /
 *   `origin_block_missing:<块名>`：dump 说这条属于某个块，但本 DXF 里没有那个块定义）。
 *
 * v64：`decode.origin.applied && decode.origin.block` 的记录按**记录**回注它自己的宿主
 * 块定义（坐标先减 `origin.point`），几何四类同一规则；这样同一块被 INSERT 两次就画两份。
 * 没有 origin 的 dump（`施工005` / 机柜图纸）走 v57 的既有路径，产物逐字节不变。
 */
export function injectUdoGeometry(dxfText, dump, opts = {}) {
  const empty = {
    text: dxfText,
    injected: 0,
    primitives: 0,
    skipped: 0,
    decoded: 0,
    detected: 0,
    missingLayer: 0,
    hidden: 0,
    byKind: { opening: 0, wall: 0, text: 0, dimension: 0 },
    primitivesByKind: { opening: 0, wall: 0, text: 0, dimension: 0 },
    textHeight: null,
    used: 0,
    owners: {},
    warnings: [],
  };
  if (typeof dxfText !== "string" || dxfText.length === 0) return empty;

  const data = dump && dump.data ? dump.data : dump;
  const entities = Array.isArray(data?.entities) ? data.entities : null;
  if (!entities || entities.length === 0) return empty;

  const listed = entities.length;
  /* `detected` 用 CLI 的 stats.udo_entities（= 图里 TCH 实体总数，含没有解码器的类）；
   * 没有统计时退回列表长度。它同时也是 `skipped` 的分母。 */
  const statsDetected = Number(data?.stats?.udo_entities);
  const detected =
    Number.isFinite(statsDetected) && statsDetected > listed ? statsDetected : listed;

  const maxEntities = Number.isFinite(opts.maxEntities)
    ? Math.max(0, opts.maxEntities)
    : UDO_MAX_ENTITIES;
  const layers = opts.layers instanceof Set ? opts.layers : null;
  const hidden =
    opts.hiddenLayers instanceof Set || opts.hiddenLayers instanceof Map
      ? opts.hiddenLayers
      : null;
  const isHidden = (name) => !!hidden && typeof hidden.has === "function" && hidden.has(name);
  const startHandle = Number.isFinite(opts.startHandle) ? opts.startHandle : 0x100;

  /* ── 解析块结构（v57）──────────────────────────────────────────────────
   * 顺带收集整张图已有 TEXT/MTEXT 的字高样本：天正文字（TDbText）的 dump 里**没有**
   * 字高字段，机柜图又没有 `$TEXTSIZE`，旧兜底 2.5 在 1:1 大样里等于看不见（实测注入的
   * 250 条房间名 40=2.5，而图上同类文字 40=300）。用图里已有字高的中位数兜底。
   */
  let framesAll = { blocks: new Map(), inserts: new Map(), textHeights: [] };
  try {
    framesAll = describeDxfFrames(dxfText);
  } catch {
    framesAll = { blocks: new Map(), inserts: new Map(), textHeights: [] };
  }
  const frames =
    opts.blockInjection === false
      ? { blocks: new Map(), inserts: new Map() }
      : framesAll;
  /* v65 注入范围自检：contentBox ∪ HEADER 范围，放宽 25%。只在两者至少一个可用时生效。 */
  const guardBox = guardBoxOf(dxfText, opts.contentBox);

  /* 字高兜底：TEXT 需要 40 组码。优先 JSON 自带的字高，其次 $TEXTSIZE / 环境变量，
   * 再其次是图里已有文字的**中位数字高**。
   * ⚠️ `$TEXTSIZE` 常常是模板默认值、图上没人用（机柜图 = 2.5，而图上文字中位数 262.5）。
   * 判据：中位数比 $TEXTSIZE 大 10 倍以上 → 认为 $TEXTSIZE 没人用，改用中位数；
   * 否则保持 $TEXTSIZE（施工005：$TEXTSIZE 150 vs 中位数 446，只是字号不统一，仍按 150）。 */
  const ownHeight = Number.isFinite(opts.textHeight) && opts.textHeight > 0 ? opts.textHeight : null;
  const headerH = headerTextSize(dxfText);
  const medianH = medianTextHeight(framesAll.textHeights);
  const fallbackHeight =
    ownHeight ??
    (headerH && medianH && medianH >= headerH * 10 ? medianH : (headerH ?? medianH));
  let usedFallbackHeight = false;

  const byKind = { opening: 0, wall: 0, text: 0, dimension: 0 };
  const primitivesByKind = { opening: 0, wall: 0, text: 0, dimension: 0 };
  const topRows = []; // 顶层 ENTITIES（模型空间）
  const blockRows = new Map(); // 块名 → 写进该块定义的几何行
  const owners = {}; // 注入目标 → 对象数（"" = 顶层）
  const warnings = [];
  let decoded = 0;
  let injected = 0;
  let missingLayer = 0;
  let skippedHidden = 0;
  let primitives = 0;
  let handle = startHandle;

  const nextHandle = () => (handle++).toString(16).toUpperCase();

  /** 图层归一：原图层优先，层表没有就退回 0 层并计数 */
  const layerOf = (raw) => {
    const name = typeof raw === "string" && raw ? raw : "0";
    if (layers && !layers.has(name)) {
      missingLayer++;
      return "0";
    }
    return name;
  };

  /* ── 预扫描 ────────────────────────────────────────────────────────────
   * 墙面线要先做**同一宿主块内**的全局修正（L/T/十字接头 miter + 洞口处切开），门的
   * 铰链端/开启侧也需要同一视图里的墙体上下文，所以不能"边走边算"。
   * 发射顺序仍按 dump 里的实体顺序，句柄分配顺序与原来一致。
   */
  const decodedList = [];
  /* v64：按记录决定容器。有 `origin.applied && origin.block` 且该块定义可写 → 这条
   * 记录改成块内坐标、回注那个块定义；否则原样（世界坐标 / 旧 dump）走下面的老路径。 */
  const originAware = data?.diagnostics?.origins?.in_scope === true;
  for (const e of entities) {
    const kind = udoKindOf(e);
    if (!kind) continue;
    if (e?.decode?.status !== "decoded") continue;
    const rawLayer = typeof e.layer === "string" && e.layer ? e.layer : "0";
    const shift = originShift(e.decode);
    if (shift) {
      const block = frames.blocks.get(shift.block);
      if (block && block.endAt >= 0) {
        decodedList.push({
          e: localizeEntity(e, shift),
          kind,
          rawLayer,
          target: shift.block,
        });
        continue;
      }
      // 块定义在这个 DXF 里找不到（只可能出现在转档丢块的文件里）。坐标是世界坐标，
      // 宁可画在顶层（位置对、只画一份）也不写错块 —— 绝不回退到"猜归属"。
      warnings.push(`origin_block_missing:${shift.block}`);
    }
    decodedList.push({ e, kind, rawLayer });
  }
  decoded = decodedList.length;

  /* ── 归属（v57，仅旧 dump 路径）─────────────────────────────────────────
   * 没有 origin 字段的 dump（`施工005` / 机柜图纸 / 模型空间对象）仍按老规则：每条对象
   * 的**锚点**（墙中心点 / 洞口插入点 / 文字插入点）落在哪个块定义的坐标范围内就属于哪个
   * 块，要求"同一个块吃掉 ≥90% 的锚点"，否则回退顶层 + warning。
   * 多个块都包含时取**面积最小**的那个（父块必然也包含子块的内容，最内层才是 owner）。
   *
   * v64：CLI 已经**逐条**给出宿主的文件（`diagnostics.origins.in_scope === true`）不再走
   * 这条启发式 —— 它会把世界坐标误判成块内坐标（`智能化图纸` 的墙因此全被塞进 BZZ）。
   * 那种文件里没有 origin 的记录只有两种：本来就在模型空间（世界坐标，顶层正确），
   * 或位置解不出来（CLI 已降级成 candidate，根本进不了 `decodedList`）。
   */
  const anchors = decodedList.map((d) => (originAware ? null : ownerAnchor(d)));
  let ownerBlock = null;
  if (!originAware) {
    const candidates = [];
    for (const [name, b] of frames.blocks) {
      if (!b || !b.bbox || !(b.prims > 0)) continue;
      if (SPACE_BLOCK_RE.test(name)) continue; // 模型/图纸空间不是"块定义"
      candidates.push([name, b]);
    }

    if (candidates.length && decodedList.length) {
      const counts = new Map();
      for (const p of anchors) {
        if (!p) continue;
        for (const [name, b] of candidates) {
          if (boxHas(b.bbox, p[0], p[1])) counts.set(name, (counts.get(name) || 0) + 1);
        }
      }
      let best = null;
      for (const [name, b] of candidates) {
        const n = counts.get(name) || 0;
        if (!n) continue;
        if (!best || n > best.n || (n === best.n && boxArea(b.bbox) < boxArea(best.box))) {
          best = { name, n, box: b.bbox };
        }
      }
      const anchored = anchors.reduce((s, p) => (p ? s + 1 : s), 0);
      if (best && anchored > 0) {
        const need = Math.max(1, Math.ceil(anchored * OWNER_DOMINANCE));
        if (best.n >= need) ownerBlock = best.name;
        else warnings.push(`owner_not_dominant:${best.name}:${best.n}/${anchored}`);
      } else if (anchored > 0) {
        warnings.push("owner_not_found");
      }
    }
  }

  const buckets = new Map(); // "" = 顶层；其余 = 块名
  for (let i = 0; i < decodedList.length; i++) {
    const d = decodedList[i];
    let target = d.target || "";
    if (!target && !originAware) {
      const p = anchors[i];
      target =
        ownerBlock && p && boxHas(frames.blocks.get(ownerBlock).bbox, p[0], p[1]) ? ownerBlock : "";
    }
    const list = buckets.get(target);
    if (list) list.push(d);
    else buckets.set(target, [d]);
  }

  /**
   * 把一组同宿主的自定义对象实体变成 DXF 行。
   * @returns {{geom: string[], textItems: object[], byKind: object, primsByKind: object,
   *            prims: number, injected: number, hidden: number}}
   */
  const emitGroup = (list) => {
    const geom = [];
    const textItems = [];
    const localByKind = { opening: 0, wall: 0, text: 0, dimension: 0 };
    const localPrimsByKind = { opening: 0, wall: 0, text: 0, dimension: 0 };
    let localPrims = 0;
    let localInjected = 0;
    let localHidden = 0;
    /* 注入几何（不含文字）的范围，供 contentBox 自检；文字位置本来就可能在图框外。 */
    let geomBox = null;
    const addGeomBox = (pts) => {
      for (const p of pts || []) {
        if (!isPt(p)) continue;
        if (!geomBox) geomBox = { minX: p[0], minY: p[1], maxX: p[0], maxY: p[1] };
        else {
          if (p[0] < geomBox.minX) geomBox.minX = p[0];
          if (p[1] < geomBox.minY) geomBox.minY = p[1];
          if (p[0] > geomBox.maxX) geomBox.maxX = p[0];
          if (p[1] > geomBox.maxY) geomBox.maxY = p[1];
        }
      }
    };

    /* 几何上下文只看**可见图层**：关掉的图层既不画，也不该参与接头推断 */
    const geoList = [];
    for (const d of list) {
      if (isHidden(d.rawLayer)) localHidden++;
      else geoList.push(d);
    }

    const frames2 = [];
    for (const d of geoList) {
      if (d.kind !== "opening") continue;
      const fr = openingFrame(d.e.decode.opening);
      if (fr) frames2.push(fr);
    }

    const wallDefs = [];
    const faceItems = [];
    const wallLines = [];
    for (const d of geoList) {
      if (d.kind !== "wall") continue;
      const w = d.e.decode.wall;
      if (!w) continue;
      if (isPt(w.start) && isPt(w.end)) wallLines.push({ start: w.start, end: w.end });
      const faces = wallFaces(w);
      if (!faces) continue;
      const thickness =
        Number(w.thickness) > 0
          ? Number(w.thickness)
          : (Number(w.left_offset) || 0) + (Number(w.right_offset) || 0);
      const idx = wallDefs.length;
      wallDefs.push({ entity: d.e, start: w.start, end: w.end, thickness });
      for (const side of ["left", "right"]) {
        const pts = faces[side];
        if (!pts) continue;
        faceItems.push({ wall: idx, side, thickness, points: pts.map((p) => [p[0], p[1]]) });
      }
    }

    const linked = connectWallFaces(faceItems);
    const linkedFaces = trimWallFacesAtOpenings(linked.faces, frames2);
    const ended = closeWallEnds(linkedFaces, wallDefs);
    const facesByWall = new Map();
    for (const f of ended.faces) {
      const list2 = facesByWall.get(f.wall);
      if (list2) list2.push(f.points);
      else facesByWall.set(f.wall, [f.points]);
    }
    const wallIndex = new Map();
    for (let i = 0; i < wallDefs.length; i++) wallIndex.set(wallDefs[i].entity, i);
    /* 门符号的上下文：墙中心线（铰链端）+ **原始**墙面线（开启侧，见 swingSide） */
    const doorCtx = { walls: wallLines, faces: faceItems.map((f) => f.points) };

    for (const d of list) {
      const e = d.e;
      const kind = d.kind;
      if (injected >= maxEntities) continue;
      if (isHidden(d.rawLayer)) continue; // 已在 geoList 里计数

      if (kind === "text") {
        const t = e.decode.text;
        const pos = t?.position;
        if (!isPt(pos)) continue;
        const hasOwnHeight = ["height", "size", "text_height", "h"].some((k) => {
          const v = Number(t?.[k]);
          return Number.isFinite(v) && v > 0;
        });
        if (!hasOwnHeight) usedFallbackHeight = true;
        const height = textHeightOf(t, fallbackHeight);
        const layer = layerOf(d.rawLayer);
        /* 多行按原样分行、自上而下堆叠（行距 1.25 字高）；空行丢弃 */
        const lines = String(t?.content ?? "")
          .replace(/\r\n?/g, "\n")
          .split("\n")
          .filter((s) => s.trim());
        const items = [];
        for (let i = 0; i < lines.length; i++) {
          items.push({
            kind: "text",
            layer,
            x: pos[0],
            y: pos[1] - i * height * TEXT_LINE_SPACING,
            height,
            line: lines[i],
          });
        }
        if (!items.length) continue; // 空内容：不写空 TEXT
        for (const it of items) textItems.push(it);
        localByKind.text++;
        /* 文字图元数在**落盘时**统计：注入块里的文字要按 INSERT 实例复制，一份变多份 */
        localInjected++;
        injected++;
        continue;
      }

      /* v62：天正标注（TDbDimension2）现在给全了几何 —— 尺寸线 ×1 + 界线 ×2 + 斜标记 ×2，
       * 全部是 2 点 LWPOLYLINE，端点一律取自载荷（见 dimensionGeomSegments）；
       * 数值文字每个 segments[] 一条（text_point 优先，见 dimensionTextItems）。
       * candidate 在预扫描就被 `status !== "decoded"` 挡掉了，这里不会出现。 */
      if (kind === "dimension") {
        const dim = e.decode.dimension;
        const styleH = Number(dim?.style?.text_height);
        if (!(styleH > 0)) usedFallbackHeight = true; // 样式没给字高 → 用了兜底
        const layer = layerOf(d.rawLayer);
        const segPts = dimensionGeomSegments(dim);
        const segRows = segPts.map((pts) => lwpolyline(nextHandle(), layer, pts, false));
        const items = dimensionTextItems(dim, layer, fallbackHeight);
        if (!segRows.length && !items.length) continue; // 几何与文字都没有：什么都不写
        for (const pts of segPts) addGeomBox(pts);
        for (const r of segRows) geom.push(r);
        for (const it of items) textItems.push(it);
        localByKind.dimension++;
        localPrimsByKind.dimension += segRows.length;
        localPrims += segRows.length;
        localInjected++;
        injected++;
        continue;
      }

      const out = [];
      if (kind === "opening") {
        const opening = e.decode.opening;
        const quad = openingQuad(opening);
        if (!quad || quadArea(quad) < 1e-9) continue; // decoded 但几何退化
        const layer = layerOf(d.rawLayer);
        out.push(lwpolyline(nextHandle(), layer, quad, true));
        addGeomBox(quad);
        /* 门/窗语义（v65）：窗只保留洞口断面，不画门扇/弧；门按 T3 门型画
         * 双扇（两扇 0.4875w + 两段 90° 弧）/ 单扇 / 推拉（无弧）。 */
        const meta = classifyOpening(opening, d.rawLayer);
        if (meta.kind === "door") {
          const group = doorSymbols(opening, doorCtx, { rawLayer: d.rawLayer });
          if (group) {
            for (const leaf of group.leaves) {
              out.push(lwpolyline(nextHandle(), layer, leaf, false));
              addGeomBox(leaf);
            }
            for (const arc of group.arcs) {
              const arcPts = arcPolyline(arc);
              if (arcPts && arcPts.length >= 2) {
                out.push(lwpolyline(nextHandle(), layer, arcPts, false));
                addGeomBox(arcPts);
              }
            }
          }
        }
      } else if (kind === "wall") {
        const idx = wallIndex.get(e);
        const pieces = idx === undefined ? null : facesByWall.get(idx);
        if (!pieces || !pieces.length) continue;
        const layer = layerOf(d.rawLayer);
        for (const pts of pieces) {
          out.push(lwpolyline(nextHandle(), layer, pts, false));
          addGeomBox(pts);
        }
      }

      if (!out.length) continue;
      for (const r of out) geom.push(r);
      localByKind[kind]++;
      localPrimsByKind[kind] += out.length;
      localPrims += out.length;
      localInjected++;
      injected++;
    }

    return {
      geom,
      textItems,
      byKind: localByKind,
      primsByKind: localPrimsByKind,
      prims: localPrims,
      injected: localInjected,
      hidden: localHidden,
      bbox: geomBox,
    };
  };

  /** 文字落到顶层；返回实际写出的 TEXT/MTEXT 条数（块实例复制后可能多于自定义对象数）。 */
  const pushText = (target, items) => {
    let n = 0;
    for (const it of items) {
      const rot = Number.isFinite(it.rotation) ? it.rotation : 0;
      /* 载荷给了 text_point（centered）→ MTEXT 正中附着；回退项仍是 TEXT 基线起点 */
      const row = it.centered
        ? mtextEntity(nextHandle(), it.layer, it.x, it.y, it.height, it.line, rot)
        : textEntity(nextHandle(), it.layer, it.x, it.y, it.height, it.line, rot);
      if (row) {
        target.push(row);
        n++;
      }
    }
    return n;
  };

  /* 文字图元按 `kind` 分开计数：v59 起顶层/块内同时可能有 TEXT（天正文字）和
   * TEXT（标注数值），两者在 `primitivesByKind` 里必须分账。 */
  const textCountsOf = (items) => {
    let text = 0;
    let dimension = 0;
    for (const it of items) {
      if (it.kind === "dimension") dimension++;
      else text++;
    }
    return { text, dimension };
  };

  /* 顶层先发（句柄顺序与原实现一致），再按块名排序，保证产物可复现 */
  const groupOrder = [""].concat(
    [...buckets.keys()].filter((k) => k !== "").sort()
  );
  for (const name of groupOrder) {
    const list = buckets.get(name);
    if (!list || !list.length) continue;
    const res = emitGroup(list);
    skippedHidden += res.hidden;
    if (!res.injected) continue;

    /* v65 自检：**写进块定义**的注入几何（世界坐标）必须落在 contentBox/HEADER 范围内。
     * 越界整批丢弃并记 warning —— 只为兜住 v63 那种“整张平面被搬到 1.3 km 外”。
     * 顶层世界坐标不裁剪：没有 origin 的旧 dump（施工005）本来就可能把块内坐标
     * 直接当世界坐标落在 contentBox 外，那是既有行为，不能借自检之名删洞口。 */
    if (guardBox && res.bbox && name) {
      const worldBox = worldBoxOfGroup(name, res.bbox, frames);
      if (worldBox && !boxInside(guardBox, worldBox)) {
        warnings.push(`out_of_content_box:${name || "ENTITIES"}`);
        continue;
      }
    }

    owners[name] = (owners[name] || 0) + res.injected;
    byKind.opening += res.byKind.opening;
    byKind.wall += res.byKind.wall;
    byKind.text += res.byKind.text;
    byKind.dimension += res.byKind.dimension;
    primitivesByKind.opening += res.primsByKind.opening;
    primitivesByKind.wall += res.primsByKind.wall;
    primitivesByKind.text += res.primsByKind.text;
    primitivesByKind.dimension += res.primsByKind.dimension;
    primitives += res.prims;

    if (!name) {
      for (const r of res.geom) topRows.push(r);
      const n = pushText(topRows, res.textItems);
      const c = textCountsOf(res.textItems);
      primitivesByKind.text += c.text;
      primitivesByKind.dimension += c.dimension;
      primitives += n;
      continue;
    }

    /* 几何进块定义：一个块只写一份，副本交给已有的 INSERT */
    const rows = blockRows.get(name) || [];
    for (const r of res.geom) rows.push(r);
    blockRows.set(name, rows);

    /* 文字必须进顶层（BLOCKS 段的 TEXT 会被 dxf-web 整段删掉，且展平读的是原始文件），
     * 于是按该块的 INSERT 链把坐标换算成世界坐标，每个实例一份。 */
    const mats = blockWorldMatrices(name, frames);
    if (!mats.length) {
      warnings.push(`owner_not_inserted:${name}`);
      const n = pushText(topRows, res.textItems);
      const c = textCountsOf(res.textItems);
      primitivesByKind.text += c.text;
      primitivesByKind.dimension += c.dimension;
      primitives += n;
      continue;
    }
    for (const m of mats) {
      const scale = Math.sqrt(Math.abs(m[0] * m[4] - m[1] * m[3])) || 1;
      const rot = (Math.atan2(m[3], m[0]) * 180) / Math.PI;
      for (const it of res.textItems) {
        const [wx, wy] = matPoint(m, it.x, it.y);
        /* 标注文字自带与尺寸线平行的旋转，块 INSERT 再叠一层 */
        const textRot = rot + (Number.isFinite(it.rotation) ? it.rotation : 0);
        /* 同 pushText：载荷锚点用 MTEXT 正中附着，回退项用 TEXT */
        const row = it.centered
          ? mtextEntity(nextHandle(), it.layer, wx, wy, it.height * scale, it.line, textRot)
          : textEntity(nextHandle(), it.layer, wx, wy, it.height * scale, it.line, textRot);
        if (row) {
          topRows.push(row);
          if (it.kind === "dimension") primitivesByKind.dimension++;
          else primitivesByKind.text++;
          primitives++;
        }
      }
    }
  }

  const textHeight = usedFallbackHeight
    ? (Number.isFinite(fallbackHeight) && fallbackHeight > 0 ? fallbackHeight : 2.5)
    : null;

  if (!topRows.length && !blockRows.size) {
    return {
      ...empty,
      decoded,
      detected,
      skipped: detected - injected,
      missingLayer,
      hidden: skippedHidden,
      byKind,
      primitivesByKind,
      textHeight,
      owners,
      warnings,
    };
  }

  const edits = [];
  const mergeEdit = (at, rows) => {
    if (at < 0 || !rows.length) return;
    const hit = edits.find((e) => e.at === at);
    if (hit) hit.rows = hit.rows.concat(rows);
    else edits.push({ at, rows: rows.slice() });
  };
  const topEnd = topRows.length ? entitiesEnd(dxfText) : -1;
  if (topRows.length && topEnd < 0) {
    // 没有 ENTITIES 段（不是合法 DXF）：原样返回
    return {
      ...empty,
      decoded,
      detected,
      skipped: detected,
      missingLayer,
      hidden: skippedHidden,
      byKind: { opening: 0, wall: 0, text: 0, dimension: 0 },
      primitivesByKind: { opening: 0, wall: 0, text: 0, dimension: 0 },
      textHeight,
      owners: {},
      warnings,
    };
  }
  mergeEdit(topEnd, topRows);
  for (const [name, rows] of blockRows) {
    const block = frames.blocks.get(name);
    if (!block || !(block.endAt >= 0) || !rows.length) {
      // 块定义定位失败：几何不能丢，整体退回顶层
      warnings.push(`owner_no_endblk:${name}`);
      mergeEdit(topEnd >= 0 ? topEnd : entitiesEnd(dxfText), rows);
      continue;
    }
    mergeEdit(block.endAt, rows);
  }

  const eol = dxfText.includes("\r\n") ? "\r\n" : "\n";
  /* 从后往前插，前面的偏移量才不会失效 */
  edits.sort((a, b) => b.at - a.at);
  let text = dxfText;
  for (const e of edits) {
    text = text.slice(0, e.at) + e.rows.join(eol) + eol + text.slice(e.at);
  }

  return {
    text,
    injected,
    skipped: detected - injected,
    decoded,
    detected,
    primitives,
    missingLayer,
    used: injected,
    hidden: skippedHidden,
    byKind,
    primitivesByKind,
    textHeight,
    owners,
    warnings,
  };
}

/* ───────────────────────────── 开图时挂载 ───────────────────────────── */

/**
 * 把 DWG 原生自定义对象解析结果并进开图结果（`meta.json` 的 `udo` 字段），
 * 并把 dump 落盘到 `outDir/udo-dump.json` 供 `buildWebDxf` 直接读取。
 *
 * 条件：DWG + 开关打开 + 字节预筛命中 + CLI 成功；任何一条不满足 →
 * **原样返回**传进来的 udo（同一个对象引用，不新增字段），
 * 保证没有自定义对象的图行为（含缓存内容）完全不变。
 *
 * @param {{ udo?: any, dwgPath?: string, outDir?: string, timeoutMs?: number }} args
 */
export async function attachUdoCli({ udo, dwgPath, outDir, timeoutMs } = {}) {
  const base =
    udo && typeof udo === "object" ? udo : { level: "none", classes: [], evidence: [] };
  if (!udoEnabled()) return base;
  if (!dwgPath || typeof dwgPath !== "string" || !/\.dwg$/i.test(dwgPath)) return base;
  if (!(await probeUdoDwg(dwgPath, { timeoutMs }))) return base;

  const det = await detectUdo(dwgPath, {
    full: true,
    timeoutMs,
    metaPath: outDir ? path.join(outDir, "meta.json") : null,
  });
  if (!det.detected || !(det.entities > 0)) return base;

  const dump = dumpMemo.get(fileKey(dwgPath));
  const data = dump?.ok ? dump.data : null;
  let dumpFile = null;
  if (data && outDir) {
    const written = persistUdoDump(outDir, data);
    if (written) dumpFile = path.basename(written);
  }
  /* 老 meta 里已有的 dumpFile 不要丢（本次可能只从 meta 读到了计数） */
  if (!dumpFile && typeof base.dumpFile === "string" && base.dumpFile) dumpFile = base.dumpFile;

  return {
    ...base,
    // 有类名/计数 = 确证自定义对象；保留原有的 evidence（制作痕迹）不动
    level: base.level === "none" ? "objects" : base.level,
    classes:
      Array.isArray(base.classes) && base.classes.length ? base.classes : det.classes || [],
    entities: det.entities,
    classCount: det.classCount,
    decoded: det.decoded,
    decodedByKind: det.decodedByKind || { opening: 0, wall: 0, text: 0, dimension: 0 },
    ...(dumpFile ? { dumpFile } : {}),
  };
}
