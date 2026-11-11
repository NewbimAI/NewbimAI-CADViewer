/**
 * udo —— 天正（自定义对象）判定与解析覆盖摘要。
 *
 * 对外只描述"能不能解析、解出多少、没解出多少、为什么不画"，不涉及任何解码实现细节。
 * 数据来源：
 *   · udo-detect.js —— 扫描用 DXF 的 CLASSES 段（快速判定 provenance / objects）
 *   · udo-convert.js —— 可选的闭源解析组件（二进制，进程调用），给出按类的解出计数
 * 没有组件 / 不是 DWG / 解码失败 → 如实降级，不猜几何、不伪造覆盖。
 */

const KIND_LABEL = {
  wall: "墙体",
  opening: "门窗洞口",
  text: "文字",
  dimension: "尺寸标注",
};

const pct = (part, total) => (total > 0 ? Math.round((part / total) * 1000) / 10 : null);

/**
 * @param {object} ctx cad.mjs 的上下文（root / mod）
 * @param {string} srcAbs
 * @param {{ ensureDxf: Function }} deps
 */
export async function udoCoverage(ctx, srcAbs, deps) {
  const isDwg = /\.dwg$/i.test(srcAbs);

  const result = {
    ok: true,
    file: srcAbs,
    format: isDwg ? "DWG" : "DXF",
    judgement: {
      level: "unknown",
      classes: [],
      classCount: 0,
      evidence: [],
    },
    decoder: {
      available: false,
      component: "bin/udo-cli/udo-cli.exe",
      used: false,
      error: null,
    },
    customObjects: null,
    notes: [],
  };

  // DXF 侧判定需要转换产物；DWG 缺 cadcraft 时不应该连覆盖统计也做不了，
  // 所以这里失败只降级 judgement，不阻断后面的解析组件调用。
  try {
    const dxf = await deps.ensureDxf(ctx, srcAbs);
    const info = ctx.cli ? await ctx.cli.infoJson(srcAbs) : null;
    const judgement = ctx.mod.detectUdo({ dxfPath: dxf.dxfPath, info });
    result.judgement = {
      level: judgement.level || "none",
      classes: judgement.classes || [],
      classCount: (judgement.classes || []).length,
      evidence: (judgement.evidence || []).slice(0, 8),
    };
  } catch (e) {
    result.judgement.error = e && e.message ? e.message : String(e);
    result.notes.push("无法生成扫描用 DXF，跳过类名判定；下面的覆盖统计只依赖原始 DWG。");
  }

  if (!isDwg) {
    result.notes.push(
      "DXF 输入只能按 CLASSES 段判定来源；解出/未解出的计数需要原始 DWG（对比引擎用的 DXF 已被转换器丢掉自定义对象）。"
    );
    return result;
  }

  if (!ctx.mod.udoConvert) {
    result.decoder.error = "当前安装没有自定义对象解析模块（server/udo-convert.js）";
    result.notes.push("统计与导出不受影响；需要解析时重跑 install.ps1 / install.sh，或用完整包安装。");
    return result;
  }

  let cliPath = null;
  try {
    cliPath = ctx.mod.udoConvert.resolveUdoCli(ctx.root);
  } catch {
    cliPath = null;
  }
  result.decoder.available = !!cliPath;
  if (!cliPath) {
    result.decoder.error = "未找到解析组件（bin/udo-cli/udo-cli.exe）";
    result.notes.push(
      "没有解析组件时：不注入自定义对象几何，其余看图/统计/对比/导出照常可用（doctor 会把 udo 列入 degraded）。"
    );
    return result;
  }

  result.decoder.used = true;
  const dump = await ctx.mod.udoConvert.decodeUdo(srcAbs, { root: ctx.root });
  if (!dump.ok) {
    result.decoder.error = dump.error || "解析失败";
    result.notes.push("解析失败按“未解出”处理，不绘制、不猜坐标。");
    return result;
  }

  const summary = ctx.mod.udoConvert.summarizeUdo(dump.data);
  const byKind = {};
  for (const [k, n] of Object.entries(summary.decodedByKind || {})) {
    byKind[k] = { label: KIND_LABEL[k] || k, decoded: n };
  }
  const total = summary.entities || 0;
  const decoded = Math.min(summary.decoded || 0, total || summary.decoded || 0);

  result.customObjects = {
    total,
    decoded,
    undecoded: Math.max(0, total - decoded),
    coveragePct: pct(decoded, total),
    byKind,
    classes: summary.classes || [],
    classCount: summary.classCount || (summary.classes || []).length,
    detected: !!summary.detected || total > 0,
  };

  result.notes.push(
    "未解出的对象不会被绘制，也不会用占位几何冒充；这是能力边界，不是“文件损坏”。"
  );
  if (total > 0 && decoded < total) {
    result.notes.push(
      `未解出 ${total - decoded} 个，可按类分别核对：只有 byKind 里列出的类有解码器。`
    );
  }
  return result;
}
