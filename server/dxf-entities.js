import fs from "node:fs";
import path from "node:path";
import DxfParser from "dxf-parser";
import { decodeDxfName } from "./scanner.js";

/**
 * DXF → 顶层实体列表提取（比对功能专用）。
 *
 * 只做三件事：
 *  1. 用 dxf-parser 解析整份 DXF（模型空间 + 块定义 + 头段）；
 *  2. 归一化成 `{ type, layer, handle, raw }`，供比对内核使用；
 *  3. 按 `路径 + mtime + size` 做内存 LRU 缓存，避免比对同一张图时反复解析。
 *
 * 与 `scanner.js` 的区别：scanner 是流式的、只统计数量；这里必须是完整语法树
 * （几何内核要递归块定义、读 INSERT 变换），所以引入 dxf-parser。
 * 解析是同步 CPU 工作，调用方（/api/compare）应把它当作昂贵操作并做结果缓存。
 */

/** 与上传限制保持一致（index.js 的 multer limits.fileSize = 500MB） */
const MAX_DXF_BYTES = 500 * 1024 * 1024;
/** 最多缓存 8 份图纸 */
const MAX_CACHE_ENTRIES = 8;
/** 估算内存上限：50MB 的 DXF 解析后通常占 150–400MB，按 3 倍估 */
const MAX_CACHE_BYTES = 500 * 1024 * 1024;
const ESTIMATE_FACTOR = 3;

/** 附属实体：AutoCAD 语义里属于宿主实体，不是独立顶层实体 */
const SUBSIDIARY = new Set(["ATTRIB", "SEQEND", "VERTEX"]);

/**
 * dxf-parser 没有对应 handler、会在解析时被**静默丢弃**的实体类型。
 * 契约要求这些类型计入 notCompared（HATCH 例外规则也一样），所以额外做一次
 * ENTITIES 段的组码扫描来统计数量，避免「不支持的实体被当成没出现」。
 * ACAD_TABLE / PROXY 也在其中：dxf-parser 同样没有 handler。
 */
const UNPARSED_TYPES = new Set([
  "HATCH",
  "LEADER",
  "MLINE",
  "MULTILEADER",
  "XLINE",
  "RAY",
  "TOLERANCE",
  "SHAPE",
  "IMAGE",
  "WIPEOUT",
  "REGION",
  "3DSOLID",
  "BODY",
  "SURFACE",
  "MESH",
  "ACAD_TABLE",
  "ACAD_PROXY_ENTITY",
  "PROXY",
]);


/** key → { key, absPath, dxf, entities, header, warnings, estBytes, mtimeMs, size } */
const cache = new Map();
let cacheBytes = 0;

/** 供测试/排障使用：清空提取缓存 */
export function clearEntitiesCache() {
  cache.clear();
  cacheBytes = 0;
}

/**
 * 逐行扫描 DXF 文本，统计 ENTITIES 段里「dxf-parser 会丢弃的类型」数量。
 * 只解析组码/值对，不建数组，50MB 文件也只是多一遍线性扫描。
 * @returns {Record<string, number>}
 */
function scanUnparsedTypes(text, targets) {
  const counts = {};
  const len = text.length;
  let pos = 0;
  let code = null;
  let section = null;
  let pendingSection = false;

  while (pos < len) {
    let nl = text.indexOf("\n", pos);
    if (nl === -1) nl = len;
    const line = text.slice(pos, nl).trim();
    pos = nl + 1;

    if (code === null) {
      const c = parseInt(line, 10);
      code = Number.isNaN(c) ? -1 : c;
      continue;
    }

    const value = line;
    const c = code;
    code = null;

    if (c === 2 && pendingSection) {
      section = value.toUpperCase();
      pendingSection = false;
      continue;
    }
    if (c !== 0) continue;

    const v = value.toUpperCase();
    if (v === "SECTION") {
      pendingSection = true;
      continue;
    }
    if (v === "ENDSEC") {
      section = null;
      pendingSection = false;
      continue;
    }
    if (v === "EOF") break;
    if (section === "ENTITIES" && targets.has(v)) {
      counts[v] = (counts[v] || 0) + 1;
    }
  }
  return counts;
}

function touch(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  // Map 插入序即 LRU 序：命中后挪到末尾
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function evictIfNeeded() {
  while (cache.size > MAX_CACHE_ENTRIES || (cacheBytes > MAX_CACHE_BYTES && cache.size > 1)) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    const victim = cache.get(oldestKey);
    cache.delete(oldestKey);
    cacheBytes -= victim?.estBytes || 0;
  }
}

/**
 * 解析一份 DXF，返回模型空间顶层实体。
 *
 * @param {string} dxfPath 绝对或相对路径
 * @returns {Promise<{
 *   dxf: object,                                  // dxf-parser 原始结果（含 blocks/header）
 *   entities: Array<{type:string, layer:string, handle:string|null, raw:object}>, // layer 已解码 \U+XXXX 供展示，raw 保留原值
 *   header: { version: string|null, insunits: number|null },
 *   warnings: Array<{code:string, reason?:string, count?:number}>,
 *   skippedTypes: Record<string, number>          // 解析器丢弃、需要计入 notCompared 的类型计数
 * }>}
 */
export async function loadEntities(dxfPath) {
  const absPath = path.resolve(String(dxfPath));

  let st;
  try {
    st = await fs.promises.stat(absPath);
  } catch {
    throw new Error(`DXF 文件不存在: ${absPath}`);
  }
  if (!st.isFile()) throw new Error(`DXF 路径不是文件: ${absPath}`);
  if (st.size > MAX_DXF_BYTES) {
    const mb = (st.size / 1024 / 1024).toFixed(1);
    throw new Error(`DXF 文件过大（${mb}MB），超过 ${MAX_DXF_BYTES / 1024 / 1024}MB 上限，无法比对`);
  }

  const key = `${absPath}|${st.mtimeMs}|${st.size}`;
  const hit = touch(key);
  if (hit) return hit;

  let text;
  try {
    text = await fs.promises.readFile(absPath, "utf-8");
  } catch (e) {
    throw new Error(`DXF 读取失败: ${e.message}`);
  }

  let dxf;
  try {
    dxf = new DxfParser().parseSync(text);
  } catch (e) {
    throw new Error(`DXF 解析失败（${path.basename(absPath)}）: ${e.message || e}`);
  }
  if (!dxf || typeof dxf !== "object") {
    throw new Error(`DXF 解析失败（${path.basename(absPath)}）: 解析结果为空`);
  }

  const warnings = [];

  /* 模型空间过滤。
   * dxf-parser 的 `dxf.entities` 来自 ENTITIES 段；实测（data/uploads 的真实图纸）
   * 该数组只含模型空间实体，图纸空间实体位于 `*Paper_Space*` 块定义内部。
   * 但 DXF 规范允许图纸空间实体直接写在 ENTITIES 段（组码 67=1），而 dxf-parser
   * **丢弃了实体级的 67**，只保留 ownerHandle。因此这里用块定义反查：
   * 凡 ownerHandle 指向 paperSpace 块的实体一律剔除。两种情况都覆盖。 */
  const paperOwners = new Set();
  for (const [name, block] of Object.entries(dxf.blocks || {})) {
    if (!block) continue;
    const isPaper = block.paperSpace === true || /^\*paper_space/i.test(name);
    if (isPaper && block.ownerHandle) paperOwners.add(String(block.ownerHandle));
  }

  const entities = [];
  /** 图层名解码缓存：同一图层名只解一次；仅影响展示字段，raw 保持 DXF 原值 */
  const layerNameCache = new Map();
  const displayLayer = (v) => {
    let decoded = layerNameCache.get(v);
    if (decoded === undefined) {
      decoded = decodeDxfName(v);
      layerNameCache.set(v, decoded);
    }
    return decoded;
  };
  let paperSkipped = 0;
  for (const raw of Array.isArray(dxf.entities) ? dxf.entities : []) {
    if (!raw || !raw.type) continue;
    const type = String(raw.type).toUpperCase();
    if (SUBSIDIARY.has(type)) continue;
    if (raw.ownerHandle && paperOwners.has(String(raw.ownerHandle))) {
      paperSkipped++;
      continue;
    }
    entities.push({
      type,
      layer: displayLayer(raw.layer == null ? "0" : String(raw.layer)),
      handle: raw.handle == null ? null : String(raw.handle),
      raw,
    });
  }
  if (paperSkipped > 0) {
    warnings.push({ code: "not-compared", reason: "paperspace", count: paperSkipped });
  }

  // dxf-parser 丢弃的实体类型（HATCH / LEADER / …）：契约要求计入 notCompared
  const skippedTypes = scanUnparsedTypes(text, UNPARSED_TYPES);

  const header = {
    version: dxf.header?.$ACADVER ?? null,
    insunits: Number.isFinite(dxf.header?.$INSUNITS) ? dxf.header.$INSUNITS : null,
  };

  const entry = {
    key,
    absPath,
    dxf,
    entities,
    header,
    warnings,
    skippedTypes,
    mtimeMs: st.mtimeMs,
    size: st.size,
    estBytes: Math.max(st.size * ESTIMATE_FACTOR, 1024 * 1024),
  };

  // 同一 key 不应重复（touch 未命中才走到这里），但并发时可能两个解析同时完成：
  // 后写入的覆盖，字节数先扣掉旧值，避免重复计账。
  const prev = cache.get(key);
  if (prev) cacheBytes -= prev.estBytes || 0;
  cache.set(key, entry);
  cacheBytes += entry.estBytes;
  evictIfNeeded();

  return entry;
}
