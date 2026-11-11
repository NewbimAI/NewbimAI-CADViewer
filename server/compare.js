import {
  entityToPrimitives,
  entityFingerprint,
  entityPropertyKey,
  bboxUnion,
  bboxDistanceSq,
  bboxesIntersect,
} from "../shared/geometry/index.mjs";
import { decodeDxfName } from "./scanner.js";

/**
 * 图纸比对引擎（纯函数，无 I/O）。
 *
 * 输入：两份「模型空间顶层实体」列表（`{type, layer, handle, raw}`，raw 是 dxf-parser 实体）
 * 与冻结契约 docs/compare-contract.md §4 的选项。输出契约 §3 的
 * `changes / changeSets / summary / warnings` 部分。
 *
 * 匹配顺序（契约 §4）：
 *   1. 指纹多重集完全一致            → unchanged
 *   2. handle 相同且类型相同          → modified（几何或属性）
 *   3. 同类型 + 包围盒距离 ≤ tolerance → modified（几何）
 *   其余 → added / removed
 *
 * 不支持的实体（HATCH/ACAD_TABLE/PROXY/DIMENSION 无块/内核解析失败）一律
 * notCompared + warning，绝不默认 unchanged（契约 §4.5）。
 */

/** 永远不参与比对的类型（无法由几何内核还原） */
const ALWAYS_UNSUPPORTED = new Set([
  "ACAD_TABLE",
  "ACAD_PROXY_ENTITY",
  "PROXY",
  "OLE2FRAME",
  "OLEFRAME",
  "IMAGEDEF",
  "WIPEOUT",
  "PDFUNDERLAY",
  "DGNUNDERLAY",
  "DWFUNDERLAY",
]);

/** 附属实体，不是顶层可比对象（防御性过滤，dxf-parser 一般已内联） */
const SUBSIDIARY = new Set(["ATTRIB", "SEQEND", "VERTEX"]);

const KIND_ORDER = { added: 0, removed: 1, modified: 2 };

const DEFAULT_OPTIONS = {
  tolerance: 0.001,
  quantize: 1e-6,
  compareProps: ["color", "layer", "linetype", "lineweight"],
  includeHatch: false,
  maxChanges: 5000,
  maxPointsPerChange: 2000,
  arcStepDeg: undefined,
};

/** 变更排序：kind → 包围盒左上角（minY 再 minX）→ 类型/handle，保证输出稳定 */
function compareChanges(a, b) {
  const k = (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9);
  if (k) return k;
  const ya = a.box?.minY ?? 0;
  const yb = b.box?.minY ?? 0;
  if (ya !== yb) return ya - yb;
  const xa = a.box?.minX ?? 0;
  const xb = b.box?.minX ?? 0;
  if (xa !== xb) return xa - xb;
  if (a.type !== b.type) return String(a.type).localeCompare(String(b.type));
  return String(a.handleBase ?? "").localeCompare(String(b.handleBase ?? ""));
}

/**
 * dxf-parser 用 `vertices:[p1,p2]` 表示 LINE，而几何内核的契约实现使用
 * `start`/`end`。这里做一次无损兼容：补上 start/end 别名（保留 vertices），
 * 两种内核实现都能正确读取。块定义内的实体同样需要，由 normalizeBlockMap 处理。
 */
function withLineAliases(entity) {
  if (!entity || String(entity.type || "").toUpperCase() !== "LINE") return entity;
  if (entity.start && entity.end) return entity;
  const v = entity.vertices;
  if (!Array.isArray(v) || v.length < 2) return entity;
  return { ...entity, start: v[0], end: v[1] };
}

/** 只对块内实体做 LINE 别名归一化，返回尽量复用原对象的分块 Map（不修改入参） */
function normalizeBlockMap(blocks) {
  if (!blocks || typeof blocks !== "object") return {};
  const out = {};
  for (const [name, block] of Object.entries(blocks)) {
    if (!block || !Array.isArray(block.entities)) {
      out[name] = block;
      continue;
    }
    let changed = false;
    const entities = block.entities.map((e) => {
      const next = withLineAliases(e);
      if (next !== e) changed = true;
      return next;
    });
    out[name] = changed ? { ...block, entities } : block;
  }
  return out;
}

/** 属性比较选项：同时给出布尔开关与 compareProps 数组，兼容内核两种读取方式 */
function propertyOptions(compareProps) {
  const list = (Array.isArray(compareProps) ? compareProps : [])
    .map((v) => String(v).toLowerCase())
    .filter(Boolean);
  const set = new Set(list);
  return {
    color: set.has("color"),
    layer: set.has("layer"),
    linetype: set.has("linetype"),
    lineweight: set.has("lineweight"),
    transparency: set.has("transparency") || set.has("alpha"),
    compareProps: list,
  };
}

function safePropertyKey(raw, propOptions) {
  try {
    return entityPropertyKey(raw, propOptions);
  } catch {
    return "";
  }
}

/** 包围盒尺寸比守卫：避免把「同一位置、大小差几个数量级」的不同实体配对 */
function similarSize(a, b, tolerance) {
  const sa = Math.max(a.maxX - a.minX, a.maxY - a.minY);
  const sb = Math.max(b.maxX - b.minX, b.maxY - b.minY);
  if (sa <= tolerance && sb <= tolerance) return true; // 都是点状实体
  if (sa <= 0 || sb <= 0) return Math.max(sa, sb) <= Math.max(tolerance * 4, 1e-9);
  const r = sb / sa;
  return r >= 0.2 && r <= 5;
}

/** INSERT 自身参数（不含块定义内容），用于区分「块变了」与「插入参数变了」 */
function insertOwnKey(raw) {
  const p = raw?.position || {};
  return [
    raw?.name ?? "",
    p.x ?? 0,
    p.y ?? 0,
    p.z ?? 0,
    raw?.xScale ?? 1,
    raw?.yScale ?? 1,
    raw?.zScale ?? 1,
    raw?.rotation ?? 0,
  ].join("|");
}

/** 空间网格格子尺寸：剩余实体包围盒最大边的中位数，兜底 100 图纸单位 */
function chooseCellSize(items, tolerance) {
  const sizes = [];
  for (const it of items) {
    const s = Math.max(it.bbox.maxX - it.bbox.minX, it.bbox.maxY - it.bbox.minY);
    if (s > 0) sizes.push(s);
  }
  if (!sizes.length) return 100;
  sizes.sort((a, b) => a - b);
  const median = sizes[(sizes.length - 1) >> 1];
  return Math.max(median, tolerance * 8, 1e-6);
}

/**
 * 第 3 轮：同类型 + 包围盒邻近的空间匹配。
 * 网格键为实体包围盒「中心」所在格；查询半径按 A 的半对角线 + 剩余 B 的最大半对角线 +
 * tolerance 计算，保证不漏掉任何可能满足 bboxDistanceSq ≤ tolerance² 的候选。
 * 网格扫描范围过大时退化为线性扫描（罕见：极大的单实体），仍然正确。
 */
function spatialMatch(aList, bList, tolerance) {
  const pairs = [];
  if (!aList.length || !bList.length) return pairs;

  const cell = chooseCellSize(bList, tolerance);
  const grid = new Map(); // "cx,cy" → B 下标数组
  // 超大包围盒（长总平面线、图框等）不放进中心网格：否则一个实体就会把查询半径
  // 撑到全图，退化成 O(n²)。它们单独放进 oversized，查询时逐个精确校验。
  const bigThreshold = cell * 8;
  const oversized = [];
  let maxHalfDiagB = 0;
  for (let j = 0; j < bList.length; j++) {
    const bb = bList[j].bbox;
    const half = Math.hypot(bb.maxX - bb.minX, bb.maxY - bb.minY) / 2;
    if (half > bigThreshold) {
      oversized.push(j);
      continue;
    }
    const cx = Math.floor((bb.minX + bb.maxX) / 2 / cell);
    const cy = Math.floor((bb.minY + bb.maxY) / 2 / cell);
    const key = `${cx},${cy}`;
    let arr = grid.get(key);
    if (!arr) grid.set(key, (arr = []));
    arr.push(j);
    if (half > maxHalfDiagB) maxHalfDiagB = half;
  }

  const bUsed = new Uint8Array(bList.length);
  const seenStamp = new Int32Array(bList.length).fill(-1);
  const tolSq = tolerance * tolerance;
  let stamp = 0;

  for (let i = 0; i < aList.length; i++) {
    const a = aList[i];
    const ab = a.bbox;
    const aHalf = Math.hypot(ab.maxX - ab.minX, ab.maxY - ab.minY) / 2;
    const radius = aHalf + maxHalfDiagB + tolerance;
    const rCells = Math.ceil(radius / cell);
    const span = 2 * rCells + 1;

    let best = -1;
    let bestDistSq = Infinity;
    let bestCx = 0;
    let bestCy = 0;

    const consider = (j) => {
      if (seenStamp[j] === stamp) return;
      seenStamp[j] = stamp;
      if (bUsed[j]) return;
      const b = bList[j];
      if (b.type !== a.type) return;
      const d = bboxDistanceSq(ab, b.bbox);
      if (!(d <= tolSq)) return;
      if (!similarSize(ab, b.bbox, tolerance)) return;
      const bbx = (b.bbox.minX + b.bbox.maxX) / 2;
      const bby = (b.bbox.minY + b.bbox.maxY) / 2;
      if (
        d < bestDistSq ||
        (d === bestDistSq &&
          (bbx < bestCx || (bbx === bestCx && bby < bestCy)))
      ) {
        best = j;
        bestDistSq = d;
        bestCx = bbx;
        bestCy = bby;
      }
    };

    if (span * span <= 10000) {
      const cx0 = Math.floor((ab.minX + ab.maxX) / 2 / cell);
      const cy0 = Math.floor((ab.minY + ab.maxY) / 2 / cell);
      for (let dx = -rCells; dx <= rCells; dx++) {
        for (let dy = -rCells; dy <= rCells; dy++) {
          const arr = grid.get(`${cx0 + dx},${cy0 + dy}`);
          if (arr) for (let k = 0; k < arr.length; k++) consider(arr[k]);
        }
      }
      for (let k = 0; k < oversized.length; k++) consider(oversized[k]);
    } else {
      for (let j = 0; j < bList.length; j++) consider(j);
    }

    if (best >= 0) {
      bUsed[best] = 1;
      pairs.push([i, best]);
    }
    stamp++;
  }
  return pairs;
}

/** 估算图元点数（polyline 按顶点数，其余按 1） */
function countPoints(prims) {
  let n = 0;
  for (const p of prims || []) {
    n += p?.kind === "polyline" && Array.isArray(p.points) ? p.points.length : 1;
  }
  return n;
}

/** 把单侧图元裁剪到预算内：保首尾 + 等距抽样，仅用于叠加层可视化 */
function capPrimitives(prims, budget) {
  if (!Array.isArray(prims) || budget <= 0) return [];
  if (countPoints(prims) <= budget) return prims;
  const out = [];
  let left = budget;
  for (const p of prims) {
    if (left <= 0) break;
    if (!p || p.kind !== "polyline" || !Array.isArray(p.points)) {
      out.push(p);
      left -= 1;
      continue;
    }
    const pts = p.points;
    if (pts.length <= left) {
      out.push(p);
      left -= pts.length;
      continue;
    }
    if (left < 2) break;
    const step = (pts.length - 1) / (left - 1);
    const sampled = [];
    for (let k = 0; k < left; k++) sampled.push(pts[Math.round(k * step)]);
    out.push({ ...p, points: sampled });
    left = 0;
  }
  return out;
}

/** 变更集：padding 后相交的变更合并（并查集 + 扫描线） */
function buildChangeSets(changes, tolerance) {
  const n = changes.length;
  if (!n) return { changeSets: [], setIdOf: new Int32Array(0) };

  const boxes = changes.map((c) => ({
    minX: c.bbox[0],
    minY: c.bbox[1],
    maxX: c.bbox[2],
    maxY: c.bbox[3],
  }));
  const pad = Math.max(2 * tolerance, 0);
  const parent = new Int32Array(n);
  const size = new Int32Array(n).fill(1);
  for (let i = 0; i < n; i++) parent[i] = i;

  const find = (x) => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) {
      const next = parent[x];
      parent[x] = r;
      x = next;
    }
    return r;
  };
  const union = (a, b) => {
    let ra = find(a);
    let rb = find(b);
    if (ra === rb) return;
    if (size[ra] < size[rb]) [ra, rb] = [rb, ra];
    parent[rb] = ra;
    size[ra] += size[rb];
  };

  const order = Array.from({ length: n }, (_, i) => i).sort(
    (i, j) => boxes[i].minX - boxes[j].minX || i - j
  );
  const active = [];
  for (const i of order) {
    const bi = boxes[i];
    for (let k = active.length - 1; k >= 0; k--) {
      if (boxes[active[k]].maxX + pad < bi.minX) active.splice(k, 1);
    }
    for (const k of active) {
      if (bboxesIntersect(bi, boxes[k], pad)) union(i, k);
    }
    active.push(i);
  }

  const groups = new Map(); // root → indices[]
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = []));
    g.push(i);
  }

  const groupList = [...groups.values()];
  // 按变更数降序编号；同数时按包围盒左上角，保证稳定
  groupList.sort((g1, g2) => {
    if (g2.length !== g1.length) return g2.length - g1.length;
    const b1 = changes[g1[0]].bbox;
    const b2 = changes[g2[0]].bbox;
    return b1[1] - b2[1] || b1[0] - b2[0];
  });

  const setIdOf = new Int32Array(n).fill(-1);
  const changeSets = groupList.map((indices, id) => {
    let box = null;
    const kinds = { added: 0, removed: 0, modified: 0 };
    for (const idx of indices) {
      setIdOf[idx] = id;
      box = bboxUnion(box, boxes[idx]);
      kinds[changes[idx].kind] = (kinds[changes[idx].kind] || 0) + 1;
    }
    return {
      id,
      bbox: [box.minX, box.minY, box.maxX, box.maxY],
      count: indices.length,
      kinds,
    };
  });

  return { changeSets, setIdOf };
}

/** 块定义指纹（块内实体指纹的多重集）；跳过硬编码布局块 */
function blockFingerprintMap(blocks, ctx, quantize) {
  const out = new Map();
  for (const [name, block] of Object.entries(blocks || {})) {
    if (!block) continue;
    if (block.paperSpace === true || /^\*(?:model|paper)_space/i.test(name)) continue;
    const ents = Array.isArray(block.entities) ? block.entities : [];
    const fps = [];
    for (const e of ents) {
      if (!e || !e.type) continue;
      const t = String(e.type).toUpperCase();
      if (SUBSIDIARY.has(t)) continue;
      try {
        fps.push(entityFingerprint(e, ctx, { quantize }));
      } catch {
        // 内核无法指纹的块内实体：用去掉 handle 的原始字段兜底，仍然逐字节可比
        try {
          const { handle, ownerHandle, ...rest } = e;
          fps.push(`!${t}:${JSON.stringify(rest)}`);
        } catch {
          fps.push(`!${t}`);
        }
      }
    }
    fps.sort();
    out.set(name, fps.join("\u0001"));
  }
  return out;
}

/** 顶层实体里引用了某块的 INSERT 个数 */
function countBlockInstances(entities, name) {
  let n = 0;
  for (const ent of entities) {
    const raw = ent?.raw || ent;
    if (String(raw?.type || "").toUpperCase() !== "INSERT") continue;
    if (String(raw?.name ?? "") === name) n++;
  }
  return n;
}

/**
 * 比对两份图纸的模型空间顶层实体。
 *
 * @param {Array<{type:string, layer:string, handle:string|null, raw:object}>} entitiesA
 * @param {Array<{type:string, layer:string, handle:string|null, raw:object}>} entitiesB
 * @param {object} [options]
 * @param {number} [options.tolerance=0.001]      真实距离阈值（用于第 3 轮配对与变更集 padding）
 * @param {number} [options.quantize=1e-6]        指纹量化精度
 * @param {string[]} [options.compareProps]       参与属性比对的字段
 * @param {boolean} [options.includeHatch=false]  HATCH 是否参与比对
 * @param {number} [options.maxChanges=5000]      返回的变更条数上限（summary 计数不受影响）
 * @param {number} [options.maxPointsPerChange=2000] 单条变更两侧合计的最大点数
 * @param {number} [options.arcStepDeg]           圆弧离散步长（透传内核）
 * @param {object} [options.blocksA]              A 图的 dxf.blocks（块定义变化检测）
 * @param {object} [options.blocksB]              B 图的 dxf.blocks
 * @param {Record<string, number>} [options.skippedTypes] 解析器丢弃、需计入 notCompared 的类型计数
 * @returns {{
 *   changes: Array<object>,
 *   changeSets: Array<object>,
 *   summary: {added:number, removed:number, modified:number, unchanged:number,
 *             notCompared:number, changeSets:number, elapsedMs:number, truncated:boolean},
 *   warnings: Array<object>
 * }}
 */
export function compareEntities(entitiesA, entitiesB, options = {}) {
  const startedAt = Date.now();
  const opts = { ...DEFAULT_OPTIONS, ...(options || {}) };
  const tolerance = Number.isFinite(opts.tolerance) && opts.tolerance >= 0 ? opts.tolerance : DEFAULT_OPTIONS.tolerance;
  const quantize = Number.isFinite(opts.quantize) && opts.quantize > 0 ? opts.quantize : DEFAULT_OPTIONS.quantize;
  const maxChanges = Number.isFinite(opts.maxChanges) && opts.maxChanges >= 0 ? Math.floor(opts.maxChanges) : DEFAULT_OPTIONS.maxChanges;
  const maxPoints = Number.isFinite(opts.maxPointsPerChange) && opts.maxPointsPerChange > 0
    ? Math.floor(opts.maxPointsPerChange)
    : DEFAULT_OPTIONS.maxPointsPerChange;
  const propOptions = propertyOptions(opts.compareProps ?? DEFAULT_OPTIONS.compareProps);

  const ctxA = {
    blocks: normalizeBlockMap(opts.blocksA),
    warnings: new Set(),
    // 内核据此决定是否把 HATCH 边界也算成几何；不传就等于永远跳过。
    includeHatch: opts.includeHatch === true,
    ...(opts.arcStepDeg ? { arcStepDeg: opts.arcStepDeg } : {}),
  };
  const ctxB = {
    blocks: normalizeBlockMap(opts.blocksB),
    warnings: new Set(),
    includeHatch: opts.includeHatch === true,
    ...(opts.arcStepDeg ? { arcStepDeg: opts.arcStepDeg } : {}),
  };

  /** 不支持类型计数：type → count（契约要求累计，不逐实体告警） */
  const unsupported = new Map();
  const bumpUnsupported = (type) => {
    const t = String(type || "UNKNOWN").toUpperCase();
    unsupported.set(t, (unsupported.get(t) || 0) + 1);
  };
  // 上游解析器直接丢弃的实体（HATCH/LEADER/…）由调用方以计数形式传入
  for (const [type, count] of Object.entries(opts.skippedTypes || {})) {
    const n = Number(count);
    if (!Number.isFinite(n) || n <= 0) continue;
    const t = String(type).toUpperCase();
    unsupported.set(t, (unsupported.get(t) || 0) + n);
  }

  /**
   * 图层名解码缓存：DXF 把非 ASCII 图层名存成 `\U+XXXX` 转义（如 `\U+5730\U+5E93`），
   * 直接返回给 API 就是字面乱码。只解码 `layer` 一个字段，且同一图层名只解一次
   * （几千实体时避免反复跑正则）。`raw` 保持原样，不影响指纹/属性比较。
   */
  const layerNameCache = new Map();
  const decodeLayer = (name) => {
    const s = String(name);
    let decoded = layerNameCache.get(s);
    if (decoded === undefined) {
      decoded = decodeDxfName(s);
      layerNameCache.set(s, decoded);
    }
    return decoded;
  };

  /** 预处理：几何 + 包围盒 + 指纹 + 属性键；不支持的实体计入 notCompared */
  const prepare = (list, ctx) => {
    const out = [];
    for (const ent of Array.isArray(list) ? list : []) {
      const raw = withLineAliases(ent?.raw || ent);
      if (!raw) continue;
      const type = String(raw.type || ent?.type || "").toUpperCase();
      if (!type || SUBSIDIARY.has(type)) continue;

      if (ALWAYS_UNSUPPORTED.has(type)) {
        bumpUnsupported(type);
        continue;
      }
      if (type === "HATCH" && !opts.includeHatch) {
        bumpUnsupported(type);
        continue;
      }
      if (type === "DIMENSION") {
        // 只有能解析到标注块（*D 块）的 DIMENSION 才能还原几何
        if (!raw.block || !ctx.blocks?.[raw.block]) {
          bumpUnsupported(type);
          continue;
        }
      }

      let prims;
      let bbox;
      try {
        const res = entityToPrimitives(raw, ctx);
        prims = res?.primitives || [];
        bbox = res?.bbox || null;
      } catch {
        bumpUnsupported(type);
        continue;
      }
      if (!bbox || !prims.length) {
        // 空几何（如无顶点的旧式 POLYLINE）同样不能算「未变化」
        bumpUnsupported(type);
        continue;
      }

      let fp;
      try {
        fp = entityFingerprint(raw, ctx, { quantize });
      } catch {
        bumpUnsupported(type);
        continue;
      }

      out.push({
        raw,
        type,
        layer: decodeLayer(raw.layer == null ? String(ent?.layer ?? "0") : String(raw.layer)),
        handle: raw.handle == null ? (ent?.handle ?? null) : String(raw.handle),
        block: raw.name == null ? null : String(raw.name),
        ownKey: type === "INSERT" ? insertOwnKey(raw) : null,
        prims,
        bbox,
        fp,
        prop: safePropertyKey(raw, propOptions),
      });
    }
    return out;
  };

  const A = prepare(entitiesA, ctxA);
  const B = prepare(entitiesB, ctxB);

  const bUsed = new Uint8Array(B.length);
  const aUsed = new Uint8Array(A.length);
  /** 已匹配的 (a,b) 对；块定义变化时这些对可能要改判为 modified */
  const pairs = [];
  const changes = [];
  let unchanged = 0;

  // ── 第 1 轮：指纹多重集 ─────────────────────────────────────────────
  const bucketByFp = new Map(); // fp → Map(prop → B 下标数组)
  for (let j = 0; j < B.length; j++) {
    const b = B[j];
    let byProp = bucketByFp.get(b.fp);
    if (!byProp) bucketByFp.set(b.fp, (byProp = new Map()));
    let arr = byProp.get(b.prop);
    if (!arr) byProp.set(b.prop, (arr = []));
    arr.push(j);
  }

  // 1a：先做「指纹 + 属性」完全一致的多重集匹配（避免属性不匹配的贪心抢占）
  for (let i = 0; i < A.length; i++) {
    const a = A[i];
    const byProp = bucketByFp.get(a.fp);
    const sameProp = byProp?.get(a.prop);
    if (!sameProp || !sameProp.length) continue;
    const j = sameProp.pop();
    bUsed[j] = 1;
    aUsed[i] = 1;
    unchanged++;
    pairs.push({ ai: i, bi: j, kind: "unchanged" });
  }

  // 1b：指纹一致但属性不同（契约 §4.3）→ 属性类 modified
  for (let i = 0; i < A.length; i++) {
    if (aUsed[i]) continue;
    const a = A[i];
    const byProp = bucketByFp.get(a.fp);
    if (!byProp) continue;
    let j = -1;
    for (const [, arr] of byProp) {
      if (arr.length) {
        j = arr.pop();
        break;
      }
    }
    if (j < 0) continue;
    bUsed[j] = 1;
    aUsed[i] = 1;
    changes.push({ kind: "modified", change: "properties", ai: i, bi: j });
  }

  // ── 第 2 轮：同 handle 同类型 ───────────────────────────────────────
  const byHandle = new Map(); // handle → B 下标数组
  for (let j = 0; j < B.length; j++) {
    if (bUsed[j] || !B[j].handle) continue;
    let arr = byHandle.get(B[j].handle);
    if (!arr) byHandle.set(B[j].handle, (arr = []));
    arr.push(j);
  }
  for (let i = 0; i < A.length; i++) {
    if (aUsed[i] || !A[i].handle) continue;
    const arr = byHandle.get(A[i].handle);
    if (!arr) continue;
    let found = -1;
    for (let k = 0; k < arr.length; k++) {
      const j = arr[k];
      if (!bUsed[j] && B[j].type === A[i].type) {
        found = j;
        arr.splice(k, 1);
        break;
      }
    }
    if (found < 0) continue;
    bUsed[found] = 1;
    aUsed[i] = 1;
    const sameFp = A[i].fp === B[found].fp;
    changes.push({
      kind: "modified",
      change: sameFp ? "properties" : "geometry",
      ai: i,
      bi: found,
    });
  }

  // ── 第 3 轮：同类型 + 空间邻近 ─────────────────────────────────────
  const leftA = [];
  for (let i = 0; i < A.length; i++) if (!aUsed[i]) leftA.push(i);
  const leftB = [];
  for (let j = 0; j < B.length; j++) if (!bUsed[j]) leftB.push(j);

  if (leftA.length && leftB.length) {
    const aList = leftA.map((i) => A[i]);
    const bList = leftB.map((j) => B[j]);
    const matched = spatialMatch(aList, bList, tolerance);
    for (const [localA, localB] of matched) {
      const i = leftA[localA];
      const j = leftB[localB];
      aUsed[i] = 1;
      bUsed[j] = 1;
      changes.push({ kind: "modified", change: "geometry", ai: i, bi: j });
    }
  }

  // ── 剩余 → added / removed ─────────────────────────────────────────
  const removed = [];
  for (let i = 0; i < A.length; i++) {
    if (!aUsed[i]) removed.push({ kind: "removed", ai: i, bi: -1 });
  }
  const added = [];
  for (let j = 0; j < B.length; j++) {
    if (!bUsed[j]) added.push({ kind: "added", ai: -1, bi: j });
  }

  // ── 块定义变化 → 警告 + 引用它的 INSERT 判为 modified ──────────────
  const warnings = [];
  const redefinedBlocks = new Set();
  if (opts.blocksA || opts.blocksB) {
    const blocksA = blockFingerprintMap(ctxA.blocks, ctxA, quantize);
    const blocksB = blockFingerprintMap(ctxB.blocks, ctxB, quantize);
    const names = new Set([...blocksA.keys(), ...blocksB.keys()]);
    for (const name of [...names].sort()) {
      const ha = blocksA.has(name) ? blocksA.get(name) : null;
      const hb = blocksB.has(name) ? blocksB.get(name) : null;
      if (ha === hb) continue;
      // 两侧都是空定义（无实体）→ 对图形没有任何影响，不制造噪音
      if (!ha && !hb) continue;
      redefinedBlocks.add(name);
      const count =
        countBlockInstances(entitiesA || [], name) + countBlockInstances(entitiesB || [], name);
      warnings.push({ code: "block-redefined", name, count });
    }
    if (redefinedBlocks.size) {
      for (const pair of pairs) {
        if (pair.kind !== "unchanged") continue;
        if (A[pair.ai].type !== "INSERT") continue;
        const name = A[pair.ai].block;
        if (name && redefinedBlocks.has(name)) {
          pair.kind = "block-changed";
        }
      }
      // 已经因指纹不同落入 modified/geometry 的 INSERT，如果自身参数完全没变，
      // 变化其实来自块定义内部 → 改标为 change:"block"，避免误报成"实体移动了"。
      for (const c of changes) {
        if (c.kind !== "modified" || c.ai < 0 || c.bi < 0) continue;
        const a = A[c.ai];
        const b = B[c.bi];
        if (a.type !== "INSERT" || a.block !== b.block) continue;
        if (!a.block || !redefinedBlocks.has(a.block)) continue;
        if (a.ownKey !== b.ownKey) continue;
        c.change = "block";
      }
    }
  }

  for (const pair of pairs) {
    if (pair.kind === "unchanged") {
      // 已计入 unchanged
    } else {
      // 块定义的几何变了，但 INSERT 自身参数没变：仍要让用户看到
      unchanged--;
      changes.push({ kind: "modified", change: "block", ai: pair.ai, bi: pair.bi });
    }
  }

  for (const u of removed) changes.push(u);
  for (const a of added) changes.push(a);

  const modified = changes.filter((c) => c.kind === "modified").length;
  const addedCount = added.length;
  const removedCount = removed.length;
  const notCompared = [...unsupported.values()].reduce((s, v) => s + v, 0);

  for (const [type, count] of [...unsupported.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
  )) {
    warnings.push({ code: "unsupported", type, count });
  }

  // ── 输出组装：排序 → 截断 → 图元裁剪 → 变更集 ─────────────────────
  // 排序需要包围盒，先给每条变更算好（同时供输出复用）
  for (const c of changes) {
    const a = c.ai >= 0 ? A[c.ai] : null;
    const b = c.bi >= 0 ? B[c.bi] : null;
    c.box = bboxUnion(a?.bbox || null, b?.bbox || null);
  }
  changes.sort(compareChanges);
  const truncated = changes.length > maxChanges;
  const emitted = truncated ? changes.slice(0, maxChanges) : changes;

  const out = emitted.map((c) => {
    const a = c.ai >= 0 ? A[c.ai] : null;
    const b = c.bi >= 0 ? B[c.bi] : null;
    const box = c.box;
    const both = !!a && !!b;
    const budget = both ? Math.max(1, maxPoints >> 1) : maxPoints;
    return {
      id: 0, // 排序截断后统一编号
      kind: c.kind,
      change: c.change || undefined,
      type: (a || b).type,
      layer: a ? a.layer : b.layer,
      handleBase: a ? a.handle : null,
      handleTarget: b ? b.handle : null,
      bbox:
        box === null
          ? [0, 0, 0, 0]
          : [box.minX, box.minY, box.maxX, box.maxY],
      base: a ? capPrimitives(a.prims, budget) : [],
      target: b ? capPrimitives(b.prims, budget) : [],
    };
  });
  for (let i = 0; i < out.length; i++) out[i].id = i;

  const { changeSets, setIdOf } = buildChangeSets(out, tolerance);
  for (let i = 0; i < out.length; i++) out[i].setId = setIdOf[i];

  const summary = {
    added: addedCount,
    removed: removedCount,
    modified,
    unchanged: Math.max(0, unchanged),
    notCompared,
    changeSets: changeSets.length,
    elapsedMs: Date.now() - startedAt,
    truncated,
  };

  return { changes: out, changeSets, summary, warnings };
}
