import fs from "node:fs";
import readline from "node:readline";

/**
 * 轻量流式 DXF 组码统计器（不依赖第三方解析器，兼容 R12–R2018 及 cadcraft 输出变体）。
 * 统计：图层表（名称/颜色/状态）、块定义及内部实体数、INSERT 引用计数、
 *       模型空间实体类型×图层直方图、$EXTMIN/$EXTMAX、$ACADVER/$INSUNITS。
 */
export async function scanDxf(absPath, onProgress) {
  const layers = new Map(); // name -> {name,color,flags,entityCount}
  const blocks = new Map(); // name -> {name,entityCount,refCount,nestedRefCount,defined,brHandle}
  /** BLOCK_RECORD 句柄 → {handle,name,trueName,repTagHandle,layoutHandle}（匿名块溯源用） */
  const blockRecords = new Map();
  /** BLOCK_RECORD 名 → 记录（同名以首次为准） */
  const blockRecordsByName = new Map();
  /** 块内 INSERT 的目标块名 → Set<宿主块名>（*X 填充块找唯一父块） */
  const insertParents = new Map();
  /** *D 块名 → {handle}（DIMENSION 实体组码 2） */
  const dimByBlock = new Map();
  /** *T 块名 → {count,handle,brHandle}（ACAD_TABLE 实体组码 2 / 343） */
  const tableByBlock = new Map();
  const entitiesByType = {};
  let total = 0;
  let inserts = 0;
  let header = { version: null, insunits: null };
  let extents = null;

  const stream = fs.createReadStream(absPath, "utf-8");
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let section = null; // HEADER | TABLES | BLOCKS | ENTITIES | ...
  let tableType = null; // LAYER 表等
  let currentRecord = null; // TABLES 内正在累积的表记录
  let currentBlock = null; // BLOCKS 内当前块（**已解码**的块名，与 blocks 的 key 一致）
  let blockHeader = null; // 正在解析的 BLOCK 头（5/330/70/2）
  let entity = null; // 当前实体（ENTITIES 或 BLOCK 内）
  let lastCode = null;
  let lastValue = "";

  // 实体坐标点收集（用于离群点裁剪）
  const ptsX = [];
  const ptsY = [];
  let pendingX = null; // 见到 10 码值先存，配对 20 码成点

  // HEADER 变量状态机
  let headerVar = null;
  let extMin = [Infinity, Infinity];
  let extMax = [-Infinity, -Infinity];

  const ensureLayer = (name) => {
    if (!layers.has(name)) {
      layers.set(name, { name, color: 7, flags: 0, entityCount: 0 });
    }
    return layers.get(name);
  };

  /**
   * 取/建块记录。`defined` 只在见到 BLOCKS 段的 BLOCK 头（或 BLOCK_RECORD 定义）时置 true；
   * 仅被 INSERT 引用、没有定义的悬空块（如 09bb 的 *U0）保持 false。
   */
  const ensureBlock = (name, defined = false) => {
    let b = blocks.get(name);
    if (!b) {
      b = {
        name,
        entityCount: 0,
        refCount: 0,
        nestedRefCount: 0,
        defined: false,
        brHandle: null,
        flags: 0,
      };
      blocks.set(name, b);
    }
    if (defined) b.defined = true;
    return b;
  };

  const flushBlockRecord = () => {
    const r = currentRecord;
    if (!r || !r.handle || !r.name) return;
    if (!blockRecords.has(r.handle)) blockRecords.set(r.handle, r);
    if (!blockRecordsByName.has(r.name)) blockRecordsByName.set(r.name, r);
  };

  // 附属于宿主实体的子记录，不计入独立实体统计（AutoCAD 语义）
  const SUBSIDIARY = new Set(["ATTRIB", "SEQEND", "VERTEX"]);

  const finishEntity = () => {
    if (!entity) return;
    const { type, layer, blockName } = entity;
    const inBlockDef = currentBlock !== null && currentBlock !== "__pending__";

    if (inBlockDef) {
      // 块定义内部：只计入块内部实体数与嵌套引用
      const b = ensureBlock(currentBlock);
      b.entityCount++;
      if (type === "INSERT" && blockName) {
        const target = ensureBlock(blockName);
        target.nestedRefCount = (target.nestedRefCount || 0) + 1;
        // 记录「目标块被哪个块定义引用」，用于 *X 填充块反查唯一父块
        let parents = insertParents.get(blockName);
        if (!parents) insertParents.set(blockName, (parents = new Set()));
        parents.add(currentBlock);
      }
    } else {
      // 模型空间 / 图纸空间：主统计
      if (!SUBSIDIARY.has(type)) {
        total++;
        entitiesByType[type] = (entitiesByType[type] || 0) + 1;
        if (layer) ensureLayer(layer).entityCount++;
      }
      if (type === "INSERT") {
        inserts++;
        if (blockName) {
          const target = ensureBlock(blockName);
          target.refCount = (target.refCount || 0) + 1;
        }
      }
    }
    // 匿名块溯源：*D 标注块 / *T 表格块由宿主实体反查。
    // ⚠️ 不限于 ENTITIES：DIMENSION / ACAD_TABLE 也可能嵌套在块定义里
    //    （实测 5b210 有 497/625 个 *D 的宿主 DIMENSION 在 BLOCKS 段内）。
    if (type === "DIMENSION" && blockName) {
      if (!dimByBlock.has(blockName)) {
        dimByBlock.set(blockName, { handle: entity.handle || null });
      }
    } else if (type === "ACAD_TABLE" && blockName) {
      let tr = tableByBlock.get(blockName);
      if (!tr) {
        tr = { count: 0, handle: null, brHandle: null };
        tableByBlock.set(blockName, tr);
      }
      tr.count++;
      if (!tr.handle) tr.handle = entity.handle || null;
      if (!tr.brHandle) tr.brHandle = entity.brHandle || null;
    }
    entity = null;
    pendingX = null;
  };


  for await (const raw of rl) {
    const line = raw.trim();
    // 码位置遇空行跳过；值位置空行 = 空值（保留，防止码值错位）
    if (line === "" && lastCode === null) continue;

    if (lastCode === null) {
      lastCode = parseInt(line, 10);
      if (isNaN(lastCode)) lastCode = null;
      continue;
    }
    lastValue = line;

    const code = lastCode;
    const value = lastValue;
    lastCode = null;

    // ---- SECTION 切换 ----
    if (code === 0) {
      if (value === "SECTION") {
        section = "__pending__";
        continue;
      }
      if (value === "ENDSEC") {
        if (section === "TABLES" && tableType === "BLOCK_RECORD") flushBlockRecord();
        section = null;
        tableType = null;
        currentRecord = null;
        finishEntity();
        currentBlock = null;
        blockHeader = null;
        continue;
      }
      if (value === "EOF") break;
    }
    if (section === "__pending__") {
      if (code === 2) {
        section = value.toUpperCase();
      }
      continue;
    }

    // ---- HEADER ----
    if (section === "HEADER") {
      if (code === 9) {
        headerVar = value;
      } else if (headerVar === "$ACADVER" && code === 1) {
        header.version = value;
      } else if (headerVar === "$INSUNITS" && code === 70) {
        header.insunits = parseInt(value, 10);
      } else if (headerVar === "$EXTMIN" && (code === 10 || code === 20)) {
        extMin[code === 10 ? 0 : 1] = parseFloat(value);
      } else if (headerVar === "$EXTMAX" && (code === 10 || code === 20)) {
        extMax[code === 10 ? 0 : 1] = parseFloat(value);
      }
      continue;
    }

    // ---- TABLES（只关心 LAYER） ----
    if (section === "TABLES") {
      if (code === 0 && value === "TABLE") {
        if (tableType === "BLOCK_RECORD") flushBlockRecord();
        tableType = "__pending__";
        currentRecord = null;
        continue;
      }
      if (tableType === "__pending__" && code === 2) {
        tableType = value.toUpperCase();
        continue;
      }
      if (tableType === "LAYER") {
        if (code === 0 && value === "LAYER") {
          if (currentRecord?.name) {
            layers.set(currentRecord.name, {
              ...currentRecord,
              entityCount: 0,
            });
          }
          currentRecord = { name: null, rawName: null, color: 7, rawColor: 7, flags: 0 };
        } else if (code === 0 && value === "ENDTAB") {
          if (currentRecord?.name && !layers.has(currentRecord.name)) {
            layers.set(currentRecord.name, { ...currentRecord, entityCount: 0 });
          }
          currentRecord = null;
          tableType = null;
        } else if (currentRecord) {
          if (code === 2) { currentRecord.name = decodeDxfName(value); currentRecord.rawName = value; }
          else if (code === 62) {
            currentRecord.rawColor = parseInt(value, 10) || 7;
            currentRecord.color = Math.abs(currentRecord.rawColor);
          }
          else if (code === 70) currentRecord.flags = parseInt(value, 10) || 0;
        }
      } else if (tableType === "BLOCK_RECORD") {
        /* 匿名块溯源的核心表：句柄、名字、布局句柄（340）与 XDATA
         *  - AcDbBlockRepBTag 的 1005 = 动态块真实定义的 BLOCK_RECORD 句柄
         *  - AcDbDynamicBlockTrueName / ...TrueName2 的 1000 = 原始（真）块名 */
        if (code === 0 && value === "BLOCK_RECORD") {
          flushBlockRecord();
          currentRecord = {
            handle: null,
            name: null,
            layoutHandle: null,
            trueName: null,
            repTagHandle: null,
            xdataApp: null,
          };
        } else if (code === 0 && value === "ENDTAB") {
          flushBlockRecord();
          currentRecord = null;
          tableType = null;
        } else if (currentRecord) {
          if (code === 5) currentRecord.handle = value;
          else if (code === 2) currentRecord.name = decodeDxfName(value);
          else if (code === 340) currentRecord.layoutHandle = value;
          else if (code === 1001) currentRecord.xdataApp = value;
          else if (code === 1000 && currentRecord.xdataApp && /^AcDbDynamicBlockTrueName/i.test(currentRecord.xdataApp)) {
            if (currentRecord.trueName == null) currentRecord.trueName = decodeDxfName(value);
          } else if (code === 1005 && currentRecord.xdataApp === "AcDbBlockRepBTag") {
            if (currentRecord.repTagHandle == null) currentRecord.repTagHandle = value;
          }
        }
      }
      continue;
    }

    // ---- BLOCKS ----
    if (section === "BLOCKS") {
      if (code === 0 && value === "BLOCK") {
        finishEntity();
        blockHeader = { handle: null, parentHandle: null, flags: 0 };
        currentBlock = "__pending__";
        continue;
      }
      if (blockHeader) {
        // BLOCK 头：5=BLOCK 实体句柄，330=宿主 BLOCK_RECORD 句柄，70=块标志
        if (code === 5) blockHeader.handle = value;
        else if (code === 330) blockHeader.parentHandle = value;
        else if (code === 70) {
          blockHeader.flags = parseInt(value, 10) || 0;
          if (currentBlock && currentBlock !== "__pending__") {
            ensureBlock(currentBlock).flags = blockHeader.flags;
          }
        }
        else if (code === 2) {
          // ⚠️ 必须解码成与 blocks Map 相同的 key，否则块内 entityCount 全部丢失
          currentBlock = decodeDxfName(value);
          const b = ensureBlock(currentBlock, true);
          b.brHandle = blockHeader.parentHandle || null;
          b.flags = blockHeader.flags;
        }
        if (code !== 0) continue;
        blockHeader = null; // 头结束（首个实体或 ENDBLK），继续走下面的 0 码处理
      }
      if (code === 0 && value === "ENDBLK") {
        finishEntity();
        currentBlock = null;
        continue;
      }
      if (code === 0) {
        finishEntity();
        entity = {
          type: value,
          layer: null,
          blockName: null,
          handle: null,
          brHandle: null,
        };
        continue;
      }
      if (entity) {
        if (code === 8) entity.layer = decodeDxfName(value);
        else if (code === 5) entity.handle = value;
        else if (
          code === 2 &&
          (entity.type === "INSERT" ||
            entity.type === "DIMENSION" ||
            entity.type === "ACAD_TABLE")
        ) {
          entity.blockName = decodeDxfName(value);
        } else if (code === 343 && entity.type === "ACAD_TABLE") {
          entity.brHandle = value;
        }
        // 注意：BLOCKS 段的点是块定义局部坐标，与模型空间无关，
        // 不能进 ptsX/ptsY（否则污染主体范围/内容盒统计）
      }
      continue;
    }

    // ---- ENTITIES（模型空间 + 图纸空间） ----
    if (section === "ENTITIES") {
      if (code === 0) {
        finishEntity();
        entity = {
          type: value,
          layer: null,
          blockName: null,
          handle: null,
          brHandle: null,
        };
        continue;
      }
      if (entity) {
        if (code === 8) entity.layer = decodeDxfName(value);
        else if (code === 5) entity.handle = value;
        else if (
          code === 2 &&
          (entity.type === "INSERT" ||
            entity.type === "DIMENSION" ||
            entity.type === "ACAD_TABLE")
        ) {
          entity.blockName = decodeDxfName(value);
        } else if (code === 343 && entity.type === "ACAD_TABLE") {
          entity.brHandle = value;
        } else if (code === 10) {
          const f = parseFloat(value);
          if (isFinite(f)) pendingX = f;
        } else if (code === 20 && pendingX !== null) {
          const f = parseFloat(value);
          if (isFinite(f)) {
            ptsX.push(pendingX);
            ptsY.push(f);
          }
          pendingX = null;
        }
      }
      continue;
    }
  }
  finishEntity();

  if (
    extMin.every(isFinite) &&
    extMax.every(isFinite) &&
    (extMax[0] > extMin[0] || extMax[1] > extMin[1])
  ) {
    extents = {
      minX: extMin[0],
      minY: extMin[1],
      maxX: extMax[0],
      maxY: extMax[1],
      width: extMax[0] - extMin[0],
      height: extMax[1] - extMin[1],
    };
  }

  // 剔除精确位于原点的点：cadcraft 的 DXF 导出里 HATCH 种子点等落在 (0,0)，
  // 数量可观（本例 2376/17242）会把主体范围统计拉偏。图纸本身就在原点附近时，
  // 由下方长度守卫自然回退，不会误伤。
  {
    let w = 0;
    for (let i = 0; i < ptsX.length; i++) {
      if (Math.abs(ptsX[i]) <= 1 && Math.abs(ptsY[i]) <= 1) continue;
      ptsX[w] = ptsX[i];
      ptsY[w] = ptsY[i];
      w++;
    }
    ptsX.length = w;
    ptsY.length = w;
  }

  // 主体范围：IQR 箱线图离群剔除（k=3），排除飞点与远处实体簇
  let coreExtents = extents;
  if (ptsX.length > 50) {
    const q = (arr, p) => arr[Math.floor((arr.length - 1) * p)];
    const clip = (arr) => {
      const s = [...arr].sort((a, b) => a - b);
      const q1 = q(s, 0.25);
      const q3 = q(s, 0.75);
      const iqr = q3 - q1;
      if (!(iqr > 0)) return null;
      const lo = q1 - 3 * iqr;
      const hi = q3 + 3 * iqr;
      const kept = s.filter((v) => v >= lo && v <= hi);
      if (kept.length < s.length * 0.5) return null; // 剔除过多则放弃
      return { min: kept[0], max: kept[kept.length - 1] };
    };
    const cx = clip(ptsX);
    const cy = clip(ptsY);
    if (cx && cy && cx.max > cx.min && cy.max > cy.min) {
      coreExtents = {
        minX: cx.min,
        minY: cy.min,
        maxX: cx.max,
        maxY: cy.max,
        width: cx.max - cx.min,
        height: cy.max - cy.min,
      };
    }
  }

  // 主体内容盒：2D 网格密度区域增长 + 密集区合并。
  // 解决两类真实图纸问题：① 建筑内部稀疏缺口把范围切成两段（长墙无中间顶点）；
  // ② 稀疏但跨度大的实体（幕墙延伸、轴号引线）把视图撑空。返回 DXF 坐标盒。
  let contentBox = null;
  if (ptsX.length > 50) {
    contentBox = computeContentBox(ptsX, ptsY, coreExtents);
  }

  // BLOCK_RECORD 里存在、但 BLOCKS 段没给 BLOCK 头的块，同样算「有定义」
  for (const [name, br] of blockRecordsByName) {
    const b = ensureBlock(name, true);
    if (!b.brHandle) b.brHandle = br.handle;
  }

  const isAnonymousName = (name) =>
    name.startsWith("*") || /^A\$/i.test(name);

  /** 布局块：BLOCK_RECORD 的 340 != 0（指向 LAYOUT）；R12 无 BLOCK_RECORD 时按约定名兜底 */
  const isLayoutBlock = (b) => {
    const br =
      blockRecordsByName.get(b.name) ||
      (b.brHandle ? blockRecords.get(b.brHandle) : null);
    if (br) return !!(br.layoutHandle && br.layoutHandle !== "0");
    return /^\*(?:model|paper)_space/i.test(b.name);
  };

  const isDefinedName = (name) => {
    const b = blocks.get(name);
    return !!(b && b.defined);
  };

  /**
   * 动态块表示块（*U）溯源：
   * 先看 TrueName（AcDbDynamicBlockTrueName / ...TrueName2），再看 AcDbBlockRepBTag 的
   * 1005 句柄；若指向的仍是 *U，顺着链继续跟（带环检测与深度上限）。
   */
  const resolveDynamicOrigin = (b) => {
    let br =
      (b.brHandle && blockRecords.get(b.brHandle)) ||
      blockRecordsByName.get(b.name) ||
      null;
    const seen = new Set();
    for (let depth = 0; depth < 16; depth++) {
      if (!br || seen.has(br.handle)) break;
      seen.add(br.handle);
      if (br.trueName) {
        if (!br.trueName.startsWith("*")) {
          return { name: br.trueName, handle: br.handle };
        }
        const next = blockRecordsByName.get(br.trueName);
        if (next) {
          br = next;
          continue;
        }
        return { name: br.trueName, handle: br.handle };
      }
      if (br.repTagHandle) {
        const next = blockRecords.get(br.repTagHandle);
        if (next) {
          br = next;
          continue;
        }
        break;
      }
      if (br.name && !br.name.startsWith("*")) {
        return { name: br.name, handle: br.handle };
      }
      break;
    }
    return null;
  };

  /** 每个块的匿名溯源信息；具名块（非 A$/A$C）不输出 origin */
  const resolveOrigin = (b) => {
    if (!isAnonymousName(b.name)) return undefined;

    if (b.name.startsWith("*U")) {
      const r = resolveDynamicOrigin(b);
      return {
        kind: "dynamic",
        ...(r ? { name: r.name, handle: r.handle } : {}),
        resolvable: !!(r && isDefinedName(r.name)),
        // *U 的类型由前缀确定；能否溯源到名字另说
        confidence: r ? "exact" : "none",
      };
    }
    if (b.name.startsWith("*D")) {
      const d = dimByBlock.get(b.name);
      return {
        kind: "dimension",
        ...(d?.handle ? { handle: d.handle } : {}),
        resolvable: false,
        confidence: d ? "exact" : "none",
      };
    }
    if (b.name.startsWith("*T")) {
      const t = tableByBlock.get(b.name);
      return {
        kind: "table",
        ...(t?.handle ? { handle: t.handle } : {}),
        resolvable: false,
        confidence: t ? "exact" : "none",
      };
    }
    if (b.name.startsWith("*X")) {
      const parents = insertParents.get(b.name);
      // 唯一父块时用该 INSERT 的宿主块（330 → BLOCK_RECORD）反查；孤儿/多父块不可知
      if (parents && parents.size === 1) {
        const parentName = [...parents][0];
        const pb = blocks.get(parentName);
        return {
          kind: "hatch",
          name: parentName,
          ...(pb?.brHandle ? { handle: pb.brHandle } : {}),
          resolvable: !!(pb && pb.defined),
          confidence: "heuristic",
        };
      }
      return { kind: "hatch", resolvable: false, confidence: "none" };
    }
    if (/^A\$/i.test(b.name)) {
      // A$C / A$：复制/粘贴产生的块，DXF 里没有任何原始名记录
      return { kind: "copy", resolvable: false, confidence: "none" };
    }
    return { kind: "none", resolvable: false, confidence: "none" };
  };

  const layerList = [...layers.values()].sort(
    (a, b) => b.entityCount - a.entityCount
  );

  const allBlocks = [...blocks.values()];
  const layoutBlockDefCount = allBlocks.filter(isLayoutBlock).length;
  // 布局块不进列表（但仍计入 layoutBlockDefCount）
  const blockList = allBlocks
    .filter((b) => !isLayoutBlock(b))
    .sort((a, b) => (b.refCount || 0) - (a.refCount || 0));

  // blockDefCount 保持历史口径：不含 `*` 开头的块（含只有引用的条目），与旧缓存一致
  const blockDefCount = blockList.filter((b) => !b.name.startsWith("*")).length;
  // 与 blockDefCount 互补：`*` 开头的块定义数（A$C/A$ 沿用历史口径，不在这个数里）
  const anonymousBlockDefCount = allBlocks.filter(
    (b) => b.name.startsWith("*") && b.defined
  ).length;

  const rawBlocks = blockList.map((b) => {
    const origin = resolveOrigin(b);
    return {
      name: b.name,
      isLayout: isLayoutBlock(b),
      entityCount: b.entityCount,
      refCount: b.refCount || 0,
      nestedRefCount: b.nestedRefCount || 0,
      defined: !!b.defined,
      anonymous: isAnonymousName(b.name),
      ...(origin ? { origin } : {}),
      ...(b.name.startsWith("*T")
        ? { tableRefCount: tableByBlock.get(b.name)?.count || 0 }
        : {}),
    };
  });

  // 匿名块不单独显示：能精确/启发式溯源的并回原块（只并 refCount），其余隐藏。
  const {
    blocks: displayBlocks,
    anonymousHiddenCount,
    unusedBlockDefCount,
  } = aggregateAnonymousBlocks(rawBlocks);

  return {
    layers: layerList.map((l) => ({
      name: l.name,
      rawName: l.rawName || l.name,
      color: l.color,
      colorHex: aciToHex(l.color),
      frozen: !!(l.flags & 1),
      off: !!(l.flags & 4) || (l.rawColor ?? 7) < 0,
      locked: !!(l.flags & 16),
      entityCount: l.entityCount,
    })),
    blocks: displayBlocks,
    blockDefCount,
    anonymousBlockDefCount,
    layoutBlockDefCount,
    anonymousHiddenCount,
    unusedBlockDefCount,
    entities: { total, byType: entitiesByType, inserts },
    extents,
    coreExtents,
    contentBox,
    header,
  };
}

/**
 * 把匿名块行并回真实块名（stats.blocks 的最终形态）。
 *
 * 规则：
 *  - 匿名行（anonymous === true）一律不再出现在结果里；
 *  - origin 能给出真实块名（且不是另一个匿名名）的动态块 / 填充块，把 refCount 并到目标行，
 *    目标行记录 anonymousRefCount 与 aggregatedFrom；entityCount 不并（块定义内实体，合并会重复计数）；
 *  - 目标块在本图没有定义时新建一行 defined:false 的空壳（如 BLOCK_X）；
 *  - *D / *T / A$C / A$ / 悬空 *U / 孤儿或多父 *X 直接隐藏，只计入 anonymousHiddenCount。
 *
 * 该函数同时供 index.js 迁移旧 statsVersion=2 的缓存（旧 stats 已含 origin 字段），
 * 所以只依赖行数据，不依赖扫描时的任何 Map。
 */
export function aggregateAnonymousBlocks(rows) {
  const out = [];
  const byName = new Map();

  // 先落所有具名行，保证合并目标一定被优先找到
  for (const r of rows) {
    if (!r || r.anonymous) continue;
    const row = { ...r, anonymous: false };
    out.push(row);
    byName.set(row.name, row);
  }

  let hidden = 0;
  for (const r of rows) {
    if (!r || !r.anonymous) continue;
    const o = r.origin;
    const name = o && o.name;
    const mergeable =
      !!name &&
      !name.startsWith("*") &&
      !/^A\$/i.test(name) &&
      o.confidence !== "none";

    if (!mergeable) {
      hidden++;
      continue;
    }

    let target = byName.get(name);
    if (!target) {
      // 原块不在本图：凭空出一行，计数不丢，用户看到的是真实块名
      target = {
        name,
        isLayout: false,
        entityCount: 0,
        refCount: 0,
        nestedRefCount: 0,
        defined: false,
        anonymous: false,
        anonymousRefCount: 0,
        aggregatedFrom: [],
      };
      byName.set(name, target);
      out.push(target);
    }

    target.refCount += r.refCount || 0;
    target.anonymousRefCount = (target.anonymousRefCount || 0) + (r.refCount || 0);
    (target.aggregatedFrom ||= []).push(r.name);
  }

  for (const row of out) {
    if (!(row.anonymousRefCount > 0)) {
      delete row.anonymousRefCount;
      delete row.aggregatedFrom;
    } else {
      row.aggregatedFrom.sort((a, b) =>
        a.localeCompare(b, "zh-CN", { numeric: true })
      );
    }
  }

  /* `used`：这个块定义在本图里到底有没有被用到。
   * ⚠️ 只按 refCount=0 判断会隐藏正在用的块：refCount 只数"顶层 INSERT"，块定义仍可能被
   *    别的块内部引用（nestedRefCount）。实测规律：refCount=0 的块里多数是这种
   *    （如某个设备类块只被别的块内部引用 8 次）。
   *    两者都为 0 的才是 PURGE 残留（通常只有极少数）。 */
  let unusedBlockDefCount = 0;
  for (const row of out) {
    const used = (row.refCount || 0) > 0 || (row.nestedRefCount || 0) > 0;
    row.used = used;
    if (!used) unusedBlockDefCount++;
  }

  out.sort(
    (a, b) =>
      (b.refCount || 0) - (a.refCount || 0) ||
      (b.entityCount || 0) - (a.entityCount || 0)
  );
  return { blocks: out, anonymousHiddenCount: hidden, unusedBlockDefCount };
}

/**
 * 主体内容盒（DXF 坐标）：
 * 1. 在 coreExtents 上铺 64×64 网格统计点密度；
 * 2. 8 连通区域增长找出所有密集区（阈值 = 峰值 2%，下限 2）；
 * 3. X 或 Y 向包围盒相交的密集区迭代合并——桥接建筑内部的稀疏缺口
 *    （长墙无中间顶点导致 1D 直方图断档），同时不合并仅单轴相交的稀疏远簇；
 * 4. 取合并后区域的点包围盒，外扩 2%。
 * 失败返回 null（调用方回退全图 viewBox）。
 */
function computeContentBox(ptsX, ptsY, core) {
  const G = 64;
  const cw = core.maxX - core.minX;
  const ch = core.maxY - core.minY;
  if (!(cw > 0) || !(ch > 0)) return null;
  const cellW = cw / G;
  const cellH = ch / G;
  const grid = new Int32Array(G * G);
  let inside = 0;
  for (let i = 0; i < ptsX.length; i++) {
    const x = ptsX[i];
    const y = ptsY[i];
    if (x < core.minX || x > core.maxX || y < core.minY || y > core.maxY) {
      continue;
    }
    const gx = Math.min(G - 1, ((x - core.minX) / cellW) | 0);
    const gy = Math.min(G - 1, ((y - core.minY) / cellH) | 0);
    grid[gy * G + gx]++;
    inside++;
  }
  if (inside < 30) return null;

  let peak = 0;
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] > peak) peak = grid[i];
  }
  if (peak < 3) return null;
  const T = Math.max(2, Math.floor(peak * 0.02));

  // 所有密集区（8 连通 BFS）
  const seen = new Uint8Array(G * G);
  const regions = [];
  for (let i = 0; i < grid.length; i++) {
    if (seen[i] || grid[i] < T) continue;
    const cells = [];
    const stack = [i];
    seen[i] = 1;
    let count = 0;
    while (stack.length) {
      const c = stack.pop();
      cells.push(c);
      count += grid[c];
      const gx = c % G;
      const gy = (c / G) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = gx + dx;
          const ny = gy + dy;
          if (nx < 0 || ny < 0 || nx >= G || ny >= G) continue;
          const ni = ny * G + nx;
          if (seen[ni] || grid[ni] < T) continue;
          seen[ni] = 1;
          stack.push(ni);
        }
      }
    }
    let gx0 = G;
    let gx1 = -1;
    let gy0 = G;
    let gy1 = -1;
    for (const c of cells) {
      const gx = c % G;
      const gy = (c / G) | 0;
      if (gx < gx0) gx0 = gx;
      if (gx > gx1) gx1 = gx;
      if (gy < gy0) gy0 = gy;
      if (gy > gy1) gy1 = gy;
    }
    regions.push({ cells: new Set(cells), count, gx0, gx1, gy0, gy1 });
  }
  if (!regions.length) return null;
  regions.sort((a, b) => b.count - a.count);

  // 迭代合并：与已合并区在 X 或 Y 向包围盒相交即并入（桥接内部缺口）
  const merged = [regions[0]];
  const rest = regions.slice(1);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = rest.length - 1; i >= 0; i--) {
      const r = rest[i];
      for (const m of merged) {
        const xOverlap = r.gx0 <= m.gx1 && r.gx1 >= m.gx0;
        const yOverlap = r.gy0 <= m.gy1 && r.gy1 >= m.gy0;
        if (xOverlap || yOverlap) {
          for (const c of r.cells) m.cells.add(c);
          m.count += r.count;
          m.gx0 = Math.min(m.gx0, r.gx0);
          m.gx1 = Math.max(m.gx1, r.gx1);
          m.gy0 = Math.min(m.gy0, r.gy0);
          m.gy1 = Math.max(m.gy1, r.gy1);
          rest.splice(i, 1);
          changed = true;
          break;
        }
      }
    }
  }

  const main = merged[0];
  if (main.count < inside * 0.3) return null;

  // 合并区域的点包围盒
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let boxCount = 0;
  for (let i = 0; i < ptsX.length; i++) {
    const x = ptsX[i];
    const y = ptsY[i];
    if (x < core.minX || x > core.maxX || y < core.minY || y > core.maxY) {
      continue;
    }
    const gx = Math.min(G - 1, ((x - core.minX) / cellW) | 0);
    const gy = Math.min(G - 1, ((y - core.minY) / cellH) | 0);
    if (!main.cells.has(gy * G + gx)) continue;
    boxCount++;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (boxCount < 30 || !(maxX > minX) || !(maxY > minY)) return null;

  const padX = (maxX - minX) * 0.02;
  const padY = (maxY - minY) * 0.02;
  return {
    minX: minX - padX,
    minY: minY - padY,
    maxX: maxX + padX,
    maxY: maxY + padY,
    width: maxX - minX + 2 * padX,
    height: maxY - minY + 2 * padY,
  };
}

/** AutoCAD 颜色索引 → 近似十六进制 */
const ACI_BASE = {
  0: "#000000",
  1: "#ff0000",
  2: "#ffff00",
  3: "#00ff00",
  4: "#00ffff",
  5: "#0000ff",
  6: "#ff00ff",
  7: "#ffffff",
  8: "#808080",
  9: "#c0c0c0",
};
/**
 * 解码 DXF 名称里的 AutoCAD Unicode 转义 `\U+XXXX`。
 * 实测某真实图纸的图层名「动力环境…」在 DXF 里存成 `\U+52A8\U+529B\U+73AF\U+5883…`，
 * 直接显示就是乱码（这正是"名称未准确解析"）。非 BMP 字符会以代理对形式出现两个
 * 转义，逐码元解码天然正确。
 */
export function decodeDxfName(v) {
  if (typeof v !== "string" || v.indexOf("\\U+") < 0) return v;
  return v.replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) =>
    String.fromCharCode(parseInt(h, 16))
  );
}

export function aciToHex(aci) {
  if (ACI_BASE[aci]) return ACI_BASE[aci];
  if (aci >= 10 && aci <= 249) {
    const idx = aci - 10;
    const hueGroup = Math.floor(idx / 10) % 24;
    const shade = idx % 10;
    const hue = Math.floor((hueGroup / 24) * 360);
    const light = shade % 5 === 0 ? 50 + shade * 3 : 50 - shade * 5;
    return hslToHex(hue, 100, Math.max(20, Math.min(80, light)));
  }
  return "#ffffff";
}

function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) =>
    Math.round(
      255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))))
    );
  return (
    "#" +
    [f(0), f(8), f(4)]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("")
  );
}
