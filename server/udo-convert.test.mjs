/**
 * `server/udo-convert.js` 的测试（v54：TDb 类名匹配 + probe 预筛）。
 *
 * 覆盖四条硬要求：
 *   1. 没检测到自定义对象（dump 里没有 decoded 洞口 / 坏 dump / 没有 dump）→ **一个字节都不动**；
 *   2. `status=decoded` 的 `TDbOpening`（`TCH_OPENING` / `AEC_OPENING`）→ 注入闭合
 *      LWPOLYLINE，保留图层，句柄按全文件最大值往后排；
 *   3. `TCH_*` 与 `AEC_*` 归一后走同一分支（机柜图是 `AEC_KERNAL` 注册的 `AEC_*`）；
 *   4. 任何异常输入（null / 字符串 / 缺字段 / NaN 坐标 / 坏 DXF / probe 失败）都不得
 *      抛异常、不得改坏文件（probe 失败回退字节预筛）。
 *
 * 运行：node --test server/udo-convert.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  detectUdo,
  decodeUdo,
  injectUdoGeometry,
  loadUdoDump,
  openingFrame,
  openingQuad,
  wallFaces,
  doorSymbol,
  doorSymbols,
  classifyOpening,
  doorTypeOf,
  arcPolyline,
  connectWallFaces,
  trimWallFacesAtOpenings,
  closeWallEnds,
  headerTextSize,
  textHeightOf,
  formatDimensionLabel,
  DIM_TEXT_OFFSET_K,
  persistUdoDump,
  parseProbeOutput,
  probeUdoDwg,
  resolveUdoCli,
  summarizeUdo,
  udoKindOf,
  udoEnabled,
  UDO_MAX_ENTITIES,
  originShift,
  localizeEntity,
  udoDumpNeedsRefresh,
} from "./udo-convert.js";
import { buildWebDxf, DXF_WEB_VERSION } from "./dxf-web.js";

/* ───────────────────────────── fixtures ───────────────────────────── */

/** 一个合法的洞口（施工005 实测样本：A-DOOR 上的 1100×200 门洞） */
function openingEntity(over = {}) {
  return {
    handle: "4ADE2",
    class: "TCH_OPENING",
    layer: "A-DOOR",
    raw_len: 263,
    decode: {
      class: "TCH_OPENING",
      kind: "opening",
      status: "decoded",
      opening: {
        x: 11149.996921167476,
        y: 10800.005087452966,
        z: 0,
        width: 1100,
        half_thickness: 100,
        height: 2100,
        rotation: Math.PI,
        direction: [-1, 0],
        normal: [0, -1],
        wall_face_segments: [
          [
            [11699.996921167476, 10700.005087452966],
            [10599.996921167476, 10700.005087452966],
          ],
          [
            [11699.996921167476, 10900.005087452966],
            [10599.996921167476, 10900.005087452966],
          ],
        ],
      },
    },
    ...over,
  };
}

/** 同 openingEntity，但按门/窗判据需要改洞口尺寸/底标高/图层。 */
function openingOf({ layer = "A-DOOR", width = 1100, height = 2100, z = 0 } = {}) {
  const e = openingEntity();
  e.layer = layer;
  const opening = { ...e.decode.opening, width, height, z };
  /* 测试要按 width 反算局部坐标系；fixture 的 wall_face_segments 固定 1100 宽，
   * 留着会让 openingFrame 优先用旧面线。 */
  delete opening.wall_face_segments;
  e.decode = { ...e.decode, opening };
  return e;
}

/** dump 的 `data`（schema_version 1 的 data 段） */
function dumpData(entities) {  return {
    file: "fixture.dwg",
    dwg_version: "AC1018",
    entity_count: 10,
    udo_class_count: 2,
    counts: { TCH_OPENING: entities.length, TCH_WALL: 3 },
    stats: { udo_entities: entities.length + 3 },
    entities,
  };
}

/** 一条墙体（施工005 实测样本：WALL 层，中心线 2700 长，左 100 / 右 80） */
function wallEntity(over = {}) {
  return {
    handle: "4ADD7",
    class: "TCH_WALL",
    layer: "WALL",
    raw_len: 260,
    decode: {
      class: "TCH_WALL",
      kind: "wall",
      status: "decoded",
      bit_offset: 726,
      variant: "datamap_segment",
      wall: {
        start: [18649.993647117633, 14300.005091114796, 0],
        end: [21349.993647117633, 14300.005091114796, 0],
        length: 2700,
        left_offset: 100,
        right_offset: 80,
        thickness: 180,
        height: 3000,
      },
    },
    ...over,
  };
}

/** 一条文字（实测样本：GBK 已解好的中文，带插入点；字高由图纸兜底） */
function textEntity(over = {}, textOver = {}) {  return {
    handle: "702",
    class: "TCH_TEXT",
    layer: "地库增加范围",
    raw_len: 136,
    decode: {
      class: "TCH_TEXT",
      kind: "text",
      status: "decoded",
      bit_offset: 816,
      variant: "datamap_text",
      probes: 13,
      saw_position: true,
      text: {
        position: [1127907.41132688, 8505.822967631262, 0],
        content: "车库减小范围",
        charset: "gbk",
        ...textOver,
      },
    },
    ...over,
  };
}

/** 一条天正标注链（实测样本：G-GRID-DIMS 上 112060 轴网尺寸，样式 _TCH_ARCH&&150、
 *  字高 446.25、dec=0、无后缀；段数超过 2 的链在页面里很常见）。 */
function dimensionEntity(over = {}, dimOver = {}) {
  return {
    handle: "13821",
    class: "TCH_DIMENSION2",
    cpp_class: "TDbDimension2",
    layer: "G-GRID-DIMS",
    raw_len: 140,
    decode: {
      class: "TCH_DIMENSION2",
      kind: "dimension",
      status: "decoded",
      bit_offset: 704,
      variant: "dimension2",
      saw_position: true,
      dimension: {
        p1: [7200, 12016.55, 0],
        angle: Math.PI / 2,
        style: {
          name: "_TCH_ARCH&&150",
          text_height: 446.25,
          arrow_size: 150,
          postfix: "",
          dec: 0,
          scale: 1,
          measurement_factor: 1,
          resolved: true,
        },
        segments: [
          { value: 1000, p1: [7200, 12016.55], p2: [7200, 13016.55], text: "1000" },
          { value: 16000, p1: [7200, 13016.55], p2: [7200, 29016.55], text: "16000" },
        ],
        ...dimOver,
      },
    },
    ...over,
  };
}

/** 最小可解析 DXF：LAYER(A-DOOR,4) + 一条 LINE(5=E1) + ENTITIES 结尾。
 *  `textSize` 给了就写进 HEADER 的 `$TEXTSIZE`（文字字高的兜底来源）。 */
function dxfFixture(textSize = null) {
  return [
    ...(textSize
      ? ["0", "SECTION", "2", "HEADER", "9", "$TEXTSIZE", "40", String(textSize), "0", "ENDSEC"]
      : []),
    "0", "SECTION", "2", "TABLES",
    "0", "TABLE", "2", "LAYER",
    "0", "LAYER", "2", "0", "70", "0", "62", "7",
    "0", "LAYER", "2", "A-DOOR", "70", "0", "62", "4",
    "0", "LAYER", "2", "WALL", "70", "0", "62", "7",
    "0", "LAYER", "2", "地库增加范围", "70", "0", "62", "7",
    "0", "LAYER", "2", "G-GRID-DIMS", "70", "0", "62", "3",
    "0", "LAYER", "2", "PUB_DIM", "70", "0", "62", "1",
    "0", "ENDTAB", "0", "ENDSEC",
    "0", "SECTION", "2", "ENTITIES",
    "0", "LINE", "5", "E1", "8", "0", "10", "0", "20", "0", "11", "1", "21", "0",
    "0", "ENDSEC",
    "0", "SECTION", "2", "BLOCKS",
    "0", "ENDSEC",
    "0", "EOF", "",
  ].join("\n");
}

/** 解析 DXF 文本里的实体（只取 0 组码分段的组码对） */
function entitiesOf(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let cur = null;
  let sec = null;
  let pendingSec = false;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const c = lines[i].trim();
    const v = lines[i + 1].trim();
    if (c === "0") {
      if (cur) out.push(cur);
      cur = null;
      if (v === "SECTION") {
        pendingSec = true;
        continue;
      }
      if (v === "ENDSEC") {
        sec = null;
        continue;
      }
      if (sec === "ENTITIES") cur = { type: v, pairs: [] };
      continue;
    }
    if (pendingSec && c === "2") {
      sec = v;
      pendingSec = false;
      continue;
    }
    if (cur) cur.pairs.push([c, v]);
  }
  if (cur) out.push(cur);
  return out;
}

const pair = (e, code) => e.pairs.find(([c]) => c === code)?.[1] ?? null;
const allPairs = (e, code) => e.pairs.filter(([c]) => c === code).map(([, v]) => v);

/* ───────────────────────────── 开关 / 二进制 ───────────────────────────── */

test("resolveUdoCli：CADVIEWER_UDO_CLI → bin/udo-cli → bin/tch-cli（过渡）→ target/release", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "udo-cli-"));
  const exe = process.platform === "win32" ? "udo-cli.exe" : "udo-cli";
  const legacyExe = process.platform === "win32" ? "tch-cli.exe" : "tch-cli";
  const fake = path.join(dir, exe);
  fs.writeFileSync(fake, "");
  const saved = {
    CADVIEWER_UDO_CLI: process.env.CADVIEWER_UDO_CLI,
    CADVIEWER_TCH_CLI: process.env.CADVIEWER_TCH_CLI,
    UDO_CLI: process.env.UDO_CLI,
  };
  delete process.env.CADVIEWER_UDO_CLI;
  delete process.env.CADVIEWER_TCH_CLI;
  delete process.env.UDO_CLI;
  try {
    // PATH 上没有 udo-cli，空目录应当解析不到
    assert.equal(resolveUdoCli(dir), null, "空目录里没有 udo-cli");
    const oldBin = path.join(dir, "bin", "tch-cli");
    fs.mkdirSync(oldBin, { recursive: true });
    fs.copyFileSync(fake, path.join(oldBin, legacyExe));
    assert.equal(resolveUdoCli(dir), path.join(oldBin, legacyExe), "bin/tch-cli 是过渡期回退");
    const binDir = path.join(dir, "bin", "udo-cli");
    fs.mkdirSync(binDir, { recursive: true });
    fs.copyFileSync(fake, path.join(binDir, exe));
    assert.equal(resolveUdoCli(dir), path.join(binDir, exe), "bin/udo-cli 是正式位置");

    process.env.UDO_CLI = fake;
    assert.equal(resolveUdoCli(dir), fake, "UDO_CLI 优先");
    process.env.CADVIEWER_UDO_CLI = fake;
    assert.equal(resolveUdoCli(dir), fake, "CADVIEWER_UDO_CLI 优先");
    delete process.env.CADVIEWER_UDO_CLI;
    delete process.env.UDO_CLI;
    process.env.CADVIEWER_TCH_CLI = fake;
    assert.equal(resolveUdoCli(dir), fake, "旧名 CADVIEWER_TCH_CLI 过渡期仍生效");
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test("udoEnabled：旧名 CADVIEWER_TCH=0 仍能关闭，并只 warn 一次", () => {
  const savedUdo = process.env.CADVIEWER_UDO;
  const savedTch = process.env.CADVIEWER_TCH;
  const warns = [];
  const original = console.warn;
  delete process.env.CADVIEWER_UDO;
  process.env.CADVIEWER_TCH = "0";
  console.warn = (msg) => warns.push(String(msg));
  try {
    assert.equal(udoEnabled(), false, "旧名应当生效");
    assert.equal(udoEnabled(), false);
    assert.equal(warns.length, 1, "弃用提示只打一次");
    assert.match(warns[0], /CADVIEWER_TCH.*CADVIEWER_UDO/);
  } finally {
    console.warn = original;
    if (savedUdo === undefined) delete process.env.CADVIEWER_UDO;
    else process.env.CADVIEWER_UDO = savedUdo;
    if (savedTch === undefined) delete process.env.CADVIEWER_TCH;
    else process.env.CADVIEWER_TCH = savedTch;
  }
});

test("parseProbeOutput：包装对象/裸对象/ok:false/坏 JSON 都按契约处理", () => {
  const wrapped = parseProbeOutput(
    JSON.stringify({
      schema_version: 1,
      ok: true,
      data: {
        has_udo_classes: true,
        class_count: 46,
        entity_count: 41683,
        dwg_version: "AC1018",
      },
    })
  );
  assert.deepEqual(wrapped, {
    hasUdoClasses: true,
    classCount: 46,
    entityCount: 41683,
    dwgVersion: "AC1018",
  });

  const bare = parseProbeOutput(JSON.stringify({ has_udo_classes: false }));
  assert.equal(bare.hasUdoClasses, false);

  // 旧版二进制（0.3.0 之前）输出字段名是 has_tch_classes：过渡期仍接受
  const legacy = parseProbeOutput(JSON.stringify({ has_tch_classes: true, class_count: 3 }));
  assert.equal(legacy.hasUdoClasses, true);
  assert.equal(legacy.classCount, 3);

  assert.equal(parseProbeOutput('{"schema_version":1,"ok":false,"error":{}}'), null);
  assert.equal(parseProbeOutput("not json"), null);
  assert.equal(parseProbeOutput(""), null);
  assert.equal(parseProbeOutput(null), null);
});

test("probeUdoDwg：优先用 udo-cli probe（AEC_* 机柜图没有 TCH_ 字节也能命中）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "udo-probe-ok-"));
  const dwg = path.join(dir, "cabinet.dwg");
  fs.writeFileSync(dwg, Buffer.alloc(4096, 0x20)); // 字节预筛一定不命中
  let calls = 0;
  let seenPath = null;
  const found = await probeUdoDwg(dwg, {
    runProbe: async (_cli, dwgPath) => {
      calls++;
      seenPath = dwgPath;
      return {
        stdout: JSON.stringify({
          schema_version: 1,
          ok: true,
          data: {
            has_udo_classes: true,
            class_count: 4,
            entity_count: 123,
            dwg_version: "AC1018",
          },
        }),
      };
    },
  });
  assert.equal(found, true, "probe 说有 TDb 类 → 命中（不看字节）");
  assert.equal(calls, 1);
  assert.equal(seenPath, dwg);
});

test("probeUdoDwg：子命令不存在/退出码非 0/坏 JSON → 回退字节预筛", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "udo-probe-fallback-"));
  const hit = path.join(dir, "hit.dwg");
  const clean = path.join(dir, "clean.dwg");
  fs.writeFileSync(hit, "AC1018 ... TCH_WALL ...");
  fs.writeFileSync(clean, Buffer.alloc(4096, 0x20));

  const failures = [
    { name: "旧二进制没有 probe（usage + 非零退出）", run: async () => ({ error: "unknown command", code: 2, stdout: "usage: udo-cli dump ..." }) },
    { name: "probe 运行失败（ok:false）", run: async () => ({ code: 3, stdout: '{"schema_version":1,"ok":false,"error":{"code":"dwg_read_failed"}}' }) },
    { name: "输出不是 JSON", run: async () => ({ code: 0, stdout: "TCH entities 525" }) },
    { name: "spawn 抛异常", run: async () => { throw new Error("spawn ENOENT"); } },
  ];
  for (const c of failures) {
    assert.equal(await probeUdoDwg(hit, { runProbe: c.run }), true, `${c.name} → 字节命中`);
    assert.equal(await probeUdoDwg(clean, { runProbe: c.run }), false, `${c.name} → 字节未命中`);
  }

  // 连可执行文件都没有：同样回退
  const noCli = path.join(dir, "no-such-udo-cli");
  assert.equal(await probeUdoDwg(hit, { cli: noCli }), true);
  assert.equal(await probeUdoDwg(clean, { cli: noCli }), false);
});

test("probeUdoDwg：CADVIEWER_UDO=force 跳过 probe 与字节预筛", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "udo-probe-force-"));
  const clean = path.join(dir, "clean.dwg");
  fs.writeFileSync(clean, Buffer.alloc(1024, 0x20));
  const prev = process.env.CADVIEWER_UDO;
  let called = false;
  try {
    process.env.CADVIEWER_UDO = "force";
    const found = await probeUdoDwg(clean, {
      runProbe: async () => {
        called = true;
        return { stdout: '{"has_udo_classes":false}' };
      },
    });
    assert.equal(found, true, "force 语义保持不变");
    assert.equal(called, false, "force 时连 probe 都不跑");
  } finally {
    if (prev === undefined) delete process.env.CADVIEWER_UDO;
    else process.env.CADVIEWER_UDO = prev;
  }
});

test("decodeUdo：非 DWG / 不存在 / 无二进制 → ok:false，绝不抛", async () => {
  const notDwg = await decodeUdo("C:/nope/fixture.dxf");
  assert.equal(notDwg.ok, false);
  const missing = await decodeUdo(path.join(os.tmpdir(), "definitely-missing-9f3a.dwg"), {
    cli: path.join(os.tmpdir(), "no-such-udo-cli"),
  });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /udo-cli/);
  const noCli = await decodeUdo(path.join(os.tmpdir(), "x.dwg"), { root: os.tmpdir() });
  assert.equal(noCli.ok, false);
});

/* ───────────────────────────── 检测 ───────────────────────────── */

test("detectUdo：非 DWG 一律不检出；meta.json 里已有类名时不再跑进程", async () => {
  assert.equal((await detectUdo("a.dxf")).detected, false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "udo-meta-"));
  const dwg = path.join(dir, "a.dwg");
  fs.writeFileSync(dwg, "AC1018");
  const metaPath = path.join(dir, "meta.json");
  fs.writeFileSync(
    metaPath,
    JSON.stringify({
      udo: { level: "objects", classes: ["TCH_OPENING"], entities: 525, decoded: 525 },
    })
  );
  const det = await detectUdo(dwg, { metaPath, cli: "does-not-exist" });
  assert.equal(det.detected, true);
  assert.equal(det.source, "meta");
  assert.equal(det.entities, 525);
  assert.equal(det.decoded, 525);
  assert.deepEqual(det.classes, ["TCH_OPENING"]);
});

test("detectUdo：没有自定义对象痕迹的 DWG 直接返回未检出（不启动子进程）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "udo-none-"));
  const dwg = path.join(dir, "plain.dwg");
  fs.writeFileSync(dwg, Buffer.alloc(4096, 0x20));
  const det = await detectUdo(dwg, { cli: "does-not-exist" });
  assert.equal(det.detected, false);
  assert.equal(det.entities, 0);
  assert.equal(det.source, "none");
});

test("summarizeUdo：类名/实体数/decoded 计数", () => {
  const entities = [
    openingEntity(),
    openingEntity({ handle: "4ADE3" }),
    { handle: "1", class: "TCH_WALL", layer: "WALL", decode: { status: "not_found" } },
  ];
  const sum = summarizeUdo(dumpData(entities));
  assert.deepEqual(sum.classes.sort(), ["TCH_OPENING", "TCH_WALL"]);
  assert.equal(sum.entities, 6, "用 stats.udo_entities（含未解码的墙体）");
  assert.equal(sum.detected, true);
  assert.equal(sum.decoded, 2);
  assert.equal(sum.classCount, 2);
});

/* ───────────────────────────── 几何 ───────────────────────────── */

test("openingQuad：wall_face_segments 转成不自交矩形；缺字段时按中心/旋转/宽反算", () => {
  const o = openingEntity().decode.opening;
  const quad = openingQuad(o);
  assert.equal(quad.length, 4);
  // 1100 × 200 的矩形：对角线 2√(550²+100²)
  const diag = Math.hypot(quad[2][0] - quad[0][0], quad[2][1] - quad[0][1]);
  assert.ok(Math.abs(diag - 2 * Math.hypot(550, 100)) < 1e-6, `对角线 ${diag}`);
  // 相邻边应互相垂直（不自交的矩形）
  const e1 = [quad[1][0] - quad[0][0], quad[1][1] - quad[0][1]];
  const e2 = [quad[2][0] - quad[1][0], quad[2][1] - quad[1][1]];
  assert.ok(Math.abs(e1[0] * e2[0] + e1[1] * e2[1]) < 1e-6, "相邻边垂直");

  const noFaces = { ...o, wall_face_segments: null };
  const q2 = openingQuad(noFaces);
  assert.equal(q2.length, 4);
  assert.ok(Math.abs(q2[0][0] - quad[0][0]) < 1e-6 && Math.abs(q2[0][1] - quad[0][1]) < 1e-6);

  assert.equal(openingQuad({ ...o, width: 0, wall_face_segments: null }), null);
  assert.equal(openingQuad(null), null);
});

/* ───────────────────────────── 类名归一（TCH_* / AEC_*） ───────────────────────────── */

test("udoKindOf：TCH_* 与 AEC_* 映射到同一分支；C++ 类名优先", () => {
  for (const [cls, kind] of [
    ["TCH_WALL", "wall"],
    ["AEC_WALL", "wall"],
    ["TCH_OPENING", "opening"],
    ["AEC_OPENING", "opening"],
    ["TCH_TEXT", "text"],
    ["AEC_TEXT", "text"],
    ["TCH_MTEXT", "text"],
    ["AEC_MTEXT", "text"],
  ]) {
    assert.equal(udoKindOf({ class: cls }), kind, cls);
  }
  // 不认识的类不注入
  assert.equal(udoKindOf({ class: "TCH_ARROW" }), null);
  assert.equal(udoKindOf({ class: "AEC_DOOR" }), null);
  assert.equal(udoKindOf({}), null);
  assert.equal(udoKindOf(null), null);
  // 有 C++ 名时按 TDb* 判定：Autodesk Architecture 的 AecDbWall 不是天正
  assert.equal(udoKindOf({ class: "AEC_WALL", cpp_class: "TDbWall" }), "wall");
  assert.equal(udoKindOf({ class: "AEC_WALL", cpp_class: "AecDbWall" }), null);
  assert.equal(udoKindOf({ class: "TCH_WALL", cpp_class: "AecDbWall" }), null);
  // 新 dump 一定带 decode.kind；类名不认识时作为最后兜底
  assert.equal(udoKindOf({ class: "SOMETHING_NEW", decode: { kind: "wall" } }), "wall");
});

test("注入：手写最小 dump 把 TCH_WALL 改成 AEC_WALL → 注入同样数量的墙", () => {
  const opts = { startHandle: 0x300, layers: new Set(["0", "WALL"]) };
  const udo = dumpData([wallEntity()]);
  const aec = JSON.parse(JSON.stringify(udo));
  aec.entities[0].class = "AEC_WALL";
  aec.entities[0].decode.class = "AEC_WALL";

  const a = injectUdoGeometry(dxfFixture(), udo, opts);
  const b = injectUdoGeometry(dxfFixture(), aec, opts);
  assert.equal(b.byKind.wall, 1);
  assert.equal(b.byKind.wall, a.byKind.wall, "墙数量一致");
  assert.equal(b.primitivesByKind.wall, a.primitivesByKind.wall, "墙面线/封口数量一致");
  assert.equal(b.text, a.text, "输出逐字节一致");
});

test("注入：AEC_OPENING / AEC_TEXT 与 TCH_* 走同一分支（三类混合）", () => {
  const opts = {
    startHandle: 0x500,
    layers: new Set(["0", "A-DOOR", "WALL", "地库增加范围"]),
  };
  const udo = dumpData([openingEntity(), wallEntity(), textEntity()]);
  const aec = JSON.parse(JSON.stringify(udo));
  for (const e of aec.entities) {
    if (typeof e.class === "string") e.class = e.class.replace(/^TCH_/, "AEC_");
    if (e.decode && typeof e.decode.class === "string") {
      e.decode.class = e.decode.class.replace(/^TCH_/, "AEC_");
    }
  }

  const a = injectUdoGeometry(dxfFixture(150), udo, opts);
  const b = injectUdoGeometry(dxfFixture(150), aec, opts);
  assert.deepEqual(b.byKind, a.byKind);
  assert.deepEqual(b.primitivesByKind, a.primitivesByKind);
  assert.equal(b.injected, 3);
  assert.equal(b.text, a.text, "AEC_* 伪装与 TCH_* 输出逐字节一致");
});

/* ───────────────────────────── 注入：不该动的一律不动 ───────────────────────────── */

test("未检测到自定义对象：没有 dump / 空 dump / 全是 not_found → 原字符串逐字节不变", () => {
  const src = dxfFixture();
  const variants = [
    undefined,
    null,
    {},
    { ok: true, data: { entities: [] } },
    { entities: null },
    "not an object",
    dumpData([{ handle: "1", class: "TCH_OPENING", decode: { status: "not_found" } }]),
    dumpData([{ handle: "2", class: "TCH_WALL", decode: { status: "decoded" } }]),
    dumpData([openingEntity({ decode: { status: "candidate", class: "TCH_OPENING" } })]),
  ];
  for (const dump of variants) {
    const res = injectUdoGeometry(src, dump);
    assert.equal(res.text, src, `不该改动：${JSON.stringify(dump)?.slice(0, 40)}`);
    assert.equal(res.injected, 0);
  }
});

test("坏 dump 不崩：缺 decode / NaN 坐标 / 退化矩形 / 不是 DXF，全部安全退化", () => {
  const src = dxfFixture();
  const bad = dumpData([
    { class: "TCH_OPENING" },
    { class: "TCH_OPENING", decode: null },
    { class: "TCH_OPENING", decode: { status: "decoded" } },
    openingEntity({
      decode: {
        status: "decoded",
        class: "TCH_OPENING",
        opening: { x: NaN, y: 0, width: 10, half_thickness: 1, rotation: 0 },
      },
    }),
    openingEntity({
      decode: { status: "decoded", class: "TCH_OPENING", opening: { x: 0, y: 0, width: 0 } },
    }),
  ]);
  const res = injectUdoGeometry(src, bad);
  assert.equal(res.text, src);
  assert.equal(res.injected, 0);

  // 不是 DXF（没有 ENTITIES 段）
  const notDxf = "hello world";
  const r2 = injectUdoGeometry(notDxf, dumpData([openingEntity()]));
  assert.equal(r2.text, notDxf);
  assert.equal(r2.injected, 0);
});

/* ───────────────────────────── 注入：decoded 正常路径 ───────────────────────────── */

test("decoded 洞口 → 洞口矩形 + 门扇线 + 90° 开启弧：保留图层、句柄从传入值往后排", () => {
  const src = dxfFixture();
  const res = injectUdoGeometry(src, dumpData([openingEntity()]), {
    startHandle: 0x200,
    layers: new Set(["0", "A-DOOR"]),
  });
  assert.equal(res.injected, 1);
  assert.equal(res.detected, 4, "dump 里 4 个自定义对象实体（1 洞口 + 3 墙）");
  assert.equal(res.skipped, 3);
  assert.equal(res.decoded, 1);
  assert.equal(res.primitivesByKind.opening, 3, "洞口矩形 + 门扇 + 开启弧");

  const ents = entitiesOf(res.text);
  const lw = ents.filter((e) => e.type === "LWPOLYLINE");
  assert.equal(lw.length, 3);
  for (const e of lw) assert.equal(pair(e, "8"), "A-DOOR", "保留原图层");

  // ① 洞口矩形：闭合、4 个顶点
  assert.equal(pair(lw[0], "70"), "1", "洞口闭合");
  assert.equal(pair(lw[0], "90"), "4");
  assert.equal(pair(lw[0], "5"), "200", "句柄 = startHandle");
  const xs = allPairs(lw[0], "10").map(Number);
  const ys = allPairs(lw[0], "20").map(Number);
  assert.deepEqual(
    xs.map((v) => Math.round(v)).sort((a, b) => a - b),
    [10600, 10600, 11700, 11700]
  );
  assert.deepEqual(ys.map((v) => Math.round(v)).sort((a, b) => a - b), [10700, 10700, 10900, 10900]);

  // ② 门扇线：开口折线（2 点），长度 = 洞口宽 × 0.975
  assert.equal(pair(lw[1], "70"), "0");
  assert.equal(pair(lw[1], "90"), "2");
  const leafPts = allPairs(lw[1], "10").map((v, i) => [Number(v), Number(allPairs(lw[1], "20")[i])]);
  assert.ok(Math.abs(Math.hypot(leafPts[1][0] - leafPts[0][0], leafPts[1][1] - leafPts[0][1]) - 1100 * 0.975) < 1e-3);

  // ③ 开启弧：10 个点（9 段），每点到弧心等距
  assert.equal(pair(lw[2], "70"), "0");
  assert.equal(pair(lw[2], "90"), "10");
  const arcPts = allPairs(lw[2], "10").map((v, i) => [Number(v), Number(allPairs(lw[2], "20")[i])]);
  const cx = leafPts[0][0];
  const cy = leafPts[0][1];
  for (const [x, y] of arcPts) {
    assert.ok(Math.abs(Math.hypot(x - cx, y - cy) - 1100 * 0.975) < 1e-3, "弧半径 = 门扇长");
  }

  // 插入点必须在 ENTITIES 段的 `0/ENDSEC` **之前**（插在中间会让 ENDSEC 变成类型名）
  const idx = res.text.indexOf("LWPOLYLINE");
  const end = res.text.indexOf("ENDSEC", res.text.indexOf("\nENTITIES"));
  assert.ok(idx > 0 && idx < end, "注入实体在 ENTITIES 段内、ENDSEC 之前");
  assert.match(res.text.slice(idx, idx + 40), /LWPOLYLINE/);
});

test("隐藏图层上的洞口不注入（不做\"复活\"）", () => {
  const src = dxfFixture();
  const res = injectUdoGeometry(src, dumpData([openingEntity()]), {
    startHandle: 0x200,
    layers: new Set(["0", "A-DOOR"]),
    hiddenLayers: new Set(["A-DOOR"]),
  });
  assert.equal(res.injected, 0);
  assert.equal(res.hidden, 1);
  assert.equal(res.text, src);
});

test("层表里没有的图层退回 0 层并计数（不让引擎拿不到图层对象）", () => {
  const res = injectUdoGeometry(dxfFixture(), dumpData([openingEntity()]), {
    startHandle: 0x200,
    layers: new Set(["0"]),
  });
  assert.equal(res.injected, 1);
  assert.equal(res.missingLayer, 1);
  const lw = entitiesOf(res.text).find((e) => e.type === "LWPOLYLINE");
  assert.equal(pair(lw, "8"), "0");
});

test("注入数量上限：maxEntities 之外的洞口只算 skipped", () => {
  const entities = Array.from({ length: 5 }, (_, i) =>
    openingEntity({ handle: `4AD${i}` })
  );
  const res = injectUdoGeometry(dxfFixture(), dumpData(entities), {
    startHandle: 0x200,
    layers: new Set(["0", "A-DOOR"]),
    maxEntities: 2,
  });
  assert.equal(res.injected, 2);
  assert.equal(res.decoded, 5);
  assert.equal(res.skipped, 6, "detected(5+3) - injected(2)");
  assert.ok(UDO_MAX_ENTITIES > 0);
});

test("句柄不撞号：连续注入时按 16 进制递增", () => {
  const entities = Array.from({ length: 3 }, (_, i) => openingEntity({ handle: `4AD${i}` }));
  const res = injectUdoGeometry(dxfFixture(), dumpData(entities), {
    startHandle: 0x1fe,
    layers: new Set(["0", "A-DOOR"]),
  });
  const handles = entitiesOf(res.text)
    .filter((e) => e.type === "LWPOLYLINE")
    .map((e) => pair(e, "5"));
  // 每个洞口 3 条线（矩形 + 门扇 + 弧），句柄连续不重复
  assert.deepEqual(handles, ["1FE", "1FF", "200", "201", "202", "203", "204", "205", "206"]);
});

/* ───────────────────────────── 注入：墙体 ───────────────────────────── */

test("wallFaces：中心线 + 左右宽度 → 两条墙面线（left 在法向正侧）", () => {
  const w = wallEntity().decode.wall;
  const f = wallFaces(w);
  assert.ok(f.left && f.right);
  // 水平墙（y 相同）→ 法向指 +y；left 在 +100，right 在 -80
  assert.deepEqual(
    f.left.map(([x, y]) => [Math.round(x), Math.round(y)]),
    [
      [18650, 14400],
      [21350, 14400],
    ]
  );
  assert.deepEqual(
    f.right.map(([x, y]) => [Math.round(x), Math.round(y)]),
    [
      [18650, 14220],
      [21350, 14220],
    ]
  );
  // 单侧墙（有一面压在中心线上）：另一面照画，压在中心线的那面不画
  const oneSided = wallFaces({ ...w, left_offset: 0, right_offset: 200, thickness: 200 });
  assert.equal(oneSided.left, null);
  assert.ok(oneSided.right);
  // 没有厚度信息 / 退化长度 → 不画
  assert.equal(wallFaces({ ...w, left_offset: 0, right_offset: 0 }), null);
  assert.equal(wallFaces({ ...w, end: w.start }), null);
  assert.equal(wallFaces(null), null);
});

test("decoded 墙体 → 两条墙面线 + 两个自由端封口（保留图层、70=0、句柄连续）", () => {
  const res = injectUdoGeometry(dxfFixture(), dumpData([wallEntity()]), {
    startHandle: 0x300,
    layers: new Set(["0", "WALL"]),
  });
  assert.equal(res.injected, 1, "1 个自定义对象实体");
  assert.equal(res.primitives, 4, "双面 + 两个自由端封口（ground truth 画法）");
  assert.equal(res.byKind.wall, 1);
  assert.equal(res.primitivesByKind.wall, 4);

  const lw = entitiesOf(res.text).filter((e) => e.type === "LWPOLYLINE");
  assert.equal(lw.length, 4);
  for (const e of lw) {
    assert.equal(pair(e, "8"), "WALL");
    assert.equal(pair(e, "70"), "0", "墙面线是开口折线");
    assert.equal(pair(e, "90"), "2");
  }
  assert.deepEqual(
    lw.map((e) => pair(e, "5")),
    ["300", "301", "302", "303"]
  );
  const ys = lw.map((e) => allPairs(e, "20").map(Number));
  assert.ok(Math.abs(ys[0][0] - 14400.005) < 0.01, `左面 y=${ys[0][0]}`);
  assert.ok(Math.abs(ys[1][0] - 14220.005) < 0.01, `右面 y=${ys[1][0]}`);
  // 封口线：两端各一条，竖着跨整个墙厚
  for (const cap of lw.slice(2)) {
    const capY = allPairs(cap, "20").map(Number).sort((a, b) => a - b);
    assert.ok(Math.abs(capY[0] - 14220.005) < 0.01 && Math.abs(capY[1] - 14400.005) < 0.01, `封口 ${capY}`);
    const capX = allPairs(cap, "10").map(Number);
    assert.ok(Math.abs(capX[0] - capX[1]) < 1e-6, "封口垂直于墙");
  }
});

/* ───────────────────────────── 门符号 ───────────────────────────── */

test("openingFrame：面线 → 局部坐标系（u=宽轴、n=法向、P=中心），x/y=0 时用面线中点", () => {
  const o = openingEntity().decode.opening;
  const f = openingFrame(o);
  assert.ok(Math.abs(f.P[0] - o.x) < 1e-9 && Math.abs(f.P[1] - o.y) < 1e-9);
  assert.ok(Math.abs(f.u[0] - o.direction[0]) < 1e-9 && Math.abs(f.u[1] - o.direction[1]) < 1e-9);
  assert.ok(Math.abs(f.n[0] - o.normal[0]) < 1e-9 && Math.abs(f.n[1] - o.normal[1]) < 1e-9, "n 与 CLI 的 normal 同向");
  assert.equal(f.w, 1100);
  assert.equal(f.ht, 100);

  // 缺 wall_face_segments：按中心/旋转/宽反算，等价
  const noFaces = { ...o, wall_face_segments: null };
  const g = openingFrame(noFaces);
  assert.ok(Math.abs(g.P[0] - f.P[0]) < 1e-9 && Math.abs(g.P[1] - f.P[1]) < 1e-9);
  assert.ok(Math.abs(g.w - f.w) < 1e-9);

  // x/y 解成 0（个别对象）但面线正常 → 用面线中点当中心
  const local = {
    ...o,
    x: 0,
    y: 0,
    wall_face_segments: [
      [[-550, 100], [550, 100]],
      [[-550, -100], [550, -100]],
    ],
  };
  const h = openingFrame(local);
  assert.ok(Math.abs(h.P[0]) < 1e-9 && Math.abs(h.P[1]) < 1e-9);
  assert.equal(h.w, 1100);
  assert.equal(h.ht, 100);

  assert.equal(openingFrame(null), null);
  assert.equal(openingFrame({ width: 0 }), null);
});

test("doorSymbol：门扇长 = 0.975×洞口宽、垂直于墙、弧 90°、弧心即铰链", () => {
  const o = openingEntity().decode.opening;
  const sym = doorSymbol(o);
  assert.ok(sym, "合法洞口必须有门符号");
  assert.ok(Math.abs(sym.leafLength - 1100 * 0.975) < 1e-9);
  const [h, tip] = sym.leaf;
  // 铰链在墙厚中线上：到洞口中心线的距离 = 半宽 - 收缩量
  const du = (h[0] - o.x) * o.direction[0] + (h[1] - o.y) * o.direction[1];
  assert.ok(Math.abs(Math.abs(du) - (550 - 27.5)) < 1e-9, `铰链轴向偏移 ${du}`);
  // 门扇垂直于墙（沿 n）
  const leafVec = [tip[0] - h[0], tip[1] - h[1]];
  const along = Math.abs(leafVec[0] * o.direction[0] + leafVec[1] * o.direction[1]);
  assert.ok(along < 1e-9, "门扇没有沿墙方向的分量");
  // 关闭位置端点 = 洞口另一端
  const closed = [h[0] + Math.cos(sym.arc.a1) * sym.arc.r, h[1] + Math.sin(sym.arc.a1) * sym.arc.r];
  const far = [
    o.x - o.direction[0] * sym.hinge * 550,
    o.y - o.direction[1] * sym.hinge * 550,
  ];
  assert.ok(Math.hypot(closed[0] - far[0], closed[1] - far[1]) < 1e-6, "关闭位置正好落在洞口另一端");
  // 弧 = 90°，半径 = 门扇长
  let sweep = Math.abs(sym.arc.a1 - sym.arc.a0);
  if (sweep > Math.PI) sweep = 2 * Math.PI - sweep;
  assert.ok(Math.abs(sweep - Math.PI / 2) < 1e-9, `开启角 ${(sweep * 180) / Math.PI}°`);
  assert.equal(sym.arc.r, sym.leafLength);
  assert.equal(sym.arc.cx, h[0]);
  assert.equal(sym.arc.cy, h[1]);
  assert.equal(doorSymbol({ ...o, width: 0, wall_face_segments: null }), null);
});

test("doorSymbol：铰链在离墙端更近的一端（ground truth 规则 85%）", () => {
  const o = openingEntity().decode.opening; // 洞口 x 10600..11700，u=(-1,0)
  const base = { face: null };
  // 墙端在 +u 侧（x 更小）→ hinge = +1
  const nearPos = doorSymbol(o, {
    walls: [{ start: [10500, 10800], end: [9000, 10800] }],
    faces: [],
  });
  // 墙端在 -u 侧（x 更大）→ hinge = -1
  const nearNeg = doorSymbol(o, {
    walls: [{ start: [11800, 10800], end: [13300, 10800] }],
    faces: [],
  });
  assert.equal(nearPos.hinge, 1);
  assert.equal(nearNeg.hinge, -1);
  assert.equal(base.face, null);
});

test("doorSymbol：门朝更空的一侧开（ground truth 规则 77%）", () => {
  const o = openingEntity().decode.opening; // n = (0,-1)：+n 是 y 更小的一侧
  // +n 侧有一堵平行墙挡着 → 往 -n 侧开
  const blocked = doorSymbol(o, { walls: [], faces: [[[10500, 10500], [11800, 10500]]] });
  assert.equal(blocked.swing, -1);
  // -n 侧有墙 → 往 +n 侧开
  const flipped = doorSymbol(o, { walls: [], faces: [[[10500, 11200], [11800, 11200]]] });
  assert.equal(flipped.swing, 1);
  // 两侧都没有墙 → 固定 +n（确定，不是随机）
  assert.equal(doorSymbol(o).swing, 1);
});

test("arcPolyline：10 个点、等半径、首尾落在 a0/a1 上；非法输入 → null", () => {
  const arc = { cx: 100, cy: 200, r: 50, a0: 0, a1: Math.PI / 2 };
  const pts = arcPolyline(arc);
  assert.equal(pts.length, 10);
  for (const [x, y] of pts) assert.ok(Math.abs(Math.hypot(x - 100, y - 200) - 50) < 1e-9);
  assert.ok(Math.abs(pts[0][0] - 150) < 1e-9 && Math.abs(pts[0][1] - 200) < 1e-9);
  assert.ok(Math.abs(pts[9][0] - 100) < 1e-9 && Math.abs(pts[9][1] - 250) < 1e-9);
  // 反向弧走短弧（不会绕 270°）
  const back = arcPolyline({ cx: 0, cy: 0, r: 10, a0: Math.PI / 2, a1: 0 });
  assert.ok(Math.abs(back[9][0] - 10) < 1e-9 && Math.abs(back[9][1]) < 1e-9);
  assert.equal(arcPolyline(null), null);
  assert.equal(arcPolyline({ cx: NaN, cy: 0, r: 1, a0: 0, a1: 1 }), null);
});

/* ───────────────────────── v65：门/窗语义 + 门型 + 范围自检 ───────────────────────── */

test("classifyOpening：层族 + 底标高（T3 319/319 的判据）", () => {
  // 门族：贴地 → 门；窗台 900 → 窗（本图 8 个 DOOR_FIRE 窗）
  assert.equal(classifyOpening(openingOf({ layer: "A-DOOR", z: 0 }).decode.opening, "A-DOOR").kind, "door");
  assert.equal(classifyOpening(openingOf({ layer: "DOOR_FIRE", z: 900 }).decode.opening, "DOOR_FIRE").kind, "window");
  // 窗族：有窗台 → 窗；贴地 + 门高 + 门宽 → 门（本图 10 樘）
  assert.equal(classifyOpening(openingOf({ layer: "WINDOW", z: 900, width: 1500, height: 3250 }).decode.opening, "WINDOW").kind, "window");
  assert.equal(classifyOpening(openingOf({ layer: "WINDOW", z: 0, width: 1500, height: 2500 }).decode.opening, "WINDOW").kind, "door");
  // 窗族但高度 1800/2000（施工005 的窗）不翻门
  assert.equal(classifyOpening(openingOf({ layer: "A_WINDOW", z: 0, width: 1500, height: 2000 }).decode.opening, "A_WINDOW").kind, "window");
  // 隔断门 z=400 仍是门；中性层 z=300 是窗
  assert.equal(classifyOpening(openingOf({ layer: "LATRINE", z: 400, width: 600, height: 1800 }).decode.opening, "LATRINE").kind, "door");
  assert.equal(classifyOpening(openingOf({ layer: "建筑", z: 300, width: 900, height: 1600 }).decode.opening, "建筑").kind, "window");
  // 洞口上方/窗编号层永远不翻门
  assert.equal(classifyOpening(openingOf({ layer: "A_ABOVE", z: 0, width: 1000, height: 2100 }).decode.opening, "A_ABOVE").kind, "window");
});

test("doorTypeOf：T3 的双扇/单扇/无弧三档", () => {
  assert.equal(doorTypeOf({ width: 900 }, "DOOR_FIRE"), "double");
  assert.equal(doorTypeOf({ width: 900 }, "WINDOW"), "single");
  assert.equal(doorTypeOf({ width: 1500 }, "DOOR_FIRE"), "double");
  assert.equal(doorTypeOf({ width: 1800 }, "DOOR_FIRE"), "double");
  assert.equal(doorTypeOf({ width: 1300 }, "WINDOW"), "sliding");
  assert.equal(doorTypeOf({ width: 2000 }, "WINDOW"), "sliding");
  assert.equal(doorTypeOf({ width: 3900 }, "DOOR_FIRE"), "sliding");
  assert.equal(doorTypeOf({ width: 600 }, "LATRINE"), "single");
});

test("doorSymbols：双扇 = 两扇 0.4875w + 两段 90° 弧，关闭位置都在洞口中心", () => {
  const o = openingOf({ layer: "DOOR_FIRE", width: 1500, height: 2500, z: 0 }).decode.opening;
  const group = doorSymbols(o, {}, { rawLayer: "DOOR_FIRE" });
  assert.equal(group.type, "double");
  assert.equal(group.leaves.length, 2);
  assert.equal(group.arcs.length, 2);
  assert.ok(Math.abs(group.leafLength - 1500 * 0.4875) < 1e-9);
  for (const [a, b] of group.leaves) {
    assert.ok(Math.abs(Math.hypot(b[0] - a[0], b[1] - a[1]) - 1500 * 0.4875) < 1e-9);
  }
  for (const arc of group.arcs) {
    assert.equal(arc.r, group.leafLength);
    let sweep = Math.abs(arc.a1 - arc.a0);
    if (sweep > Math.PI) sweep = 2 * Math.PI - sweep;
    assert.ok(Math.abs(sweep - Math.PI / 2) < 1e-9, `弧 ${(sweep * 180) / Math.PI}°`);
    // 关闭位置 = 洞口中心
    const closed = [arc.cx + Math.cos(arc.a1) * arc.r, arc.cy + Math.sin(arc.a1) * arc.r];
    assert.ok(Math.hypot(closed[0] - o.x, closed[1] - o.y) < 1e-6);
  }
});

test("doorSymbols：单扇 1 扇 0.975w + 1 弧；推拉 2 扇贴墙、0 弧", () => {
  const single = doorSymbols(openingOf({ layer: "WINDOW", width: 900, height: 2500, z: 0 }).decode.opening, {}, { rawLayer: "WINDOW" });
  assert.equal(single.type, "single");
  assert.equal(single.leaves.length, 1);
  assert.equal(single.arcs.length, 1);
  assert.ok(Math.abs(single.leafLength - 900 * 0.975) < 1e-9);

  const sliding = doorSymbols(openingOf({ layer: "DOOR_FIRE", width: 3900, height: 3600, z: 0 }).decode.opening, {}, { rawLayer: "DOOR_FIRE" });
  assert.equal(sliding.type, "sliding");
  assert.equal(sliding.leaves.length, 2);
  assert.equal(sliding.arcs.length, 0, "T3 的 213/127/138 块内 0 段 ARC");
});

test("注入：WINDOW 窗只画洞口矩形，不画门扇/弧", () => {
  const res = injectUdoGeometry(dxfFixture(), dumpData([openingOf({ layer: "WINDOW", width: 1500, height: 3250, z: 900 })]), {
    startHandle: 0x200,
    layers: new Set(["0", "WINDOW"]),
  });
  assert.equal(res.injected, 1);
  assert.equal(res.byKind.opening, 1);
  assert.equal(res.primitivesByKind.opening, 1, "只有闭合矩形");
  const lw = entitiesOf(res.text).filter((e) => e.type === "LWPOLYLINE");
  assert.equal(lw.length, 1);
  assert.equal(pair(lw[0], "70"), "1");
  assert.equal(pair(lw[0], "90"), "4");
});

test("注入：窗层贴地的真门仍画门符号（10 樘不能被层名误杀）", () => {
  const res = injectUdoGeometry(dxfFixture(), dumpData([openingOf({ layer: "WINDOW", width: 1300, height: 2200, z: 0 })]), {
    startHandle: 0x200,
    layers: new Set(["0", "WINDOW"]),
  });
  assert.equal(res.injected, 1);
  assert.equal(res.primitivesByKind.opening, 3, "矩形 + 2 扇贴墙（T3 的 127 块无弧）");
  const lw = entitiesOf(res.text).filter((e) => e.type === "LWPOLYLINE");
  assert.equal(lw.filter((e) => pair(e, "90") === "2").length, 2);
  assert.equal(lw.filter((e) => pair(e, "90") === "10").length, 0);
});

test("contentBox 自检：块内注入越界 → warning + 跳过该批", () => {
  const src = blockFixture({ blockLines: blockLine(18000, 13000, 22000, 15000) });
  const data = dumpData([openingEntity()]);
  data.diagnostics = { origins: { in_scope: true } };
  data.entities[0].decode.origin = { point: [0, 0, 0], block: "PLAN", source: "block_insert", applied: true };
  const res = injectUdoGeometry(src, data, {
    startHandle: 0x200,
    layers: LAYERS3,
    contentBox: { minX: 0, minY: 0, maxX: 5000, maxY: 5000, width: 5000, height: 5000 },
  });
  assert.equal(res.injected, 0);
  assert.ok(res.warnings.some((w) => w.startsWith("out_of_content_box:PLAN")));
});

test("contentBox 自检：范围内正常注入；没有 contentBox 时保持旧行为", () => {
  const src = blockFixture({ blockLines: blockLine(10000, 9000, 13000, 12000) });
  const data = dumpData([openingEntity()]);
  data.diagnostics = { origins: { in_scope: true } };
  data.entities[0].decode.origin = { point: [0, 0, 0], block: "PLAN", source: "block_insert", applied: true };
  const ok = injectUdoGeometry(src, data, {
    startHandle: 0x200,
    layers: LAYERS3,
    contentBox: { minX: 0, minY: 0, maxX: 20000, maxY: 20000, width: 20000, height: 20000 },
  });
  assert.equal(ok.injected, 1);
  assert.deepEqual(ok.warnings, []);

  const noBox = injectUdoGeometry(src, data, { startHandle: 0x200, layers: LAYERS3 });
  assert.equal(noBox.injected, 1, "没有 contentBox/HEADER 时不做越界裁剪");
});

test("DXF_WEB_VERSION 升到 68（字段改名 tch→udo，旧缓存必须重建）", () => {
  assert.equal(DXF_WEB_VERSION, 68);
});

/* ───────────────────────────── 墙接头 ───────────────────────────── */

test("connectWallFaces：L 转角四条面线两两求交，端点接上（不延长出穿头）", () => {
  // 两堵 200 厚墙：A 沿 +x（y=±100），B 沿 +y（x=±100），中心线交于原点
  const faces = [
    { thickness: 200, points: [[0, 100], [2000, 100]] }, // A left
    { thickness: 200, points: [[0, -100], [2000, -100]] }, // A right
    { thickness: 200, points: [[-100, 0], [-100, 2000]] }, // B left
    { thickness: 200, points: [[100, 0], [100, 2000]] }, // B right
  ];
  const res = connectWallFaces(faces);
  const key = (p) => `${Math.round(p[0])},${Math.round(p[1])}`;
  const ends = new Set(res.faces.flatMap((f) => f.points.map(key)));
  // 凸角 (100,100)、凹角 (-100,-100)：两条面线的端点都被搬到交点上
  assert.ok(ends.has("100,100"), `端点：${[...ends].join(" ")}`);
  assert.ok(ends.has("-100,-100"));
  assert.equal(res.mitered, 8, "四条面线、两端各接一次");
  // 每条线都还是 2 点（不是简单延长出双线）
  for (const f of res.faces) assert.equal(f.points.length, 2);
  // 没有穿头：A left 现在从 (100,100) 开始，不再延伸到 x=0
  const aLeft = res.faces.find((f) => Math.abs(f.points[0][1] - 100) < 1e-9 && f.points[0][0] > 0);
  assert.ok(Math.abs(aLeft.points[0][0] - 100) < 1e-9);
});

test("connectWallFaces：T 形接头只动断头墙，被穿过的墙保持连续", () => {
  const faces = [
    { thickness: 200, points: [[-1000, 100], [1000, 100]] }, // 横墙 left（穿过）
    { thickness: 200, points: [[-1000, -100], [1000, -100]] }, // 横墙 right
    { thickness: 200, points: [[300, 0], [300, 2000]] }, // 竖墙 left（中心线起于横墙中心线）
    { thickness: 200, points: [[500, 0], [500, 2000]] }, // 竖墙 right
  ];
  const res = connectWallFaces(faces);
  const horizontal = res.faces.filter((f) => f.points.every((p) => Math.abs(Math.abs(p[1]) - 100) < 1e-9));
  assert.equal(horizontal.length, 2, "横墙两条面线仍在 y=±100 上");
  // 横墙端点没被拉走
  for (const f of horizontal) {
    const xs = f.points.map((p) => Math.abs(p[0])).sort((a, b) => a - b);
    assert.ok(Math.abs(xs[0] - 1000) < 1e-9, `横墙端点 ${xs}`);
  }
  // 竖墙两条面线延伸到横墙上皮 y=100（不是穿过去）
  const vertical = res.faces.filter((f) => f.points.every((p) => Math.abs(p[0] - 300) < 1e-9 || Math.abs(p[0] - 500) < 1e-9));
  assert.equal(vertical.length, 2);
  for (const f of vertical) {
    const ys = f.points.map((p) => p[1]).sort((a, b) => a - b);
    assert.ok(Math.abs(ys[0] - 100) < 1e-9, `竖墙端点应停在 y=100：${ys}`);
  }
});

test("connectWallFaces：平行共线（同一堵墙被切开）端点对齐；空输入不抛", () => {
  const faces = [
    { thickness: 200, points: [[0, 0], [1000, 0]] },
    { thickness: 200, points: [[1000.4, 0], [2000, 0]] },
  ];
  const res = connectWallFaces(faces);
  assert.equal(res.faces.length, 2);
  assert.ok(Math.abs(res.faces[0].points[1][0] - 1000.4) < 1e-9, "共线吸附到对方端点");
  assert.ok(res.snapped >= 1, `吸附次数 ${res.snapped}`);
  assert.equal(res.mitered, 0, "共线不该产生 miter");
  assert.deepEqual(connectWallFaces([]), { faces: [], mitered: 0, snapped: 0 });
  assert.deepEqual(connectWallFaces(null), { faces: [], mitered: 0, snapped: 0 });
});

test("trimWallFacesAtOpenings：面线在洞口处断开（两侧保留），洞口外不动", () => {
  const o = openingEntity().decode.opening; // 洞口 10600..11700 × 10700..10900
  const fr = openingFrame(o);
  const across = { thickness: 200, points: [[10000, 10900], [12000, 10900]] };
  const outside = { thickness: 200, points: [[10000, 13000], [12000, 13000]] };
  const out = trimWallFacesAtOpenings([across, outside], [fr]);
  const cut = out.filter((f) => Math.abs(f.points[0][1] - 10900) < 1);
  assert.equal(cut.length, 2, "跨洞口的面线被切成两段");
  const xs = cut.map((f) => f.points.map((p) => p[0])).flat().sort((a, b) => a - b);
  assert.ok(Math.abs(xs[0] - 10000) < 0.01 && Math.abs(xs[1] - 10600) < 0.01, `切点 ${xs}`);
  assert.ok(Math.abs(xs[2] - 11700) < 0.01 && Math.abs(xs[3] - 12000) < 0.01, `切点 ${xs}`);
  assert.equal(out.filter((f) => Math.abs(f.points[0][1] - 13000) < 1).length, 1, "洞口外的面线原样保留");
  assert.equal(trimWallFacesAtOpenings([across], []).length, 1);
});

test("closeWallEnds：自由端补封口线，接头端不补", () => {
  // 一堵独立的墙（两头都是自由端）→ 2 条封口
  const wall = { start: [0, 0], end: [2000, 0], thickness: 200 };
  const free = [
    { wall: 0, side: "left", thickness: 200, points: [[0, 100], [2000, 100]] },
    { wall: 0, side: "right", thickness: 200, points: [[0, -100], [2000, -100]] },
  ];
  const res = closeWallEnds(free, [wall]);
  assert.equal(res.caps, 2);
  assert.equal(res.faces.length, 4);
  // 端头已经被别的面线接住 → 不补
  const joined = [...free, { wall: 1, side: "left", thickness: 200, points: [[2000, 100], [2000, 300]] }];
  const res2 = closeWallEnds(joined, [wall]);
  assert.ok(res2.caps < 2);
});

/* 一堵墙的 dump 实体（中心线 + 左右宽度都等于半个厚度） */
function wallAt(start, end, layer = "WALL", half = 100) {
  return {
    class: "TCH_WALL",
    layer,
    handle: `W${start[0]}-${start[1]}-${end[0]}-${end[1]}`,
    decode: {
      class: "TCH_WALL",
      kind: "wall",
      status: "decoded",
      wall: {
        start: [start[0], start[1], 0],
        end: [end[0], end[1], 0],
        length: Math.hypot(end[0] - start[0], end[1] - start[1]),
        left_offset: half,
        right_offset: half,
        thickness: half * 2,
        height: 3000,
      },
    },
  };
}

/** 端点是否悬空：到**其它**线段的距离都 > tol */
function danglingEnds(segs, tol = 1) {
  const out = [];
  segs.forEach((s, i) => {
    for (const p of s) {
      let best = Infinity;
      segs.forEach((t, j) => {
        if (j !== i) best = Math.min(best, segMinToSeg(p, t));
      });
      if (best > tol) out.push(p);
    }
  });
  return out;
}
function segMinToSeg(p, [a, b]) {
  const ab = [b[0] - a[0], b[1] - a[1]];
  const l2 = ab[0] * ab[0] + ab[1] * ab[1];
  if (l2 < 1e-12) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + ab[0] * t), p[1] - (a[1] + ab[1] * t));
}

test("注入：两堵墙的 L 转角在产物里接上了（凸角/凹角端点重合，无悬空端点）", () => {
  const L = [wallAt([0, 0], [3000, 0]), wallAt([3000, 0], [3000, 3000])];
  const res = injectUdoGeometry(dxfFixture(), dumpData(L), {
    startHandle: 0x300,
    layers: new Set(["0", "WALL"]),
  });
  const segs = entitiesOf(res.text)
    .filter((e) => e.type === "LWPOLYLINE")
    .map((e) => {
      const xs = allPairs(e, "10").map(Number);
      const ys = allPairs(e, "20").map(Number);
      return xs.map((x, i) => [x, ys[i]]);
    });
  const ends = segs.flatMap((s) => s);
  const key = (p) => `${Math.round(p[0])},${Math.round(p[1])}`;
  const set = new Set(ends.map(key));
  // 凸角 (3100,100)、凹角 (2900,-100) 都必须是两条面线的公共端点
  assert.ok(set.has("3100,100"), `凸角缺失：${[...set].join(" ")}`);
  assert.ok(set.has("2900,-100"), `凹角缺失：${[...set].join(" ")}`);
  // 每一段面线的端点都能在别的面线上找到落点（或已有封口）→ 悬空端点 0
  assert.deepEqual(danglingEnds(segs), [], "L 转角不应再有断头");
  assert.equal(res.primitivesByKind.wall, segs.length);
  assert.ok(segs.length >= 4, "至少四条面线");
});

/* ───────────────────────────── 注入：文字 ───────────────────────────── */

test("headerTextSize / textHeightOf：字高优先 JSON，其次环境变量，再次 $TEXTSIZE", () => {
  assert.equal(headerTextSize(dxfFixture(150)), 150);
  assert.equal(headerTextSize(dxfFixture()), null);

  const prev = process.env.UDO_TEXT_HEIGHT;
  try {
    delete process.env.UDO_TEXT_HEIGHT;
    assert.equal(textHeightOf({ height: 320 }, 150), 320, "JSON 自带字高优先");
    assert.equal(textHeightOf({}, 150), 150, "退回 $TEXTSIZE");
    assert.equal(textHeightOf({}, null), 2.5, "最后保底 2.5");
    process.env.UDO_TEXT_HEIGHT = "275";
    assert.equal(textHeightOf({}, 150), 275, "环境变量可覆盖兜底");
    assert.equal(textHeightOf({ height: 320 }, 150), 320, "但盖不过 JSON 字高");
  } finally {
    if (prev === undefined) delete process.env.UDO_TEXT_HEIGHT;
    else process.env.UDO_TEXT_HEIGHT = prev;
  }
});

test("decoded 文字 → TEXT：内容原样（GBK 已解好）、插入点、字高取 $TEXTSIZE、保留图层", () => {
  const res = injectUdoGeometry(dxfFixture(150), dumpData([textEntity()]), {
    startHandle: 0x400,
    layers: new Set(["0", "地库增加范围"]),
  });
  assert.equal(res.injected, 1);
  assert.equal(res.byKind.text, 1);
  assert.equal(res.textHeight, 150, "用了兜底字高");

  const t = entitiesOf(res.text).find((e) => e.type === "TEXT");
  assert.equal(pair(t, "1"), "车库减小范围", "中文内容不能被转义/丢字");
  assert.equal(pair(t, "8"), "地库增加范围");
  assert.equal(pair(t, "40"), "150");
  assert.equal(Number(pair(t, "10")).toFixed(0), "1127907");
  assert.equal(Number(pair(t, "20")).toFixed(0), "8506");
  assert.equal(pair(t, "5"), "400");
});

test("文字自带字高 / 换行 / 空内容", () => {
  const res = injectUdoGeometry(dxfFixture(150), dumpData([textEntity({}, { height: 320 })]), {
    startHandle: 0x400,
    layers: new Set(["0", "地库增加范围"]),
  });
  assert.equal(pair(entitiesOf(res.text).find((e) => e.type === "TEXT"), "40"), "320");
  assert.equal(res.textHeight, null, "自带字高时不算兜底");

  const multi = injectUdoGeometry(
    dxfFixture(150),
    dumpData([textEntity({}, { content: "无障碍电梯\r\n兼担架梯" })]),
    { startHandle: 0x400, layers: new Set(["0", "地库增加范围"]) }
  );
  const texts = entitiesOf(multi.text).filter((e) => e.type === "TEXT");
  assert.equal(texts.length, 2, "多行按原样分行");
  assert.equal(pair(texts[0], "1"), "无障碍电梯");
  assert.equal(pair(texts[1], "1"), "兼担架梯");
  assert.equal(pair(texts[0], "40"), "150");
  // 第二行在第一行下方 1.25 字高
  const dy = Number(pair(texts[0], "20")) - Number(pair(texts[1], "20"));
  assert.ok(Math.abs(dy - 150 * 1.25) < 1e-6, `行距 ${dy}`);
  assert.equal(multi.primitivesByKind.text, 2, "两条 TEXT");

  const empty = injectUdoGeometry(dxfFixture(150), dumpData([textEntity({}, { content: "  " })]), {
    startHandle: 0x400,
    layers: new Set(["0", "地库增加范围"]),
  });
  assert.equal(empty.injected, 0, "空内容不写空 TEXT");
  assert.equal(empty.decoded, 1, "但仍然算 decoded");
});

/* ───────────────────── 天正标注数值文字（TDbDimension2，v59） ───────────────────── */

test("udoKindOf：TDbDimension2 / TCH_DIMENSION2 归一成 dimension（不再掉进 else）", () => {
  assert.equal(udoKindOf({ class: "TCH_DIMENSION2" }), "dimension");
  assert.equal(udoKindOf({ class: "TCH_DIMENSION2", cpp_class: "TDbDimension2" }), "dimension");
  assert.equal(udoKindOf({ cpp_class: "TDbDimension" }), "dimension");
  assert.equal(udoKindOf({ class: "SOMETHING_NEW", decode: { kind: "dimension" } }), "dimension");
  assert.notEqual(udoKindOf({ class: "TCH_DIMENSION2" }), "text", "不能当文字处理");
});

test("decoded 标注 → 每段一条 TEXT：内容/字高/旋转/位置/图层/颜色", () => {
  const res = injectUdoGeometry(dxfFixture(150), dumpData([dimensionEntity()]), {
    startHandle: 0x600,
    layers: new Set(["0", "A-DOOR", "WALL", "地库增加范围", "G-GRID-DIMS", "PUB_DIM"]),
  });
  assert.equal(res.decoded, 1);
  assert.equal(res.injected, 1, "一条链算一个注入对象（与文字一致）");
  assert.equal(res.byKind.dimension, 1);
  assert.equal(res.primitivesByKind.dimension, 2, "2 个 segments → 2 条 TEXT");
  assert.equal(res.missingLayer, 0);

  const texts = entitiesOf(res.text).filter((e) => e.type === "TEXT");
  assert.equal(texts.length, 2);
  assert.deepEqual(texts.map((t) => pair(t, "1")), ["1000", "16000"]);
  for (const t of texts) {
    assert.equal(pair(t, "8"), "G-GRID-DIMS", "图层取标注实体自己的层");
    assert.equal(pair(t, "62"), null, "不写颜色组码 = BYLAYER（跟随图层）");
    assert.equal(pair(t, "40"), "446.25", "字高 = style.text_height");
    assert.equal(pair(t, "50"), "90", "旋转 = 尺寸线角度（π/2 → 90°）");
  }
  // 竖直线段 p1→p2 = (0,+1000)：左法向 (-1,0)；偏移 k×字高
  const off = DIM_TEXT_OFFSET_K * 446.25;
  assert.ok(Math.abs(Number(pair(texts[0], "10")) - (7200 - off)) < 1e-6);
  assert.ok(Math.abs(Number(pair(texts[0], "20")) - 12516.55) < 1e-6);
  // 第二条段长 16000，中点 y = 21016.55
  assert.ok(Math.abs(Number(pair(texts[1], "20")) - 21016.55) < 1e-6);
});

test("candidate 标注一律不注入（安全门语义不变）", () => {
  const src = dxfFixture(150);
  const cand = dimensionEntity();
  cand.decode.status = "candidate";
  const res = injectUdoGeometry(src, dumpData([cand]), { startHandle: 0x600 });
  assert.equal(res.text, src, "字节不变");
  assert.equal(res.injected, 0);
  assert.equal(res.byKind.dimension, 0);

  const mixed = injectUdoGeometry(src, dumpData([dimensionEntity(), cand]), {
    startHandle: 0x600,
    layers: new Set(["0", "G-GRID-DIMS"]),
  });
  assert.equal(mixed.byKind.dimension, 1, "decoded 注入、candidate 跳过");
  assert.equal(mixed.primitivesByKind.dimension, 2);
});

test("标注空 segments / 缺坐标 / 零长度不崩、不写空 TEXT", () => {
  const src = dxfFixture(150);
  const empty = injectUdoGeometry(src, dumpData([dimensionEntity({}, { segments: [] })]), {
    startHandle: 0x600,
  });
  assert.equal(empty.text, src);
  assert.equal(empty.injected, 0);
  assert.equal(empty.decoded, 1, "decoded 仍然计数");

  const bad = dimensionEntity({}, {
    segments: [
      { value: 1000, p1: null, p2: null },
      { value: NaN, text: "", p1: [0, 0], p2: [1, 0] },
      { value: 5, text: "5", p1: [0, 0], p2: [0, 0] }, // 零长度：旋转退回 angle
      { value: 2.7, p1: [0, 0], p2: [2.7, 0], text: "2.7" },
    ],
  });
  const res = injectUdoGeometry(src, dumpData([bad]), {
    startHandle: 0x600,
    layers: new Set(["0", "G-GRID-DIMS"]),
  });
  assert.equal(res.primitivesByKind.dimension, 2, "只有两条能写出文字");
  for (const t of entitiesOf(res.text).filter((e) => e.type === "TEXT")) {
    assert.ok(pair(t, "1"), "不写空 TEXT");
    assert.ok(Number.isFinite(Number(pair(t, "10"))));
    assert.ok(Number.isFinite(Number(pair(t, "20"))));
    assert.ok(Number.isFinite(Number(pair(t, "50"))));
  }
});

test("标注数值格式：format(value, dec) + postfix（3.60M）", () => {
  assert.equal(formatDimensionLabel({ value: 3.6 }, { dec: 2, postfix: "M" }), "3.60M");
  assert.equal(
    formatDimensionLabel({ value: 3.6, text: "3.6" }, { dec: 2, postfix: "M" }),
    "3.60M",
    "有 dec 时按 dec 重排，不用 CLI 的 text"
  );
  assert.equal(
    formatDimensionLabel({ value: 112059.62219136796, text: "112060" }, { dec: 0 }),
    "112060"
  );
  assert.equal(formatDimensionLabel({ value: 1.2345 }, {}), "1.2345", "没有 dec 时退回 value");
  // dec 超出合理范围（脏数据）不抛异常，退回 CLI 的 text
  assert.equal(formatDimensionLabel({ value: 1.2345, text: "1.23" }, { dec: 271 }), "1.23");
  assert.equal(formatDimensionLabel({}, {}), "");

  const res = injectUdoGeometry(
    dxfFixture(150),
    dumpData([
      dimensionEntity({}, {
        style: { text_height: 446.25, postfix: "M", dec: 2 },
        segments: [{ value: 3.6, p1: [0, 0], p2: [1000, 0], text: "3.6" }],
      }),
    ]),
    { startHandle: 0x600, layers: new Set(["0", "G-GRID-DIMS"]) }
  );
  assert.equal(pair(entitiesOf(res.text).find((e) => e.type === "TEXT"), "1"), "3.60M");
});

/* ───────────── 天正标注几何：尺寸线/界线/箭头（TDbDimension2，v62） ───────────── */

/**
 * 一条带完整几何的 decoded 标注链（数值全部抄自施工005 实测 dump 的 handle 13821）。
 * `seg2` 故意只有 `p1/p2`、没有 `dim_line`/`ext_lines`/`ticks`/`text_point`：
 * 用来验"缺字段 → 回退旧估算 + 不画几何"这条分支。
 */
function dimensionGeomEntity(over = {}, dimOver = {}) {
  const e = dimensionEntity(over, {
    segments: [
      {
        value: 112059.62219136796,
        p1: [7199.999614574364, 12016.550714774872],
        p2: [7199.999614574372, 124076.17290614283],
        text: "112060",
        dim_line: {
          a: [2249.9996145743644, 12016.550714774872],
          b: [2249.9996145743717, 124076.17290614283],
        },
        ext_lines: [
          { a: [6749.999614574364, 12016.550714774872], b: [1874.9996145743644, 12016.550714774872] },
          { a: [6749.999614574372, 124076.17290614283], b: [1874.9996145743717, 124076.17290614283] },
        ],
        ticks: [
          {
            p: [2249.9996145743644, 12016.550714774872],
            rotation: Math.PI / 2,
            size: 150,
            a: [2324.9996145743644, 11941.550714774872],
            b: [2174.9996145743644, 12091.550714774872],
          },
          {
            p: [2249.9996145743717, 124076.17290614283],
            rotation: Math.PI / 2,
            size: 150,
            a: [2324.9996145743717, 124001.17290614283],
            b: [2174.9996145743717, 124151.17290614283],
          },
        ],
        text_point: {
          p: [1837.499614574368, 68046.36181045885],
          rotation: Math.PI / 2,
        },
      },
      /* 回退样本：只有 p1/p2（v59 的老字段） */
      { value: 4950, p1: [7200, 12016.55], p2: [12150, 12016.55], text: "4950" },
    ],
    ...dimOver,
  });
  return e;
}

test("v62 标注几何：每段 1 尺寸线 + 2 界线 + 2 箭头，端点一律取自载荷", () => {
  const res = injectUdoGeometry(dxfFixture(150), dumpData([dimensionGeomEntity()]), {
    startHandle: 0x700,
    layers: new Set(["0", "G-GRID-DIMS"]),
  });
  assert.equal(res.byKind.dimension, 1);
  /* 2 段：第一段 5 条几何（1+2+2），第二段没有几何 → 不画；
   * `primitivesByKind` 还把 2 条文字算进来（与旧口径一致）→ 7 */
  assert.equal(res.primitivesByKind.dimension, 7);
  const lw = entitiesOf(res.text).filter((e) => e.type === "LWPOLYLINE");
  assert.equal(lw.length, 5);
  for (const e of lw) {
    assert.equal(pair(e, "90"), "2", "每条都是 2 点折线");
    assert.equal(pair(e, "70"), "0", "开口折线，不闭合");
    assert.equal(pair(e, "8"), "G-GRID-DIMS", "与标注文字同层");
    assert.equal(pair(e, "62"), null, "不写 62 = BYLAYER");
  }
  const seg = (e) => {
    const xs = allPairs(e, "10").map(Number);
    const ys = allPairs(e, "20").map(Number);
    return [
      [xs[0], ys[0]],
      [xs[1], ys[1]],
    ];
  };
  const near = (a, b) =>
    Math.abs(a[0] - b[0]) < 1e-5 && Math.abs(a[1] - b[1]) < 1e-5;
  const pts = lw.map(seg);
  /* 顺序：dim_line → 2 条 ext_lines → 2 个 ticks */
  assert.ok(near(pts[0][0], [2249.9996145743644, 12016.550714774872]), "尺寸线 a");
  assert.ok(near(pts[0][1], [2249.9996145743717, 124076.17290614283]), "尺寸线 b");
  assert.ok(near(pts[1][0], [6749.999614574364, 12016.550714774872]), "界线 1 a");
  assert.ok(near(pts[2][1], [1874.9996145743717, 124076.17290614283]), "界线 2 b");
  /* 箭头：直接用 ticks[].a/b，不是按 rotation/size 自己算的 45° */
  assert.ok(near(pts[3][0], [2324.9996145743644, 11941.550714774872]), "箭头 1 a");
  assert.ok(near(pts[3][1], [2174.9996145743644, 12091.550714774872]), "箭头 1 b");
  assert.ok(near(pts[4][0], [2324.9996145743717, 124001.17290614283]), "箭头 2 a");
  assert.ok(near(pts[4][1], [2174.9996145743717, 124151.17290614283]), "箭头 2 b");
});

test("v62 text_point 优先：MTEXT 正中附着在载荷中点，50 = 弧度转度", () => {
  const res = injectUdoGeometry(dxfFixture(150), dumpData([dimensionGeomEntity()]), {
    startHandle: 0x700,
    layers: new Set(["0", "G-GRID-DIMS"]),
  });
  const mtexts = entitiesOf(res.text).filter((e) => e.type === "MTEXT");
  assert.equal(mtexts.length, 1, "有 text_point 的段用 MTEXT（中点语义）");
  const m = mtexts[0];
  assert.equal(pair(m, "71"), "5", "附着点 = 正中");
  assert.equal(pair(m, "72"), "1");
  assert.equal(pair(m, "1"), "112060");
  assert.equal(pair(m, "40"), "446.25");
  assert.equal(pair(m, "50"), "90", "π/2 弧度 → 90°");
  assert.equal(pair(m, "8"), "G-GRID-DIMS");
  assert.equal(pair(m, "62"), null, "不写 62 = BYLAYER");
  /* 10/20 = text_point.p（不偏半个字长、不沿法向猜） */
  assert.ok(Math.abs(Number(pair(m, "10")) - 1837.499614574368) < 1e-5);
  assert.ok(Math.abs(Number(pair(m, "20")) - 68046.36181045885) < 1e-5);
  /* 回退段仍是 TEXT，位置按 v59 的 DIM_TEXT_OFFSET_K 估算（左法向 = +y） */
  const texts = entitiesOf(res.text).filter((e) => e.type === "TEXT");
  assert.equal(texts.length, 1);
  assert.equal(pair(texts[0], "1"), "4950");
  assert.equal(pair(texts[0], "50"), null, "水平文字不写 50");
  assert.ok(
    Math.abs(Number(pair(texts[0], "20")) - (12016.55 + DIM_TEXT_OFFSET_K * 446.25)) < 1e-5,
    "缺 text_point → 回退估算"
  );
});

test("v62 标注几何沿用 ownerAnchor 容器规则：几何进块定义，文字仍摊平到顶层", () => {
  const src = blockFixture({ blockLines: blockLine(0, 0, 10000, 30000) });
  const res = injectUdoGeometry(src, dumpData([dimensionGeomEntity()]), {
    startHandle: 0x700,
    layers: new Set(["0", "WALL", "PUB_TEXT", "G-GRID-DIMS"]),
  });
  assert.deepEqual(res.owners, { PLAN: 1 }, "容器规则不变：锚点落在块内 → 归属块 PLAN");
  assert.equal((res.text.match(/LWPOLYLINE/g) || []).length, 5, "5 条几何只写一份");
  const blkHead = res.text.indexOf("2\nPLAN");
  const blkEnd = res.text.indexOf("0\nENDBLK");
  const lw = res.text.indexOf("LWPOLYLINE");
  assert.ok(lw > blkHead && lw < blkEnd, "几何在块定义内部");
  const top = entitiesSection(res.text);
  assert.equal(top.includes("LWPOLYLINE"), false, "顶层没有重复几何");
  assert.ok(top.includes("MTEXT"), "数值文字仍写顶层");
  /* INSERT 恒等（at 0,0 / scale 1 / rot 0）→ 世界坐标 = 载荷中的中点 */
  const m = entitiesOf(res.text).find((e) => e.type === "MTEXT");
  assert.ok(Math.abs(Number(pair(m, "10")) - 1837.499614574368) < 1e-5);
  assert.ok(Math.abs(Number(pair(m, "20")) - 68046.36181045885) < 1e-5);
});

test("v62 candidate 标注：即便带完整几何也不注入（字节不变）", () => {
  const src = dxfFixture(150);
  const cand = dimensionGeomEntity();
  cand.decode.status = "candidate";
  const res = injectUdoGeometry(src, dumpData([cand]), { startHandle: 0x700 });
  assert.equal(res.text, src, "一个字节都不动");
  assert.equal(res.injected, 0);
  assert.equal(res.primitivesByKind.dimension, 0);
  assert.equal(res.byKind.dimension, 0);
});

test("v62 几何容错：非有限坐标/零长度跳过，不影响文字", () => {
  const bad = dimensionGeomEntity({}, {
    segments: [
      {
        value: 10,
        p1: [0, 0],
        p2: [10, 0],
        text: "10",
        dim_line: { a: [0, 0], b: [10, 0] },
        ext_lines: [
          { a: [0, 0], b: [0, 0] }, // 零长度 → 跳过
          { a: [10, 0], b: null }, // 坏坐标 → 跳过
        ],
        ticks: [{ a: [NaN, 0], b: [1, 1] }], // 坏坐标 → 跳过
        text_point: { p: [5, 3], rotation: 0 },
      },
    ],
  });
  const res = injectUdoGeometry(dxfFixture(150), dumpData([bad]), {
    startHandle: 0x700,
    layers: new Set(["0", "G-GRID-DIMS"]),
  });
  assert.equal(res.primitivesByKind.dimension, 2, "1 条尺寸线 + 1 条文字");
  const ents = entitiesOf(res.text);
  assert.equal(ents.filter((e) => e.type === "LWPOLYLINE").length, 1);
  assert.equal(ents.filter((e) => e.type === "MTEXT").length, 1);
});

/* ───────────────────────────── 三类混合 ───────────────────────────── */

test("三类混合：计数按类分开，primitives 把墙体算成两条", () => {
  const dump = dumpData([
    openingEntity(),
    wallEntity(),
    textEntity(),
    { handle: "9", class: "TCH_TEXT", decode: { status: "not_found" } },
    { handle: "A", class: "TCH_ARROW", decode: { status: "not_attempted" } },
  ]);
  dump.stats.udo_entities = 5;
  const res = injectUdoGeometry(dxfFixture(150), dump, {
    startHandle: 0x500,
    layers: new Set(["0", "A-DOOR", "WALL", "地库增加范围"]),
  });
  assert.equal(res.decoded, 3);
  assert.equal(res.injected, 3);
  assert.deepEqual(res.byKind, { opening: 1, wall: 1, text: 1, dimension: 0 });
  assert.deepEqual(res.primitivesByKind, { opening: 3, wall: 4, text: 1, dimension: 0 });
  assert.equal(res.primitives, 8);
  assert.equal(res.skipped, 2, "detected 5 - injected 3");

  const ents = entitiesOf(res.text);
  assert.equal(ents.filter((e) => e.type === "LWPOLYLINE").length, 7, "洞口 3 + 墙面 2 + 封口 2");
  assert.equal(ents.filter((e) => e.type === "TEXT").length, 1);
});

test("隐藏图层对三类都生效（不做\"复活\"）", () => {
  const res = injectUdoGeometry(dxfFixture(150), dumpData([openingEntity(), wallEntity(), textEntity()]), {
    startHandle: 0x500,
    layers: new Set(["0", "A-DOOR", "WALL", "地库增加范围"]),
    hiddenLayers: new Set(["WALL"]),
  });
  assert.equal(res.injected, 2, "墙体被隐藏层挡掉");
  assert.equal(res.hidden, 1);
  assert.equal(res.byKind.wall, 0);
});

/* ───────────────────────────── dump 落盘 / 读取 ───────────────────────────── */

test("persistUdoDump + loadUdoDump：往返一致；坏文件不抛", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "udo-dump-"));
  const data = dumpData([openingEntity()]);
  const written = persistUdoDump(dir, data);
  assert.ok(written && fs.existsSync(written));
  assert.equal(path.basename(written), "udo-dump.json", "一律写新文件名");
  const loaded = await loadUdoDump({ dumpPath: written });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.source, "cache");
  assert.equal(loaded.data.entities.length, 1);

  const broken = path.join(dir, "broken.json");
  fs.writeFileSync(broken, "{ not json");
  const bad = await loadUdoDump({ dumpPath: broken });
  assert.equal(bad.ok, false);

  // 没有 dumpPath、源也不是 DWG → ok:false
  const none = await loadUdoDump({ sourcePath: path.join(dir, "a.dxf") });
  assert.equal(none.ok, false);
});

test("loadUdoDump：新文件名不存在时回退读旧名 tch-dump.json（只读兼容）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "udo-legacy-dump-"));
  const legacy = path.join(dir, "tch-dump.json");
  fs.writeFileSync(legacy, JSON.stringify({ schema_version: 1, data: dumpData([openingEntity()]) }));
  const got = await loadUdoDump({ dumpPath: path.join(dir, "udo-dump.json") });
  assert.equal(got.ok, true);
  assert.equal(got.source, "cache");
  assert.equal(got.data.entities.length, 1);
  assert.equal(fs.existsSync(path.join(dir, "udo-dump.json")), false, "兼容读取不写新文件");
});

/* ───────────────────────────── buildWebDxf 接入 ───────────────────────────── */

test("buildWebDxf(v51)：没有 dump 时产出与关闭自定义对象解析逐字节相同（SHA 对照）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "udo-web-none-"));
  const src = path.join(dir, "f.dxf");
  fs.writeFileSync(src, dxfFixture(), "utf8");

  const outA = path.join(dir, "a.dxf");
  const outB = path.join(dir, "b.dxf");
  const statsA = await buildWebDxf(src, outA, null, {
    shxText: false,
    udoDumpPath: path.join(dir, "missing-udo-dump.json"),
  });
  const statsB = await buildWebDxf(src, outB, null, { shxText: false, udo: false });

  const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  assert.equal(sha(outA), sha(outB), "无自定义对象时必须逐字节一致");
  assert.equal(statsA.udoInjected, 0);
  assert.equal(statsA.udoDetected, 0);
  assert.equal(statsB.udoInjected, 0);
  assert.equal(fs.readFileSync(outA, "utf8").includes("LWPOLYLINE"), false);
});

test("buildWebDxf(v51)：传入 dump → 洞口/墙体/文字都出现在产物里，分类计数正确", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "udo-web-yes-"));
  const src = path.join(dir, "f.dxf");
  fs.writeFileSync(src, dxfFixture(150), "utf8");
  const dumpPath = path.join(dir, "udo-dump.json");
  const data = dumpData([
    openingEntity(),
    openingEntity({ handle: "4ADE3" }),
    wallEntity(),
    textEntity(),
  ]);
  data.stats.udo_entities = 4;
  fs.writeFileSync(dumpPath, JSON.stringify({ schema_version: 1, data }));

  const out = path.join(dir, "web.dxf");
  const stats = await buildWebDxf(src, out, null, { shxText: false, udoDumpPath: dumpPath });
  assert.equal(stats.udoDetected, 4);
  assert.equal(stats.udoDecoded, 4);
  assert.equal(stats.udoInjected, 4);
  assert.equal(stats.udoOpenings, 2);
  assert.equal(stats.udoWalls, 1);
  assert.equal(stats.udoTexts, 1);
  assert.equal(stats.udoPrimitives, 11, "2 洞口 ×(矩形+门扇+弧) + 2 墙面 + 2 封口 + 1 文字");
  assert.equal(stats.udoSkipped, 0);

  const text = fs.readFileSync(out, "utf8");
  const ents = entitiesOf(text);
  const lines = ents.filter((e) => e.type === "LWPOLYLINE");
  assert.equal(lines.length, 10, "2 个洞口 ×3 + 墙体 2 面 + 封口 2");
  assert.ok(lines.some((e) => pair(e, "8") === "WALL" && pair(e, "70") === "0"));
  assert.ok(lines.some((e) => pair(e, "8") === "A-DOOR" && pair(e, "70") === "1"));
  const t = ents.find((e) => e.type === "TEXT");
  assert.equal(pair(t, "1"), "车库减小范围");
  assert.equal(pair(t, "40"), "150");
  // 句柄必须大于文件里原有的最大句柄（E1），不能撞号
  for (const e of [...lines, t]) assert.ok(parseInt(pair(e, "5"), 16) > 0xe1);

  // v54 版本号进了产物名，缓存随之失效（AEC_* 机柜图必须重建）
  assert.ok(DXF_WEB_VERSION >= 54);
});

test("buildWebDxf(v51)：聚焦涂灰对注入洞口同样生效（在 applyFocus 之前注入）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "udo-web-focus-"));
  const src = path.join(dir, "f.dxf");
  fs.writeFileSync(src, dxfFixture(), "utf8");
  const dumpPath = path.join(dir, "udo-dump.json");
  fs.writeFileSync(dumpPath, JSON.stringify({ data: dumpData([openingEntity()]) }));

  const out = path.join(dir, "web.dxf");
  await buildWebDxf(src, out, { kind: "layer", name: "0", spec: "layer:0" }, {
    shxText: false,
    udoDumpPath: dumpPath,
  });
  const lw = entitiesOf(fs.readFileSync(out, "utf8")).find((e) => e.type === "LWPOLYLINE");
  assert.equal(pair(lw, "62"), "8", "非聚焦图层的洞口被涂灰（与原生实体一致）");
});

/* ─────────────────────── v57：天正对象回宿主块定义 ─────────────────────── */

/** 带 BLOCKS/INSERT 的最小 DXF：一个块 `PLAN`，内容由 `blockLines` 给（块内坐标）。
 *  `inserts` 给了就按数组写多条 INSERT（同一块被摆多次 = 多张图幅）。 */
function blockFixture({ blockLines = [], insert = { at: [0, 0], scale: [1, 1], rot: 0 }, inserts = null, base = [0, 0] } = {}) {
  const list = Array.isArray(inserts) && inserts.length ? inserts : [insert];
  return [
    "0", "SECTION", "2", "TABLES",
    "0", "TABLE", "2", "LAYER",
    "0", "LAYER", "2", "0", "70", "0", "62", "7",
    "0", "LAYER", "2", "WALL", "70", "0", "62", "7",
    "0", "LAYER", "2", "PUB_TEXT", "70", "0", "62", "7",
    "0", "ENDTAB", "0", "ENDSEC",
    "0", "SECTION", "2", "BLOCKS",
    "0", "BLOCK", "8", "0", "2", "PLAN", "70", "0",
    "10", String(base[0]), "20", String(base[1]), "3", "PLAN", "1", "",
    ...blockLines,
    "0", "ENDBLK", "5", "E800", "8", "0",
    "0", "ENDSEC",
    "0", "SECTION", "2", "ENTITIES",
    ...list.flatMap((it, i) => [
      "0", "INSERT", "5", (0xe900 + i).toString(16).toUpperCase(), "8", "0", "2", "PLAN",
      "10", String(it.at[0]), "20", String(it.at[1]),
      "41", String(it.scale?.[0] ?? 1), "42", String(it.scale?.[1] ?? 1), "50", String(it.rot ?? 0),
    ]),
    "0", "ENDSEC",
    "0", "EOF", "",
  ].join("\n");
}

/** 块内一条 LINE（把块内容 bbox 撑到给定范围） */
function blockLine(x0, y0, x1, y1, layer = "WALL") {
  return ["0", "LINE", "8", layer, "10", String(x0), "20", String(y0), "11", String(x1), "21", String(y1)];
}

/** 取 ENTITIES 段文本（块定义不参与） */
function entitiesSection(text) {
  const i = text.indexOf("2\nENTITIES");
  if (i < 0) return "";
  return text.slice(i);
}

const LAYERS3 = new Set(["0", "WALL", "PUB_TEXT"]);

test("v57 归属：自定义对象在块定义的坐标范围内 → 几何写进 BLOCK…ENDBLK，不进 ENTITIES", () => {
  const src = blockFixture({ blockLines: blockLine(18000, 13000, 22000, 15000) });
  const res = injectUdoGeometry(src, dumpData([wallEntity()]), {
    startHandle: 0x300,
    layers: LAYERS3,
  });
  assert.deepEqual(res.owners, { PLAN: 1 }, "归属到块 PLAN");
  assert.deepEqual(res.warnings, []);

  const blkHead = res.text.indexOf("2\nPLAN");
  const blkEnd = res.text.indexOf("0\nENDBLK");
  const lw = res.text.indexOf("LWPOLYLINE");
  assert.ok(lw > blkHead && lw < blkEnd, "几何在块定义内部");
  assert.equal(entitiesSection(res.text).includes("LWPOLYLINE"), false, "顶层没有重复几何");
  // 只写一份：块被 INSERT 两次也只有一份几何
  assert.equal((res.text.match(/LWPOLYLINE/g) || []).length, res.primitivesByKind.wall);
});

test("v57 归属：坐标不在任何块里（模型空间直属）→ 仍注入顶层", () => {
  const src = blockFixture({ blockLines: blockLine(0, 0, 1000, 1000) });
  const res = injectUdoGeometry(src, dumpData([wallEntity()]), {
    startHandle: 0x300,
    layers: LAYERS3,
  });
  assert.deepEqual(res.owners, { "": 1 });
  assert.deepEqual(res.warnings, ["owner_not_found"], "图里有块但这些坐标不在块里 → 记 warning");
  assert.ok(entitiesSection(res.text).includes("LWPOLYLINE"), "几何在顶层 ENTITIES");
});

test("v57 归属：只覆盖一半对象（不唯一）→ 回退顶层并记 warning，绝不丢几何", () => {
  const src = blockFixture({ blockLines: blockLine(18000, 13000, 22000, 15000) });
  const far = textEntity({ handle: "703" }, { position: [900000, 900000, 0] });
  const res = injectUdoGeometry(src, dumpData([wallEntity(), far]), {
    startHandle: 0x300,
    layers: LAYERS3,
  });
  assert.deepEqual(res.owners, { "": 2 }, "全部退回顶层");
  assert.equal(res.warnings.length, 1);
  assert.match(res.warnings[0], /^owner_not_dominant:PLAN:1\/2$/);
  assert.equal(res.byKind.wall, 1);
  assert.equal(res.byKind.text, 1);
  assert.equal((res.text.match(/LWPOLYLINE/g) || []).length, res.primitivesByKind.wall);
});

test("v57 变换：块内文字按 INSERT 的 旋转/平移 换算到世界坐标（每个实例一份）", () => {
  // 块内容 0..1000，INSERT 到 (5000,2000) 旋转 90°：块内 (100,50) → 世界 (4950,2100)
  const src = blockFixture({
    blockLines: blockLine(0, 0, 1000, 1000),
    insert: { at: [5000, 2000], scale: [1, 1], rot: 90 },
  });
  const text = textEntity({ handle: "704" }, { position: [100, 50, 0], content: "配电室" });
  const res = injectUdoGeometry(src, dumpData([text]), {
    startHandle: 0x400,
    layers: LAYERS3,
    textHeight: 300,
  });
  assert.deepEqual(res.owners, { PLAN: 1 });
  const t = entitiesOf(res.text).find((e) => e.type === "TEXT");
  assert.equal(pair(t, "1"), "配电室");
  assert.equal(Number(pair(t, "10")).toFixed(3), "4950.000");
  assert.equal(Number(pair(t, "20")).toFixed(3), "2100.000");
  assert.equal(pair(t, "50"), "90", "文字跟着块旋转");
  assert.equal(pair(t, "40"), "300");
});

test("v57 同一块被摆两份（两张图幅）：几何只写一份，文字每个实例一份", () => {
  // 机柜图的【三层新增设备平面图】/【三层新增走线架平面图】就是同一个块的两条 INSERT
  const src = blockFixture({
    blockLines: blockLine(0, 0, 1000, 1000),
    inserts: [{ at: [5000, 0] }, { at: [9000, 0] }],
  });
  const text = textEntity({ handle: "705" }, { position: [100, 50, 0], content: "弱电间" });
  const wall = wallEntity();
  wall.decode.wall.start = [100, 900, 0];
  wall.decode.wall.end = [900, 900, 0];
  const res = injectUdoGeometry(src, dumpData([wall, text]), {
    startHandle: 0x400,
    layers: LAYERS3,
    textHeight: 300,
  });
  assert.deepEqual(res.owners, { PLAN: 2 }, "两个对象都归属到这个块");

  // 几何：块定义里只有一份（墙面线 2 条 + 2 个封口 = 4 条），不随实例变多
  const blkHead = res.text.indexOf("2\nPLAN");
  const blkEnd = res.text.indexOf("0\nENDBLK");
  const inBlock = res.text.slice(blkHead, blkEnd);
  assert.equal((inBlock.match(/LWPOLYLINE/g) || []).length, res.primitivesByKind.wall);
  assert.equal(entitiesSection(res.text).includes("LWPOLYLINE"), false, "顶层没有几何副本");

  // 文字：顶层两份，落在两个实例各自的世界坐标上
  const texts = entitiesOf(res.text).filter((e) => e.type === "TEXT");
  assert.equal(texts.length, 2);
  const xs = texts.map((t) => Number(pair(t, "10"))).sort((a, b) => a - b);
  assert.deepEqual(xs, [5100, 9100], "5000+100 与 9000+100");
  for (const t of texts) {
    assert.equal(pair(t, "1"), "弱电间");
    assert.equal(pair(t, "20"), "50");
    assert.equal(pair(t, "40"), "300");
  }
});

test("v57 字高：dump 不带字高、$TEXTSIZE 是没人用的默认值 → 用图里已有文字的中位数", () => {
  const src = [
    "0", "SECTION", "2", "HEADER", "9", "$TEXTSIZE", "40", "2.5", "0", "ENDSEC",
    "0", "SECTION", "2", "TABLES",
    "0", "TABLE", "2", "LAYER",
    "0", "LAYER", "2", "0", "70", "0", "62", "7",
    "0", "LAYER", "2", "PUB_TEXT", "70", "0", "62", "7",
    "0", "ENDTAB", "0", "ENDSEC",
    "0", "SECTION", "2", "ENTITIES",
    ...["新风机房", "配电室", "前室"].flatMap((s, i) => [
      "0", "TEXT", "8", "PUB_TEXT", "10", String(i * 1000), "20", "0", "40", "400", "1", s,
    ]),
    "0", "ENDSEC",
    "0", "SECTION", "2", "BLOCKS", "0", "ENDSEC",
    "0", "EOF", "",
  ].join("\n");
  const res = injectUdoGeometry(src, dumpData([textEntity()]), {
    startHandle: 0x500,
    layers: new Set(["0", "PUB_TEXT", "地库增加范围"]),
  });
  assert.equal(res.textHeight, 400, "取中位数 400，而不是 $TEXTSIZE 的 2.5");
  const t = entitiesOf(res.text).filter((e) => e.type === "TEXT").pop();
  assert.equal(pair(t, "40"), "400");
});

/* ───────────────── v64：按记录回注 origin.block（消除双重变换） ─────────────────
 * CLI（gen-47 起）把块内天正对象翻译到世界坐标，并在 `decode.origin` 里给出
 * `{point, block, applied}`。server v63 仍用世界坐标挑"唯一 dominant owner"，
 * 于是几何被塞进错误的块、又被该块 INSERT 变换一次 —— 智能化图纸的墙因此全跑进
 * BLOCK:BZZ 的坐标系里（位置差约 1.3 km）。下面这些用例锁住 v64 的规则。 */

/** dump 里补上 `diagnostics.origins.in_scope`（模拟 CLI 逐条给出宿主块的文件） */
function originDump(entities, inScope = true) {
  const data = dumpData(entities);
  data.diagnostics = { origins: { mode: "auto", in_scope: inScope } };
  return data;
}

/** 收集一份 DXF 里所有 LWPOLYLINE 的 10/20 组码值（含块定义内的，v64 需要）。 */
function allPolylines(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let cur = null;
  let type = "";
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const c = lines[i].trim();
    const v = lines[i + 1].trim();
    if (c === "0") {
      if (cur) out.push(cur);
      cur = v === "LWPOLYLINE" ? { closed: false, pts: [] } : null;
      type = v;
      continue;
    }
    if (!cur || type !== "LWPOLYLINE") continue;
    if (c === "70" && ((parseInt(v, 10) || 0) & 1) === 1) cur.closed = true;
    else if (c === "10") cur.px = Number(v);
    else if (c === "20" && cur.px !== undefined) {
      cur.pts.push([cur.px, Number(v)]);
      cur.px = undefined;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** 所有 LWPOLYLINE 顶点的 x / y 分量（去重前）。 */
function polylinePoints(text) {
  const xs = [];
  const ys = [];
  for (const p of allPolylines(text)) {
    for (const [x, y] of p.pts) {
      xs.push(x);
      ys.push(y);
    }
  }
  return { xs, ys };
}

/** 去重 + 排序 + 收到 0.001（断言坐标用，浮点噪声不影响判断）。 */
function uniqNums(a) {
  return [...new Set(a.map((v) => Number(v.toFixed(3))))].sort((x, y) => x - y);
}

test("originShift：只有 applied + block 齐全才回注，缺一项都不猜", () => {
  assert.deepEqual(
    originShift({ origin: { point: [1, 2, 0], block: "PLAN", applied: true } }),
    { block: "PLAN", dx: 1, dy: 2, dz: 0 }
  );
  assert.equal(originShift({ origin: { point: [1, 2, 0], block: "PLAN", applied: false } }), null);
  assert.equal(originShift({ origin: { point: [1, 2, 0], block: null, applied: true } }), null);
  assert.equal(originShift({ origin: { point: [NaN, 2, 0], block: "PLAN", applied: true } }), null);
  assert.equal(originShift({}), null);
  assert.equal(originShift(null), null);
});

test("localizeEntity：四类几何都按 origin.point 平移，dump 原文不被改", () => {
  const s = { block: "PLAN", dx: 5000, dy: 7000, dz: 0 };
  const dim = {
    handle: "D1",
    class: "TCH_DIMENSION2",
    layer: "G-GRID-DIMS",
    decode: {
      class: "TCH_DIMENSION2",
      kind: "dimension",
      status: "decoded",
      dimension: {
        p1: [5010, 7020, 0],
        angle: 0,
        segments: [
          {
            value: 10,
            p1: [5010, 7020],
            p2: [5020, 7020],
            dim_line: { a: [5010, 7030], b: [5020, 7030] },
            ext_lines: [
              { a: [5010, 7020], b: [5010, 7040] },
              { a: [5020, 7020], b: [5020, 7040] },
            ],
            ticks: [{ p: [5010, 7030], a: [5009, 7029], b: [5011, 7031] }],
            text_point: { p: [5015, 7040], rotation: 0 },
          },
        ],
        text_anchor: [5015, 7040],
      },
    },
  };
  const local = localizeEntity(dim, s);
  assert.deepEqual(local.decode.dimension.p1, [10, 20, 0]);
  const seg = local.decode.dimension.segments[0];
  assert.deepEqual(seg.p1, [10, 20]);
  assert.deepEqual(seg.p2, [20, 20]);
  assert.deepEqual(seg.dim_line, { a: [10, 30], b: [20, 30] });
  assert.deepEqual(seg.ext_lines[1], { a: [20, 20], b: [20, 40] });
  assert.deepEqual(seg.ticks[0], { p: [10, 30], a: [9, 29], b: [11, 31] });
  assert.deepEqual(seg.text_point, { p: [15, 40], rotation: 0 });
  assert.deepEqual(local.decode.dimension.text_anchor, [15, 40]);
  // 值本身一个不动
  assert.equal(seg.value, 10);
  // 原 dump 不因注入被就地改写
  assert.deepEqual(dim.decode.dimension.p1, [5010, 7020, 0]);
  assert.deepEqual(dim.decode.dimension.segments[0].ticks[0].p, [5010, 7030]);
});

test("v64 墙：世界坐标 − origin.point → 写进 origin.block 的块定义（数字回到载荷原文）", () => {
  // 块内坐标 (1500,2000)-(2500,2000)，块基点 0，INSERT 在 (5000,7000) → 世界坐标 = +5000/+7000
  const src = blockFixture({ blockLines: blockLine(1000, 1000, 3000, 3000) });
  const w = wallEntity();
  w.decode.wall.start = [6500, 9000, 0];
  w.decode.wall.end = [7500, 9000, 0];
  w.decode.origin = { point: [5000, 7000, 0], block: "PLAN", source: "block_insert", applied: true };
  const res = injectUdoGeometry(src, originDump([w]), { startHandle: 0x300, layers: LAYERS3 });

  assert.deepEqual(res.owners, { PLAN: 1 }, "按 origin.block 回注，不再拿世界坐标猜归属");
  const blkHead = res.text.indexOf("2\nPLAN");
  const blkEnd = res.text.indexOf("0\nENDBLK");
  assert.ok(res.text.indexOf("LWPOLYLINE") > blkHead && res.text.indexOf("LWPOLYLINE") < blkEnd);
  assert.equal(entitiesSection(res.text).includes("LWPOLYLINE"), false, "顶层没有副本");
  const { xs, ys } = polylinePoints(res.text);
  assert.deepEqual(uniqNums(xs), [1500, 2500], "块内坐标，不是世界坐标");
  assert.deepEqual(uniqNums(ys), [1920, 2100], "左 100 / 右 80 的两条墙面线");
});

test("v64 洞口：矩形/门扇/弧都按块内坐标写进块定义（门不会漂到块外）", () => {
  const src = blockFixture({ blockLines: blockLine(0, 0, 20000, 20000) });
  const o = openingEntity();
  const worldQuad = openingQuad(o.decode.opening);
  const point = [5000, 7000, 0];
  o.decode.origin = { point, block: "PLAN", source: "block_insert", applied: true };
  const res = injectUdoGeometry(src, originDump([o]), {
    startHandle: 0x300,
    layers: new Set(["0", "A-DOOR"]),
  });
  assert.deepEqual(res.owners, { PLAN: 1 });
  const closed = allPolylines(res.text).find((p) => p.closed);
  assert.ok(closed, "洞口矩形是闭合 LWPOLYLINE");
  const got = closed.pts;
  assert.equal(got.length, 4);
  for (let i = 0; i < 4; i++) {
    assert.ok(Math.abs(got[i][0] - (worldQuad[i][0] - point[0])) < 1e-6, `顶点 ${i} x`);
    assert.ok(Math.abs(got[i][1] - (worldQuad[i][1] - point[1])) < 1e-6, `顶点 ${i} y`);
  }
});

test("v64 同一块两份 INSERT：几何只写一份，文字每个实例各一份（两份副本都显示）", () => {
  const src = blockFixture({
    blockLines: blockLine(0, 0, 1000, 1000),
    inserts: [{ at: [5000, 0] }, { at: [9000, 0] }],
  });
  const point = [5000, 0, 0]; // 第一条 INSERT 决定的 origin（CLI 只报一条）
  const w = wallEntity();
  w.decode.wall.start = [5100, 900, 0];
  w.decode.wall.end = [5900, 900, 0];
  w.decode.origin = { point, block: "PLAN", source: "block_insert", applied: true };
  const t = textEntity({ handle: "705" }, { position: [5100, 50, 0], content: "弱电间", height: 300 });
  t.decode.origin = { point, block: "PLAN", source: "block_insert", applied: true };
  const res = injectUdoGeometry(src, originDump([w, t]), {
    startHandle: 0x400,
    layers: new Set(["0", "WALL", "地库增加范围"]),
  });
  assert.deepEqual(res.owners, { PLAN: 2 });

  // 几何：块定义里只有一份（两份副本由两条 INSERT 各自变换）
  const blkHead = res.text.indexOf("2\nPLAN");
  const blkEnd = res.text.indexOf("0\nENDBLK");
  const inBlock = res.text.slice(blkHead, blkEnd);
  assert.equal((inBlock.match(/LWPOLYLINE/g) || []).length, res.primitivesByKind.wall);
  assert.equal(entitiesSection(res.text).includes("LWPOLYLINE"), false);
  const { xs } = polylinePoints(inBlock);
  assert.deepEqual(uniqNums(xs), [100, 900], "块内坐标");

  // 文字：两个实例各一份，分别落在 5000+100 与 9000+100
  const texts = entitiesOf(res.text).filter((e) => e.type === "TEXT");
  assert.equal(texts.length, 2);
  assert.deepEqual(
    texts.map((e) => Number(pair(e, "10"))).sort((a, b) => a - b),
    [5100, 9100]
  );
});

test("v64 origin.block 在本 DXF 里不存在 → 顶层世界坐标 + warning（不写错块）", () => {
  const src = blockFixture({ blockLines: blockLine(0, 0, 1000, 1000) });
  const w = wallEntity();
  w.decode.wall.start = [6500, 9000, 0];
  w.decode.wall.end = [7500, 9000, 0];
  w.decode.origin = { point: [5000, 7000, 0], block: "NOPE", source: "block_insert", applied: true };
  const res = injectUdoGeometry(src, originDump([w]), { startHandle: 0x300, layers: LAYERS3 });
  assert.deepEqual(res.owners, { "": 1 });
  assert.deepEqual(res.warnings, ["origin_block_missing:NOPE"]);
  const { xs } = polylinePoints(res.text);
  assert.deepEqual(uniqNums(xs), [6500, 7500], "世界坐标原样（不减 point）");
});

test("v64 in_scope 的 dump 不做 dominant-owner 猜测：模型空间对象留在顶层", () => {
  // 世界坐标 (18650..21350, 14300) 恰好落在块 PLAN 的 bbox 内 —— v63 会把这些墙塞进
  // PLAN（双重变换）。模型空间对象本来就没有 origin，必须留在顶层。
  const src = blockFixture({ blockLines: blockLine(18000, 13000, 22000, 15000) });
  const res = injectUdoGeometry(src, originDump([wallEntity()]), {
    startHandle: 0x300,
    layers: LAYERS3,
  });
  assert.deepEqual(res.owners, { "": 1 });
  assert.deepEqual(res.warnings, [], "不再产生 owner_not_dominant / owner_not_found");
  assert.ok(entitiesSection(res.text).includes("LWPOLYLINE"));
  const { xs } = polylinePoints(res.text);
  assert.deepEqual(uniqNums(xs), [18649.994, 21349.994]);
});

test("v64 老 dump（没有 diagnostics.origins）行为一字不变：仍按面积最小块归属", () => {
  const src = blockFixture({ blockLines: blockLine(18000, 13000, 22000, 15000) });
  const res = injectUdoGeometry(src, dumpData([wallEntity()]), {
    startHandle: 0x300,
    layers: LAYERS3,
  });
  assert.deepEqual(res.owners, { PLAN: 1 }, "与 v57 相同：锚点落在块内 → 写进块定义");
  assert.equal(entitiesSection(res.text).includes("LWPOLYLINE"), false);
});

/* ── v64：缓存里的旧 dump 必须自动重解，否则修复不生效（重启后第一次开图） ── */

test("udoDumpNeedsRefresh：只认作用域内的旧格式，施工005/机柜图纸永远不重解", () => {
  const wall = (origin) => {
    const e = wallEntity();
    if (origin) e.decode.origin = origin;
    return e;
  };
  /* 1. v63 的 dump：有 origin 但没有 block → 旧 */
  const v63 = { ...dumpData([wall({ point: [1, 2, 0], applied: true, source: "block_insert" })]), dwg_version: "AC1018" };
  v63.entities.push({ class: "AEC_WALL", decode: {} });
  assert.equal(udoDumpNeedsRefresh(v63), true);
  /* 2. 新 dump：origin.block 在 → 不旧 */
  const v64 = { ...dumpData([wall({ point: [1, 2, 0], block: "PLAN", applied: true, source: "block_insert" })]), dwg_version: "AC1018" };
  v64.entities.push({ class: "AEC_WALL", decode: {} });
  assert.equal(udoDumpNeedsRefresh(v64), false);
  /* 3. gen-47 之前的 dump：连 diagnostics.origins 都没有 → 旧 */
  const older = { ...dumpData([wall(null)]), dwg_version: "AC1018" };
  older.entities.push({ class: "AEC_WALL", decode: {} });
  assert.equal(udoDumpNeedsRefresh(older), true);
  /* 4. 作用域内、本来就没有块内对象（origins 在、origin 0 条）→ 不旧（否则每次开图都重解） */
  const allModel = { ...dumpData([wall(null)]), dwg_version: "AC1018", diagnostics: { origins: { in_scope: true, placed: 0 } } };
  allModel.entities.push({ class: "AEC_WALL", decode: {} });
  assert.equal(udoDumpNeedsRefresh(allModel), false);
  /* 5. 作用域外：自定义对象方言（施工005）与 AC1032（机柜）→ 永不重解 */
  assert.equal(udoDumpNeedsRefresh(dumpData([wall({})])), false);
  assert.equal(udoDumpNeedsRefresh({ ...dumpData([wall({})]), dwg_version: "AC1032" }), false);
  /* 6. 0.3.0 之前的 dump 用 tch_entities 记数 → 旧，必须重解 */
  const renamed = { ...dumpData([wall({})]), dwg_version: "AC1032" };
  renamed.stats = { tch_entities: 1234 };
  assert.equal(udoDumpNeedsRefresh(renamed), true);
});

test("loadUdoDump：旧 dump 且没有源 DWG → 仍返回旧 dump（graceful），不抛", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "udo-stale-"));
  const dumpPath = path.join(dir, "udo-dump.json");
  const stale = { ...dumpData([wallEntity()]), dwg_version: "AC1018" };
  stale.entities.push({ class: "AEC_WALL", decode: {} });
  stale.entities[0].decode.origin = { point: [1, 2, 0], applied: true, source: "block_insert" };
  fs.writeFileSync(dumpPath, JSON.stringify({ schema_version: 1, data: stale }));

  const got = await loadUdoDump({ dumpPath });
  assert.equal(got.ok, true);
  assert.equal(got.source, "cache");
  assert.equal(got.stale, true, "标记为旧 dump，调用方据此知道它没有 origin.block");

  /* 新 dump（有 origin.block）不应该被标 stale，也不该触发重解 */
  const fresh = { ...dumpData([wallEntity()]), dwg_version: "AC1018" };
  fresh.entities[0].decode.origin = { point: [1, 2, 0], block: "PLAN", applied: true, source: "block_insert" };
  fresh.entities.push({ class: "AEC_WALL", decode: {} });
  const dumpPath2 = path.join(dir, "fresh.json");
  fs.writeFileSync(dumpPath2, JSON.stringify({ schema_version: 1, data: fresh }));
  const got2 = await loadUdoDump({ dumpPath: dumpPath2 });
  assert.equal(got2.ok, true);
  assert.equal(got2.stale, undefined);
});


