/**
 * compare —— 图纸对比（新增 / 删除 / 修改 + 变更集 + 告警）。
 *
 * 走正在运行的本机服务：POST /api/open（两张图）→ POST /api/compare。
 * 为什么不在 CLI 里自己算：对比引擎是产品的一部分（server/compare.js + shared/geometry），
 * 自己实现一套会出现"CLI 说 12 处变更、界面说 9 处"的双口径。这里只做搬运与裁剪。
 *
 * 为什么不在这里出 .docx 报告：报告每条变更都要一张 WebGL 截图（服务端强制要求），
 * 命令行没有渲染能力，伪造占位图等于交付假证据。报告走界面「图纸对比 → 导出报告」。
 *
 * 契约见 docs/compare-contract.md（字段名与语义由该文件冻结）。
 */
const DEFAULTS = {
  tolerance: 0.001,
  quantize: 1e-6,
  compareProps: ["color", "layer", "linetype", "lineweight"],
  includeHatch: false,
  maxChanges: 5000,
};

function numOpt(raw, fallback, name) {
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`--${name} 需要数字，收到 "${raw}"`);
  return n;
}

function listOpt(raw) {
  if (raw == null || raw === "") return DEFAULTS.compareProps;
  return String(raw)
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function buildOptions(opts = {}) {
  const props = listOpt(opts.props);
  const allowed = new Set(DEFAULTS.compareProps);
  const bad = props.filter((p) => !allowed.has(p));
  if (bad.length) {
    throw new Error(`--props 只支持 ${[...allowed].join(",")}；不认识：${bad.join(",")}`);
  }
  return {
    tolerance: numOpt(opts.tolerance, DEFAULTS.tolerance, "tolerance"),
    quantize: numOpt(opts.quantize, DEFAULTS.quantize, "quantize"),
    compareProps: props,
    includeHatch: !!opts["include-hatch"],
    maxChanges: Math.floor(numOpt(opts["max-changes"], DEFAULTS.maxChanges, "max-changes")),
  };
}

async function httpJson(url, { method = "GET", body, timeoutMs = 600000 } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new Error(`${method} ${url} 失败：${e && e.message ? e.message : e}`);
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const msg = data && data.error ? data.error : text.slice(0, 300);
    throw new Error(`${method} ${url} → HTTP ${res.status}: ${msg}`);
  }
  if (data == null) throw new Error(`${method} ${url} 返回的不是 JSON`);
  return data;
}

async function openDrawing(base, absPath) {
  const rec = await httpJson(`${base}/api/open`, { method: "POST", body: { path: absPath } });
  if (!rec || !rec.id) throw new Error(`打开图纸失败：${absPath}`);
  return rec;
}

/**
 * @param {{ baseAbs: string, targetAbs: string, opts: object,
 *           ensureServer: () => Promise<any>, fail: (msg:string)=>never }} args
 */
export async function runCompare({ baseAbs, targetAbs, opts, ensureServer, fail }) {
  const options = buildOptions(opts);
  const served = await ensureServer();
  if (!served || served.ok === false) {
    fail(
      "对比需要本机服务（server/index.js + web/dist）。" +
        "轻量包请重跑 install.ps1 / install.sh 补全组件；或用完整包安装。"
    );
  }
  const base = served.url;

  const [recA, recB] = await Promise.all([
    openDrawing(base, baseAbs),
    openDrawing(base, targetAbs),
  ]);

  const cmp = await httpJson(`${base}/api/compare`, {
    method: "POST",
    body: { base: recA.id, target: recB.id, options },
  });

  const changes = Array.isArray(cmp.changes) ? cmp.changes : [];
  const limit = opts.limit == null ? 200 : Math.max(0, Number(opts.limit) || 0);

  return {
    ok: true,
    base: { id: recA.id, name: recA.name, path: baseAbs, entities: recA.stats?.entities?.total ?? null },
    target: {
      id: recB.id,
      name: recB.name,
      path: targetAbs,
      entities: recB.stats?.entities?.total ?? null,
    },
    options,
    summary: cmp.summary || {},
    changeSets: (cmp.changeSets || []).map((s) => ({
      id: s.id,
      bbox: s.bbox,
      count: s.count,
      kinds: s.kinds,
    })),
    changesTotal: changes.length,
    changes: changes.slice(0, limit).map((c) => ({
      kind: c.kind,
      type: c.type,
      layer: c.layer,
      handleBase: c.handleBase ?? null,
      handleTarget: c.handleTarget ?? null,
      bbox: c.bbox,
      setId: c.setId ?? null,
    })),
    changesTruncated: changes.length > limit,
    warnings: cmp.warnings || [],
    unfilled: {
      skippedEntityTypes: (cmp.warnings || [])
        .filter((w) => w.code === "unsupported")
        .map((w) => ({ type: w.type, count: w.count ?? null })),
      notCompared: cmp.summary?.notCompared ?? null,
    },
    howToRead: [
      "added = 只在 target（对比图）；removed = 只在 base（基准图）；modified = 两侧都有但几何或属性不同",
      "只比对模型空间顶层实体；块定义内部变化整体给 block-redefined 告警",
      "不支持的实体类型计入 notCompared，不会默认当成“没变”",
      `单次最多 ${options.maxChanges} 条变更，超出标记 truncated；用 --max-changes 提高（代价是耗时）`,
      "数值以本 JSON 为准，与界面「图纸对比」同源",
    ],
    report: {
      availableInUi: true,
      note:
        "可编辑 .docx 对比报告只在界面生成（每条变更要 WebGL 截图）：顶栏「图纸对比」→ 比对 → 导出报告。" +
        "命令行不给报告，也不会用占位图冒充截图。",
    },
  };
}
