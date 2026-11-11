/**
 * 图纸对比 Word 报告（.docx）生成器。
 *
 * 输入是前端截好、画好云线的 PNG（base64），这里只做两件事：
 *   1. 校验/归一化 payload（图片必须是真 PNG，避免把坏数据塞进 docx）；
 *   2. 用 docx 库排版：封面 + 统计 + 按变更集分章 + 每条变更一节（图 + 说明）。
 *
 * 为什么不在服务端截图：图纸渲染在浏览器 WebGL 里，服务端没有同一套渲染器；
 * 而且云线需要 DxfCanvas 的 `project()` 投影，只有前端知道当前相机。
 */
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  HeadingLevel,
  ImageRun,
  PageBreak,
  PageNumber,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  convertMillimetersToTwip,
} from "docx";

/** 请求体上限：~200MB（500 条 1200px 宽的 PNG 通常只有几十 MB） */
export const MAX_REPORT_BYTES = 200 * 1024 * 1024;
/** 单张截图上限：防止一张坏图把内存打爆 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** 单份报告最多条目数；再大就不该走“一次 JSON”这条路了 */
const MAX_CHANGES = 20000;

export const REPORT_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const FONT = "Microsoft YaHei";
const MONO = "Consolas";

const KIND_LABEL = {
  added: "新增",
  removed: "删除",
  modified: "修改",
};

const KIND_COLOR = {
  added: "16A34A",
  removed: "DC2626",
  modified: "F59E0B",
};

const PROP_LABEL = {
  color: "颜色",
  layer: "图层",
  linetype: "线型",
  lineweight: "线宽",
};

const TABLE_BORDERS = {
  top: { style: BorderStyle.SINGLE, size: 4, color: "E5E7EB" },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: "E5E7EB" },
  left: { style: BorderStyle.SINGLE, size: 4, color: "E5E7EB" },
  right: { style: BorderStyle.SINGLE, size: 4, color: "E5E7EB" },
  insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: "E5E7EB" },
  insideVertical: { style: BorderStyle.SINGLE, size: 4, color: "E5E7EB" },
};

export class ReportValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReportValidationError";
    this.statusCode = 400;
  }
}

/* ------------------------------------------------------------------ */
/* 文件名 / PNG 校验                                                   */
/* ------------------------------------------------------------------ */

function cleanFileStem(name) {
  const stem = String(name || "").replace(/\.[^.\\/]+$/, "");
  return (
    stem
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60) || "图纸"
  );
}

/** 对比报告_基准_vs_对比_YYYYMMDD-HHmm.docx（与前端 reportDownloadName 一致） */
export function buildReportFileName(baseName, targetName, date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(
    date.getDate()
  )}-${p(date.getHours())}${p(date.getMinutes())}`;
  return `对比报告_${cleanFileStem(baseName)}_vs_${cleanFileStem(
    targetName
  )}_${stamp}.docx`;
}

/** 从 PNG 头里读宽高（IHDR）；不是 PNG 返回 null */
export function pngSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  if (buf.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (!width || !height) return null;
  return { width, height };
}

/* CRC32（PNG 的 tEXt 块需要）。不依赖 zlib.crc32：那个 API 在旧 Node 上没有。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 给每张截图加一个唯一的 tEXt 注释块。
 *
 * 为什么需要：docx 库会按图片字节去重 —— 两条变更如果落在同一个包围盒、
 * 云线也画在同一位置，合成图会逐字节相同，于是 Word 包里只存一份 media。
 * 语义上没错（每条变更仍有独立的 <w:drawing> 引用），但验收/排查时
 * “media 文件数 = 变更条数”更直观，也方便从 media 反查是哪一条变更。
 * tEXt 是 PNG 的标准辅助块，Word / LibreOffice 都会忽略它。
 */
function tagPng(data, text) {
  let offset = 8;
  while (offset + 12 <= data.length) {
    const len = data.readUInt32BE(offset);
    const type = data.toString("ascii", offset + 4, offset + 8);
    const next = offset + 12 + len;
    if (next > data.length) break;
    if (type === "IEND") {
      const keyword = Buffer.from("Comment", "latin1");
      const value = Buffer.from(text, "latin1");
      const payload = Buffer.concat([keyword, Buffer.from([0]), value]);
      const typeBuf = Buffer.from("tEXt", "ascii");
      const chunk = Buffer.alloc(12 + payload.length);
      chunk.writeUInt32BE(payload.length, 0);
      typeBuf.copy(chunk, 4);
      payload.copy(chunk, 8);
      chunk.writeUInt32BE(
        crc32(Buffer.concat([typeBuf, payload])),
        8 + payload.length
      );
      return Buffer.concat([
        data.subarray(0, offset),
        chunk,
        data.subarray(offset),
      ]);
    }
    offset = next;
  }
  return data;
}

function decodePng(raw, where, tag) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new ReportValidationError(`${where} 缺少截图`);
  }
  const comma = raw.indexOf(",");
  const base64 = comma >= 0 ? raw.slice(comma + 1) : raw;
  let data;
  try {
    data = Buffer.from(base64, "base64");
  } catch {
    throw new ReportValidationError(`${where} 的截图不是合法 base64`);
  }
  if (!data.length) {
    throw new ReportValidationError(`${where} 的截图为空`);
  }
  if (data.length > MAX_IMAGE_BYTES) {
    throw new ReportValidationError(`${where} 的截图超过 8MB`);
  }
  const size = pngSize(data);
  if (!size) {
    throw new ReportValidationError(`${where} 的截图不是有效 PNG`);
  }
  return {
    data: tagPng(data, `CADViewer compare report · change ${tag}`),
    width: size.width,
    height: size.height,
  };
}

/* ------------------------------------------------------------------ */
/* payload 归一化                                                      */
/* ------------------------------------------------------------------ */

function str(value, fallback = "", max = 300) {
  if (typeof value !== "string") return fallback;
  const s = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .trim();
  return s ? s.slice(0, max) : fallback;
}

function num(value, fallback = 0) {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function nonNegInt(value) {
  const n = Math.floor(num(value, 0));
  return n > 0 ? n : 0;
}

function bboxOf(value) {
  if (!Array.isArray(value) || value.length < 4) return null;
  const [x0, y0, x1, y1] = value.map((v) => Number(v));
  if (![x0, y0, x1, y1].every((v) => Number.isFinite(v))) return null;
  return [x0, y0, x1, y1];
}

function formatExtent(bbox) {
  if (!bbox) return "—";
  const w = bbox[2] - bbox[0];
  const h = bbox[3] - bbox[1];
  const fmt = (v) =>
    Math.abs(v) >= 1000
      ? Math.round(v).toLocaleString("zh-CN")
      : v.toFixed(2);
  return `${fmt(w)} × ${fmt(h)}`;
}

function formatPoint(bbox) {
  if (!bbox) return "—";
  const fmt = (v) =>
    Math.abs(v) >= 1000 ? Math.round(v).toLocaleString("zh-CN") : v.toFixed(3);
  return `(${fmt(bbox[0])}, ${fmt(bbox[1])}) → (${fmt(bbox[2])}, ${fmt(
    bbox[3]
  )})`;
}

function formatDateTime(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(
    date.getDate()
  )} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

function normalizePayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new ReportValidationError("报告请求体为空");
  }

  const baseName = str(payload.baseName, "基准图", 200);
  const targetName = str(payload.targetName, "对比图", 200);
  const createdAt = (() => {
    const d = new Date(payload.createdAt);
    return Number.isNaN(d.getTime()) ? new Date() : d;
  })();

  const rawOptions = payload.options || {};
  const compareProps = Array.isArray(rawOptions.compareProps)
    ? rawOptions.compareProps.map((p) => String(p)).slice(0, 8)
    : [];
  const options = {
    tolerance: num(rawOptions.tolerance, 0),
    compareProps,
    includeHatch: rawOptions.includeHatch === true,
  };

  const rawSummary = payload.summary || {};
  const summary = {
    added: nonNegInt(rawSummary.added),
    removed: nonNegInt(rawSummary.removed),
    modified: nonNegInt(rawSummary.modified),
    unchanged: nonNegInt(rawSummary.unchanged),
    notCompared: nonNegInt(rawSummary.notCompared),
    changeSets: nonNegInt(rawSummary.changeSets),
    elapsedMs: Math.max(0, num(rawSummary.elapsedMs, 0)),
    truncated: rawSummary.truncated === true,
  };

  const rawSets = Array.isArray(payload.sets) ? payload.sets : [];
  if (!rawSets.length) {
    throw new ReportValidationError("报告里没有变更集");
  }

  let changeTotal = 0;
  const sets = rawSets.map((rawSet, si) => {
    const name = str(rawSet?.name, `变更集 ${si + 1}`, 120);
    const rawChanges = Array.isArray(rawSet?.changes) ? rawSet.changes : [];
    const changes = rawChanges.map((rawChange, ci) => {
      const where = `「${name}」第 ${ci + 1} 条变更`;
      changeTotal++;
      if (changeTotal > MAX_CHANGES) {
        throw new ReportValidationError(
          `变更条数超过 ${MAX_CHANGES}，请分批导出`
        );
      }

      const kind = rawChange?.kind;
      if (kind !== "added" && kind !== "removed" && kind !== "modified") {
        throw new ReportValidationError(`${where} 的 kind 无效`);
      }
      const type = str(rawChange?.type, "实体", 60);
      const layer = str(rawChange?.layer, "—", 120);
      const handleRaw = rawChange?.handle;
      const handle =
        handleRaw == null || handleRaw === ""
          ? null
          : str(handleRaw, "", 60) || null;
      const image = decodePng(rawChange?.image, where, changeTotal);
      const note = str(
        rawChange?.note,
        `${KIND_LABEL[kind]} ${type}${handle ? `，句柄 #${handle}` : ""}`,
        400
      );

      return {
        type,
        layer,
        handle,
        kind,
        kindLabel: KIND_LABEL[kind],
        note,
        bbox: bboxOf(rawChange?.bbox),
        image,
      };
    });

    return {
      name,
      bbox: bboxOf(rawSet?.bbox),
      changes,
    };
  });

  return {
    baseName,
    targetName,
    createdAt,
    options,
    summary,
    sets,
    totalChanges: changeTotal,
  };
}

/* ------------------------------------------------------------------ */
/* docx 小零件                                                         */
/* ------------------------------------------------------------------ */

function run(text, opts = {}) {
  return new TextRun({
    text,
    font: opts.mono ? MONO : FONT,
    size: opts.size ?? 20,
    bold: opts.bold === true,
    color: opts.color ?? "1F2937",
    italics: opts.italics === true,
  });
}

function cell(text, opts = {}) {
  return new TableCell({
    width: opts.width
      ? { size: opts.width, type: WidthType.PERCENTAGE }
      : undefined,
    shading: opts.fill ? { fill: opts.fill, color: "auto" } : undefined,
    margins: { top: 55, bottom: 55, left: 100, right: 100 },
    children: [
      new Paragraph({
        alignment: opts.align,
        spacing: { before: 0, after: 0, line: 280 },
        children: [
          run(text, {
            bold: opts.bold,
            color: opts.color,
            mono: opts.mono,
            size: opts.size,
          }),
        ],
      }),
    ],
  });
}

function infoTable(rows) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: TABLE_BORDERS,
    rows: rows.map(
      ([leftLabel, leftValue, rightLabel, rightValue], index) =>
        new TableRow({
          children: [
            cell(leftLabel, {
              width: 14,
              bold: true,
              fill: "F8FAFC",
              color: "475569",
              size: 18,
            }),
            cell(leftValue, {
              width: 36,
              color: "111827",
              mono: index === 3,
            }),
            cell(rightLabel, {
              width: 14,
              bold: true,
              fill: "F8FAFC",
              color: "475569",
              size: 18,
            }),
            cell(rightValue, {
              width: 36,
              color: "111827",
            }),
          ],
        })
    ),
  });
}

function displaySize(image) {
  const maxW = 620;
  const maxH = 560;
  let width = Math.min(maxW, image.width);
  let height = (width * image.height) / image.width;
  if (height > maxH) {
    height = maxH;
    width = (height * image.width) / image.height;
  }
  return {
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
  };
}

function imageParagraph(image, alt) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 140, after: 100 },
    children: [
      new ImageRun({
        type: "png",
        data: image.data,
        transformation: displaySize(image),
        altText: {
          name: alt,
          title: alt,
          description: alt,
        },
      }),
    ],
  });
}

/* ------------------------------------------------------------------ */
/* 报告正文                                                            */
/* ------------------------------------------------------------------ */

function coverSection(report) {
  const { baseName, targetName, createdAt, options, summary, totalChanges } =
    report;
  const children = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 1600, after: 120 },
      children: [
        run("图纸对比报告", { size: 56, bold: true, color: "0F172A" }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 160 },
      children: [
        run("DRAWING COMPARISON REPORT", {
          size: 16,
          color: "9CA3AF",
          bold: true,
        }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 600 },
      children: [
        run(baseName, { size: 26, bold: true, color: "1F2937" }),
        run("   vs   ", { size: 20, color: "9CA3AF" }),
        run(targetName, { size: 26, bold: true, color: "1F2937" }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 240 },
      children: [
        run(`生成时间：${formatDateTime(createdAt)}`, {
          size: 19,
          color: "6B7280",
        }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 700 },
      children: [
        run(
          summary.truncated
            ? "注意：比对结果已达到服务端上限，报告只包含返回的变更"
            : "本报告按变更集分章，逐条附截图与云线标注",
          { size: 18, color: summary.truncated ? "B45309" : "9CA3AF" }
        ),
      ],
    }),
  ];

  // 图纸对 / 参数
  children.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: TABLE_BORDERS,
      rows: [
        [cell("基准图", { width: 22, bold: true, fill: "F8FAFC", color: "475569" }),
         cell(baseName, { width: 78, color: "111827" })],
        [cell("对比图", { width: 22, bold: true, fill: "F8FAFC", color: "475569" }),
         cell(targetName, { width: 78, color: "111827" })],
        [cell("生成时间", { width: 22, bold: true, fill: "F8FAFC", color: "475569" }),
         cell(formatDateTime(createdAt), { width: 78, color: "111827" })],
        [cell("比对容差", { width: 22, bold: true, fill: "F8FAFC", color: "475569" }),
         cell(String(options.tolerance), { width: 78, color: "111827", mono: true })],
        [cell("比对属性", { width: 22, bold: true, fill: "F8FAFC", color: "475569" }),
         cell(
           options.compareProps.length
             ? options.compareProps
                 .map((p) => PROP_LABEL[p] || p)
                 .join(" / ")
             : "仅几何",
           { width: 78, color: "111827" }
         )],
        [cell("包含填充", { width: 22, bold: true, fill: "F8FAFC", color: "475569" }),
         cell(options.includeHatch ? "是" : "否", { width: 78, color: "111827" })],
      ].map(
        (cells) =>
          new TableRow({
            children: cells,
          })
      ),
    })
  );

  // 统计表
  children.push(
    new Paragraph({
      spacing: { before: 360, after: 140 },
      children: [run("变更统计", { size: 24, bold: true, color: "0F172A" })],
    })
  );

  const statHeader = ["变更总数", "新增", "删除", "修改"].map((label) =>
    cell(label, {
      width: 25,
      bold: true,
      fill: "F3F4F6",
      color: "374151",
      align: AlignmentType.CENTER,
      size: 18,
    })
  );
  const statValues = [
    { text: String(totalChanges), color: "111827" },
    { text: String(summary.added), color: KIND_COLOR.added },
    { text: String(summary.removed), color: KIND_COLOR.removed },
    { text: String(summary.modified), color: KIND_COLOR.modified },
  ].map((v) =>
    cell(v.text, {
      width: 25,
      bold: true,
      color: v.color,
      align: AlignmentType.CENTER,
      size: 28,
    })
  );

  children.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: TABLE_BORDERS,
      rows: [new TableRow({ children: statHeader }), new TableRow({ children: statValues })],
    })
  );

  children.push(
    new Paragraph({
      spacing: { before: 180, after: 0 },
      children: [
        run(
          `共 ${totalChanges} 条变更，${report.sets.length} 个变更集；未变更 ${summary.unchanged} 条，未参与比对 ${summary.notCompared} 条。`,
          { size: 18, color: "6B7280" }
        ),
      ],
    })
  );

  children.push(new Paragraph({ children: [new PageBreak()] }));
  return children;
}

function setParagraphs(set, index) {
  const children = [];
  if (index > 0) {
    children.push(new Paragraph({ children: [new PageBreak()] }));
  }

  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 0, after: 120 },
      children: [run(set.name, { size: 32, bold: true, color: "0F172A" })],
    })
  );

  const counts = { added: 0, removed: 0, modified: 0 };
  for (const c of set.changes) counts[c.kind]++;
  const countRuns = [run("共 ", { size: 19, color: "475569" })];
  countRuns.push(run(String(set.changes.length), { size: 22, bold: true, color: "111827" }));
  countRuns.push(run(" 条：", { size: 19, color: "475569" }));
  for (const kind of ["added", "removed", "modified"]) {
    if (!counts[kind]) continue;
    countRuns.push(
      run(`${KIND_LABEL[kind]} `, { size: 19, color: KIND_COLOR[kind], bold: true }),
      run(`${counts[kind]}  `, { size: 19, color: KIND_COLOR[kind] })
    );
  }
  children.push(
    new Paragraph({
      spacing: { after: 80 },
      children: countRuns,
    })
  );

  if (set.bbox) {
    children.push(
      new Paragraph({
        spacing: { after: 160 },
        children: [
          run(`范围（WCS）：${formatExtent(set.bbox)}`, {
            size: 17,
            color: "6B7280",
          }),
        ],
      })
    );
  }

  set.changes.forEach((change, ci) => {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        keepNext: true,
        spacing: { before: 240, after: 100 },
        children: [
          run(`${ci + 1}. ${change.kindLabel} · ${change.type}`, {
            size: 24,
            bold: true,
            color: KIND_COLOR[change.kind],
          }),
        ],
      })
    );

    children.push(
      infoTable([
        ["类型", change.type, "变更种类", change.kindLabel],
        ["图层", change.layer || "—", "句柄", change.handle ? `#${change.handle}` : "—"],
      ])
    );

    children.push(
      imageParagraph(
        change.image,
        `${set.name} 第 ${ci + 1} 条：${change.kindLabel} ${change.type}`
      )
    );

    children.push(
      new Paragraph({
        spacing: { after: 60 },
        children: [
          run("说明：", { bold: true, size: 19, color: "374151" }),
          run(change.note, { size: 19, color: "1F2937" }),
        ],
      })
    );

    if (change.bbox) {
      children.push(
        new Paragraph({
          spacing: { after: 0 },
          children: [
            run(`包围盒（WCS）：${formatPoint(change.bbox)}`, {
              size: 16,
              color: "9CA3AF",
            }),
          ],
        })
      );
    }
  });

  return children;
}

/**
 * 生成 docx 并返回 Buffer。
 * @param {unknown} payload 前端 POST /api/compare/report 的 JSON
 * @returns {Promise<{ buffer: Buffer, fileName: string, normalized: object }>}
 */
export async function buildCompareReport(payload) {
  const report = normalizePayload(payload);
  const fileName = buildReportFileName(
    report.baseName,
    report.targetName,
    report.createdAt
  );

  const children = coverSection(report);
  report.sets.forEach((set, index) => {
    children.push(...setParagraphs(set, index));
  });

  const footer = new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 0 },
        children: [
          new TextRun({
            text: "第 ",
            font: FONT,
            size: 17,
            color: "6B7280",
          }),
          new TextRun({
            children: [PageNumber.CURRENT],
            font: FONT,
            size: 17,
            color: "6B7280",
          }),
          new TextRun({
            text: " 页 / 共 ",
            font: FONT,
            size: 17,
            color: "6B7280",
          }),
          new TextRun({
            children: [PageNumber.TOTAL_PAGES],
            font: FONT,
            size: 17,
            color: "6B7280",
          }),
          new TextRun({
            text: " 页",
            font: FONT,
            size: 17,
            color: "6B7280",
          }),
        ],
      }),
    ],
  });

  const doc = new Document({
    creator: "CADViewer",
    title: `图纸对比报告 - ${report.baseName} vs ${report.targetName}`,
    description: "CADViewer 图纸对比报告",
    styles: {
      default: {
        document: {
          run: { font: FONT, size: 20, color: "1F2937" },
          paragraph: { spacing: { line: 300, after: 100 } },
        },
        heading1: {
          run: { font: FONT, size: 32, bold: true, color: "0F172A" },
          paragraph: { spacing: { before: 240, after: 160 } },
        },
        heading2: {
          run: { font: FONT, size: 24, bold: true, color: "111827" },
          paragraph: { spacing: { before: 240, after: 100 } },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: {
              width: convertMillimetersToTwip(210),
              height: convertMillimetersToTwip(297),
            },
            margin: {
              top: convertMillimetersToTwip(20),
              right: convertMillimetersToTwip(20),
              bottom: convertMillimetersToTwip(20),
              left: convertMillimetersToTwip(20),
            },
          },
        },
        footers: { default: footer },
        children,
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  return { buffer, fileName, normalized: report };
}
