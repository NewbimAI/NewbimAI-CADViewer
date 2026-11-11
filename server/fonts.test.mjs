/**
 * server/fonts.js 单元测试，全部离线运行（除读取本机字体目录外不依赖网络）。
 *   node --test server/fonts.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readFontConfig,
  saveFontConfig,
  listFontFiles,
  resolveFontFile,
  parseStyleTable,
  readStyleTable,
  clearFontIndex,
} from "./fonts.js";

/** 建一个临时 root，可选地在 <root>/fonts 下生成假字体文件。 */
function makeRoot(t, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cadviewer-fonts-"));
  t.after(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* Windows 上偶尔有句柄未释放，忽略 */
    }
  });
  const fontsDir = path.join(root, "fonts");
  fs.mkdirSync(fontsDir, { recursive: true });
  for (const [rel, size] of Object.entries(files)) {
    const p = path.join(fontsDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.alloc(size ?? 8, 0x41));
  }
  return { root, fontsDir };
}

/** 组码/值数组 → DXF 文本。 */
function dxfLines(lines) {
  return lines.join("\n");
}

// ---------------------------------------------------------------- parseStyleTable

test("parseStyleTable: 名称/主字体/大字体/字高/宽度/倾斜/标志", () => {
  const text = dxfLines([
    "0", "SECTION",
    "2", "TABLES",
    "0", "TABLE",
    "2", "STYLE",
    "70", "3",
    "0", "STYLE",
    "2", "Standard",
    "3", "txt.shx",
    "4", "gbcbig.shx",
    "40", "2.5",
    "41", "0.8",
    "50", "15",
    "70", "4",
    "0", "ENDTAB",
    "0", "ENDSEC",
  ]);
  const styles = parseStyleTable(text);
  assert.deepEqual(styles.Standard, {
    font: "txt.shx",
    bigFont: "gbcbig.shx",
    height: 2.5,
    widthFactor: 0.8,
    oblique: 15,
    flags: 4,
  });
});

test("parseStyleTable: 缺省值 + 多个样式", () => {
  const text = dxfLines([
    "0", "STYLE",
    "2", "Standard",
    "3", "txt.shx",
    "0", "STYLE",
    "2", "HZ",
    "3", "hztxt.shx",
  ]);
  const styles = parseStyleTable(text);
  assert.equal(Object.keys(styles).length, 2);
  assert.deepEqual(styles.HZ, {
    font: "hztxt.shx",
    bigFont: "",
    height: 0,
    widthFactor: 1,
    oblique: 0,
    flags: 0,
  });
  // Standard 只给了主字体，其余保持默认
  assert.equal(styles.Standard.height, 0);
  assert.equal(styles.Standard.widthFactor, 1);
});

test("parseStyleTable: 非法/空文本返回 {}", () => {
  assert.deepEqual(parseStyleTable(""), {});
  assert.deepEqual(parseStyleTable("这不是 DXF\n随便写点\n"), {});
  assert.deepEqual(parseStyleTable("0\nVPORT\n2\n*Active\n"), {});
  assert.deepEqual(parseStyleTable(null), {});
});

// ---------------------------------------------------------------- readStyleTable

test("readStyleTable: 没有 TABLES 段返回 {}", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cadviewer-fonts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dxf = path.join(root, "no-tables.dxf");
  fs.writeFileSync(
    dxf,
    dxfLines([
      "0", "SECTION",
      "2", "HEADER",
      "9", "$ACADVER",
      "1", "AC1027",
      "0", "ENDSEC",
      "0", "SECTION",
      "2", "ENTITIES",
      "0", "ENDSEC",
      "0", "EOF",
    ]),
    "utf8"
  );
  assert.deepEqual(readStyleTable(dxf), {});
  assert.deepEqual(readStyleTable(path.join(root, "missing.dxf")), {});
});

test("readStyleTable: 从完整 DXF 的 TABLES 段读出 STYLE", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cadviewer-fonts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dxf = path.join(root, "with-tables.dxf");
  const NAME = "@@STYLE_NAME@@";
  const template = dxfLines([
    "0", "SECTION",
    "2", "HEADER",
    "9", "$DWGCODEPAGE",
    "3", "ANSI_936",
    "0", "ENDSEC",
    "0", "SECTION",
    "2", "TABLES",
    "0", "TABLE",
    "2", "STYLE",
    "0", "STYLE",
    "2", NAME,
    "3", "hztxt.shx",
    "4", "hztxt.shx",
    "40", "0",
    "41", "1.0",
    "0", "ENDTAB",
    "0", "ENDSEC",
    "0", "EOF",
  ]);
  // 样式名用 GBK 字节写（Node 没有 gbk 编码器），验证按 $DWGCODEPAGE 解码。
  const [before, after] = template.split(NAME);
  fs.writeFileSync(
    dxf,
    Buffer.concat([
      Buffer.from(before, "latin1"),
      Buffer.from("b9a4b3ccd7d6", "hex"), // "工程字" 的 GBK 编码
      Buffer.from(after, "latin1"),
    ])
  );
  const styles = readStyleTable(dxf);
  assert.deepEqual(styles["工程字"], {
    font: "hztxt.shx",
    bigFont: "hztxt.shx",
    height: 0,
    widthFactor: 1,
    oblique: 0,
    flags: 0,
  });
});

// ---------------------------------------------------------------- readFontConfig

test("readFontConfig: 无配置 → auto 探测，configured=false", (t) => {
  clearFontIndex();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cadviewer-fonts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const cfg = readFontConfig(root);
  assert.equal(cfg.configured, false);
  assert.equal(cfg.auto, true);
  assert.ok(Array.isArray(cfg.dirs));

  if (process.platform === "win32") {
    const winFonts = path.join(process.env.WINDIR || "C:\\Windows", "Fonts");
    assert.ok(
      cfg.dirs.some((d) => d.toLowerCase() === winFonts.toLowerCase()),
      `应探测到 ${winFonts}，实际：${cfg.dirs.join(", ")}`
    );
  }
});

test("saveFontConfig: 保存/读取往返，目录不存在要报错", (t) => {
  clearFontIndex();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cadviewer-fonts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fontsDir = path.join(root, "fonts");
  fs.mkdirSync(fontsDir);

  const saved = saveFontConfig(root, { dirs: [fontsDir], auto: false });
  assert.equal(saved.configured, true);
  assert.equal(saved.auto, false);
  assert.deepEqual(saved.dirs, [fontsDir]);

  const cfg = readFontConfig(root);
  assert.equal(cfg.configured, true);
  assert.equal(cfg.auto, false);
  assert.deepEqual(cfg.dirs, [fontsDir]);

  // auto 省略时默认 true
  saveFontConfig(root, { dirs: [fontsDir] });
  assert.equal(readFontConfig(root).auto, true);

  assert.throws(
    () => saveFontConfig(root, { dirs: [path.join(root, "not-here")] }),
    /字体目录不存在/
  );
  assert.throws(() => saveFontConfig(root, { dirs: "C:\\Windows\\Fonts" }), /字符串数组/);
  assert.throws(() => saveFontConfig(root, { dirs: [fontsDir], auto: "yes" }), /布尔值/);
});

// ---------------------------------------------------------------- listFontFiles

test("listFontFiles: kind 正确、最多两层、大小写去重", (t) => {
  clearFontIndex();
  const { root, fontsDir } = makeRoot(t, {
    "a.SHX": 11,
    "b.ttf": 22,
    "c.otf": 33,
    "d.ttc": 44,
    "sub/extra.ttf": 55,
    "sub/deep/deep.otf": 66, // 第 3 层，不该出现
  });

  saveFontConfig(root, { dirs: [fontsDir], auto: false });

  const files = listFontFiles(root);
  assert.equal(files.length, 5);
  const byName = new Map(files.map((f) => [f.name.toLowerCase(), f]));
  assert.equal(byName.get("a.shx").kind, "shx");
  assert.equal(byName.get("b.ttf").kind, "ttf");
  assert.equal(byName.get("c.otf").kind, "otf");
  assert.equal(byName.get("d.ttc").kind, "ttc");
  assert.equal(byName.get("extra.ttf").kind, "ttf");
  assert.equal(byName.get("extra.ttf").dir, fontsDir);
  assert.equal(byName.get("extra.ttf").size, 55);
  assert.equal(byName.has("deep.otf"), false);

  // 同一目录换个大小写、以及配置父目录（文件被扫到两次）都不应重复
  const overlapping =
    process.platform === "win32"
      ? [fontsDir, path.join(root, "FONTS"), root]
      : [fontsDir, root];
  saveFontConfig(root, { dirs: overlapping, auto: false });
  const again = listFontFiles(root);
  const paths = again.map((f) => f.path.toLowerCase());
  assert.equal(new Set(paths).size, again.length, "不能出现重复路径");
  assert.equal(again.length, 5);

  // 超过 maxFiles 时截断
  const limited = listFontFiles(root, { maxFiles: 2 });
  assert.equal(limited.length, 2);
  assert.equal(listFontFiles(root, { maxFiles: 0 }).length, 0);
});

// ---------------------------------------------------------------- resolveFontFile

test("resolveFontFile: 精确、大小写、去扩展名、kind 过滤", (t) => {
  clearFontIndex();
  const { root, fontsDir } = makeRoot(t, {
    "a.SHX": 11,
    "b.ttf": 22,
    "same.shx": 33,
    "same.ttf": 44,
  });
  saveFontConfig(root, { dirs: [fontsDir], auto: false });
  clearFontIndex();

  // 精确
  assert.equal(resolveFontFile("b.ttf", root), path.join(fontsDir, "b.ttf"));
  // 大小写不敏感
  assert.equal(resolveFontFile("B.TTF", root), path.join(fontsDir, "b.ttf"));
  // 去扩展名互认：txt.shx ↔ txt
  assert.equal(resolveFontFile("a", root), path.join(fontsDir, "a.SHX"));
  assert.equal(resolveFontFile("a.shx", root), path.join(fontsDir, "a.SHX"));
  assert.equal(resolveFontFile("SAME", root), path.join(fontsDir, "same.shx"));
  // kind 过滤
  assert.equal(
    resolveFontFile("same", root, { kind: "shx" }),
    path.join(fontsDir, "same.shx")
  );
  assert.equal(
    resolveFontFile("same", root, { kind: "ttf" }),
    path.join(fontsDir, "same.ttf")
  );
  assert.equal(resolveFontFile("b", root, { kind: "shx" }), null);
  assert.equal(resolveFontFile("b", root, { kind: "woff" }), null);
  // 不存在
  assert.equal(resolveFontFile("nope.shx", root), null);
  assert.equal(resolveFontFile("", root), null);
});

test("resolveFontFile: 拒绝 ..、绝对路径、路径分隔符", (t) => {
  clearFontIndex();
  const { root, fontsDir } = makeRoot(t, { "b.ttf": 22 });
  saveFontConfig(root, { dirs: [fontsDir], auto: false });
  clearFontIndex();

  assert.equal(resolveFontFile("../b.ttf", root), null);
  assert.equal(resolveFontFile("..", root), null);
  assert.equal(resolveFontFile("sub/../../b.ttf", root), null);
  assert.equal(resolveFontFile("sub\\b.ttf", root), null);
  assert.equal(resolveFontFile(path.join(fontsDir, "b.ttf"), root), null);
  assert.equal(resolveFontFile("C:\\Windows\\Fonts\\simfang.ttf", root), null);
  assert.equal(resolveFontFile("C:b.ttf", root), null);
});

test("resolveFontFile: 符号链接指到目录外 → 拒绝", (t) => {
  clearFontIndex();
  const { root, fontsDir } = makeRoot(t, { "inside.ttf": 22 });
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "evil.shx"), Buffer.alloc(8, 0x45));

  const link = path.join(fontsDir, "link");
  try {
    fs.symlinkSync(outside, link, "junction");
  } catch {
    t.skip("当前系统不允许创建 junction/符号链接");
    return;
  }
  t.after(() => {
    try {
      fs.unlinkSync(link);
    } catch {
      /* ignore */
    }
  });

  saveFontConfig(root, { dirs: [fontsDir], auto: false });
  clearFontIndex();

  // 扫描时会顺着链接看到它（列表接口用于提示用户），但定位必须拒绝
  const listed = listFontFiles(root);
  assert.ok(listed.some((f) => f.name.toLowerCase() === "evil.shx"));

  clearFontIndex();
  assert.equal(resolveFontFile("evil.shx", root), null);
  // 目录内的正常文件仍可解析
  assert.equal(resolveFontFile("inside.ttf", root), path.join(fontsDir, "inside.ttf"));
});

test("clearFontIndex: 新增文件后重新扫描", (t) => {
  clearFontIndex();
  const { root, fontsDir } = makeRoot(t, { "b.ttf": 22 });
  saveFontConfig(root, { dirs: [fontsDir], auto: false });
  clearFontIndex();

  assert.equal(resolveFontFile("b.ttf", root), path.join(fontsDir, "b.ttf"));

  const added = path.join(fontsDir, "new.shx");
  fs.writeFileSync(added, Buffer.alloc(8, 0x53));
  clearFontIndex();

  assert.equal(resolveFontFile("new.shx", root), added);
  assert.equal(
    listFontFiles(root).filter((f) => f.name.toLowerCase() === "new.shx").length,
    1
  );
});
