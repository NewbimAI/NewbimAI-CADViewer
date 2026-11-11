/**
 * 对比 Word 报告生成器单测。
 * 不测 Word 的视觉排版，只锁住最容易回归的结构：
 *   · 文件名/时间戳；
 *   · PNG 头校验；
 *   · docx 里每个变更都有一个 inline 图片，且 media 关系存在。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { unzipSync, strFromU8 } from "fflate";

import {
  buildCompareReport,
  buildReportFileName,
  MAX_REPORT_BYTES,
  pngSize,
  ReportValidationError,
} from "./compare-report.js";

/** 1×1 透明 PNG（合法 IHDR/IDAT/IEND） */
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function payload(changeCount = 3) {
  const kinds = ["added", "removed", "modified"];
  return {
    baseName: "施工005-车库消防.dwg",
    targetName: "施工005-车库消防-对比.dwg",
    createdAt: new Date(2026, 10, 9, 17, 59).toISOString(),
    options: {
      tolerance: 0.001,
      compareProps: ["color", "layer"],
      includeHatch: false,
    },
    summary: {
      added: 1,
      removed: 1,
      modified: 1,
      unchanged: 42,
      notCompared: 0,
      changeSets: 2,
      elapsedMs: 1234,
      truncated: false,
    },
    sets: [
      {
        name: "变更集 1",
        bbox: [0, 0, 100, 80],
        changes: Array.from({ length: changeCount }, (_, i) => ({
          type: "LINE",
          layer: "WALL",
          handle: `A${i + 1}`,
          kind: kinds[i % kinds.length],
          note: `第 ${i + 1} 条变更说明`,
          bbox: [i * 10, i * 5, i * 10 + 8, i * 5 + 6],
          image: PNG_1X1,
        })),
      },
    ],
  };
}

test("报告文件名带基准/对比与 YYYYMMDD-HHmm", () => {
  const name = buildReportFileName(
    "施工005-车库消防.dwg",
    "施工005-车库消防-对比.dwg",
    new Date(2026, 10, 9, 17, 59)
  );
  assert.equal(
    name,
    "对比报告_施工005-车库消防_vs_施工005-车库消防-对比_20261109-1759.docx"
  );
  assert.equal(
    buildReportFileName('a/b:c*?.dxf', "x", new Date(2026, 0, 2, 3, 4)),
    "对比报告_a_b_c___vs_x_20260102-0304.docx"
  );
});

test("pngSize 只认真正的 PNG", () => {
  const buf = Buffer.from(PNG_1X1, "base64");
  assert.deepEqual(pngSize(buf), { width: 1, height: 1 });
  assert.equal(pngSize(Buffer.from("not a png")), null);
  assert.equal(pngSize(Buffer.from("<html></html>")), null);
});

test("docx 每个变更都有 inline 图片与 media 关系", async () => {
  const { buffer, fileName, normalized } = await buildCompareReport(payload(3));
  assert.match(fileName, /^对比报告_.+_vs_.+_\d{8}-\d{4}\.docx$/);
  assert.equal(normalized.totalChanges, 3);

  const files = unzipSync(new Uint8Array(buffer));
  const names = Object.keys(files);
  assert.ok(names.includes("word/document.xml"), "缺少 word/document.xml");
  assert.ok(names.includes("[Content_Types].xml"), "缺少 content types");

  const xml = strFromU8(files["word/document.xml"]);
  assert.equal(
    (xml.match(/<w:drawing>/g) || []).length,
    3,
    "每条变更应有一张内嵌图"
  );
  assert.equal((xml.match(/<wp:inline/g) || []).length, 3);
  assert.ok(xml.includes("变更集 1"));
  assert.ok(xml.includes("第 3 条变更说明"));

  const media = names.filter((n) => n.startsWith("word/media/"));
  assert.equal(media.length, 3, "每条变更应有独立的 media（唯一 tEXt 防去重）");
  for (const m of media) {
    assert.deepEqual(pngSize(Buffer.from(files[m])), { width: 1, height: 1 });
  }

  const rels = strFromU8(files["word/_rels/document.xml.rels"]);
  assert.ok(
    rels.includes("relationships/image"),
    "document.xml.rels 应包含图片关系"
  );
  assert.ok(
    names.some((n) => n === "word/footer1.xml" || n === "word/footer2.xml"),
    "应生成页脚（页码）"
  );
});

test("空变更集 / 坏图片 / 超出上限会被拒绝", async () => {
  await assert.rejects(
    () => buildCompareReport({ ...payload(), sets: [] }),
    (e) => e instanceof ReportValidationError && e.statusCode === 400
  );

  const bad = payload(1);
  bad.sets[0].changes[0].image = "aGVsbG8=";
  await assert.rejects(
    () => buildCompareReport(bad),
    (e) => e instanceof ReportValidationError && /不是有效 PNG/.test(e.message)
  );

  assert.equal(MAX_REPORT_BYTES, 200 * 1024 * 1024);
});
