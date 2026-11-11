/**
 * 字体基础设施：配置、扫描、定位、STYLE 表解析。
 *
 * 只提供"数据与文件定位"，不做任何渲染/字形处理。给两条上层链路用：
 *   · SHX 渲染：按 DXF STYLE 表里的字体名找到本机 SHX/TTF 文件；
 *   · 前端字体：按样式名挑 TTF/OTF/TTC。
 *
 * 安全前提：所有对外返回的字体路径都必须落在配置目录之内（realpath 比较）。
 * 绝不接受 `..`、绝对路径、盘符路径，也不允许符号链接把目录外的文件带进来。
 *
 * 配置：<root>/data/fonts.json
 *   { "dirs": ["D:\\CAD字体"], "auto": true }
 * 无配置时 auto=true，并探测本机常见字体目录（只保留真实存在的）。
 */
import fs from "node:fs";
import path from "node:path";
import { detectCodepageFromText } from "./dxf-codepage.js";

/** 支持的字体扩展名 → kind。 */
const FONT_KINDS = Object.freeze({
  ".shx": "shx",
  ".ttf": "ttf",
  ".otf": "otf",
  ".ttc": "ttc",
});

/** 扫描目录时最多展开的层级：配置目录本身算第 1 层，子目录算第 2 层。 */
const MAX_SCAN_DEPTH = 2;
/** resolveFontFile 的索引重校验间隔（毫秒）。避免每个字符都去 stat 目录。 */
const INDEX_RECHECK_MS = 1000;
/** 自动探测结果缓存（毫秒）。程序目录不会每秒变，没必要反复 readdir。 */
const AUTO_PROBE_TTL_MS = 10_000;

/** 目录扫描缓存：dir(小写) → { stamp, entries }。 */
const dirScanCache = new Map();
/** 解析索引缓存：root(小写) → { stamp, checkedAt, byBase, byStem, realDirs }。 */
const indexCache = new Map();
/** 自动探测目录缓存。 */
let autoProbeCache = { at: 0, dirs: [] };

// ------------------------------------------------------------------ 通用工具

/** Windows 路径大小写不敏感；统一用这个做去重/比较键。 */
function pathKey(p) {
  return path.resolve(p).replace(/[\\/]+$/, "").toLowerCase();
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function dedupeCaseInsensitive(list) {
  const seen = new Set();
  const out = [];
  for (const p of list) {
    if (typeof p !== "string" || !p.trim()) continue;
    const key = pathKey(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(path.resolve(p));
  }
  return out;
}

// ------------------------------------------------------ 自动探测常见字体目录

/** 把 `*`/`?` 通配符段转成正则（只用于目录名匹配）。 */
function globToRegExp(segment) {
  const escaped = segment
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

/**
 * 展开一个简单的目录通配模式，例如
 *   C:\Program Files\Autodesk\AutoCAD 20*\Fonts
 * 只支持路径分隔符分隔的通配段，返回真实存在的目录。
 */
function expandGlob(pattern) {
  try {
    const root = path.parse(pattern).root || path.sep;
    const rest = pattern
      .slice(root.length)
      .split(/[\\/]+/)
      .filter(Boolean);
    let current = [root];
    for (const segment of rest) {
      const wild = segment.includes("*") || segment.includes("?");
      const re = wild ? globToRegExp(segment) : null;
      const next = [];
      for (const base of current) {
        if (!wild) {
          const p = path.join(base, segment);
          if (isDirectory(p)) next.push(p);
          continue;
        }
        let entries = [];
        try {
          entries = fs.readdirSync(base, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (!re.test(entry.name)) continue;
          const p = path.join(base, entry.name);
          if (isDirectory(p)) next.push(p);
        }
      }
      current = next;
    }
    return current;
  } catch {
    return [];
  }
}

/**
 * 探测本机常见字体目录。只返回真实存在的目录（顺序即优先级）。
 * 结果缓存 10 秒，避免每次请求都去 readdir Program Files。
 */
function autoProbeDirs() {
  const now = Date.now();
  if (now - autoProbeCache.at < AUTO_PROBE_TTL_MS) return autoProbeCache.dirs;

  const winDir =
    process.env.WINDIR || process.env.SystemRoot || "C:\\Windows";
  const localAppData = process.env.LOCALAPPDATA || "";
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";

  const patterns = [
    path.join(winDir, "Fonts"),
    localAppData ? path.join(localAppData, "Microsoft", "Windows", "Fonts") : "",
    path.join(programFiles, "Autodesk", "AutoCAD 20*", "Fonts"),
    path.join(programFiles, "Autodesk", "DWG TrueView*", "Fonts"),
    path.join(programFiles, "BricsCAD*", "Fonts"),
    path.join(programFiles, "ZWSOFT", "ZWCAD*", "Fonts"),
  ].filter(Boolean);

  const expanded = [];
  for (const pattern of patterns) {
    if (pattern.includes("*") || pattern.includes("?")) {
      expanded.push(...expandGlob(pattern));
    } else if (isDirectory(pattern)) {
      expanded.push(pattern);
    }
  }
  const dirs = dedupeCaseInsensitive(expanded);
  autoProbeCache = { at: now, dirs };
  return dirs;
}

// ---------------------------------------------------------------- 配置读写

function configPath(root) {
  return path.join(path.resolve(root), "data", "fonts.json");
}

/**
 * 读取字体配置。
 * 无配置（文件不存在 / JSON 坏了）时：auto=true + 探测到的目录，configured=false。
 * 有配置时 dirs 是用户配置的目录；自动目录仍由 listFontFiles 按 auto 合并。
 */
export function readFontConfig(root) {
  const rootAbs = path.resolve(root);
  const file = configPath(rootAbs);

  let raw = null;
  let configured = false;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      raw = parsed;
      configured = true;
    }
  } catch {
    /* 没配置或配置损坏 → 走默认探测 */
  }

  if (!configured) {
    return { dirs: autoProbeDirs(), auto: true, configured: false };
  }

  const dirs = dedupeCaseInsensitive(
    Array.isArray(raw.dirs)
      ? raw.dirs
          .filter((d) => typeof d === "string" && d.trim())
          .map((d) => path.resolve(rootAbs, d))
      : []
  );
  const auto = typeof raw.auto === "boolean" ? raw.auto : true;
  return { dirs, auto, configured: true };
}

/**
 * 保存字体配置。目录必须真实存在（否则抛错，路由转成 400）。
 * 写入是原子的：先写临时文件再 rename，避免半截 JSON。
 * @returns {ReturnType<typeof readFontConfig>} 保存后的生效配置
 */
export function saveFontConfig(root, { dirs, auto } = {}) {
  const rootAbs = path.resolve(root);
  if (!Array.isArray(dirs) || dirs.some((d) => typeof d !== "string")) {
    throw new Error("dirs 必须是字符串数组");
  }
  if (auto !== undefined && typeof auto !== "boolean") {
    throw new Error("auto 必须是布尔值");
  }

  const resolved = [];
  for (const input of dirs) {
    const trimmed = input.trim();
    if (!trimmed) throw new Error("字体目录不能为空");
    const abs = path.resolve(rootAbs, trimmed);
    if (!isDirectory(abs)) {
      throw new Error(`字体目录不存在或不是目录：${abs}`);
    }
    resolved.push(abs);
  }

  const file = configPath(rootAbs);
  const payload = {
    dirs: dedupeCaseInsensitive(resolved),
    auto: auto === undefined ? true : auto,
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, file);
  } catch (e) {
    throw new Error(`保存字体配置失败：${e.message}`);
  }

  // 配置变了 → 索引/扫描缓存全部作废
  clearFontIndex();
  return readFontConfig(rootAbs);
}

// ------------------------------------------------------------------ 目录扫描

/**
 * 目录指纹：目录自身 mtime + 直接子目录的 mtime。
 * 只加文件到子目录里时父目录 mtime 不变，所以必须把子目录也算进来。
 */
function dirStamp(dir) {
  let st;
  try {
    st = fs.statSync(dir);
  } catch {
    return "missing";
  }
  if (!st.isDirectory()) return "notdir";

  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return "unreadable";
  }
  const parts = [String(st.mtimeMs)];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    try {
      const sub = fs.statSync(full);
      if (sub.isDirectory()) parts.push(`${entry.name}:${sub.mtimeMs}`);
    } catch {
      /* 子目录刚被删掉：忽略 */
    }
  }
  return parts.join("|");
}

/** 按扩展名判断 kind；不是字体返回 null。 */
function kindOf(name) {
  return FONT_KINDS[path.extname(name).toLowerCase()] ?? null;
}

/**
 * 扫描一个目录（最多 2 层）并缓存。返回 [{ name, path, dir, kind, size }]。
 * dir 始终是配置目录本身，而不是文件所在的子目录。
 */
function scanDirectory(dir) {
  const key = pathKey(dir);
  const stamp = dirStamp(dir);
  if (stamp === "missing" || stamp === "notdir" || stamp === "unreadable") {
    return [];
  }
  const hit = dirScanCache.get(key);
  if (hit && hit.stamp === stamp) return hit.entries;

  const entries = [];
  const seenNames = new Set();

  const consider = (full, name, size) => {
    const kind = kindOf(name);
    if (!kind) return;
    const lower = name.toLowerCase();
    if (seenNames.has(lower)) return;
    seenNames.add(lower);
    entries.push({ name, path: full, dir, kind, size });
  };

  const scanLevel = (level) => {
    let list = [];
    try {
      list = fs.readdirSync(level, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of list) {
      const full = path.join(level, entry.name);
      let st;
      try {
        st = fs.statSync(full); // 跟随符号链接/目录联接
      } catch {
        continue;
      }
      if (st.isFile()) consider(full, entry.name, st.size);
    }
  };

  // 第 1 层：配置目录本身
  scanLevel(dir);
  if (MAX_SCAN_DEPTH > 1) {
    let top = [];
    try {
      top = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      top = [];
    }
    // 第 2 层：直接子目录
    for (const entry of top) {
      const full = path.join(dir, entry.name);
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) scanLevel(full);
    }
  }

  dirScanCache.set(key, { stamp, entries });
  return entries;
}

/** 配置目录 + 按 auto 合并的探测目录，最后大小写不敏感去重。 */
function effectiveDirs(cfg) {
  const all = [...cfg.dirs];
  if (cfg.auto) all.push(...autoProbeDirs());
  return dedupeCaseInsensitive(all);
}

function sortFonts(list) {
  return list.sort(
    (a, b) =>
      a.name.toLowerCase().localeCompare(b.name.toLowerCase()) ||
      a.path.toLowerCase().localeCompare(b.path.toLowerCase())
  );
}

function collectFontFiles(dirs, maxFiles) {
  const out = [];
  const seenPaths = new Set();
  const limit = Math.max(0, Math.floor(maxFiles));
  if (limit === 0) return out;

  for (const dir of dirs) {
    for (const file of scanDirectory(dir)) {
      const key = file.path.toLowerCase();
      if (seenPaths.has(key)) continue;
      seenPaths.add(key);
      out.push(file);
      if (out.length >= limit) return sortFonts(out);
    }
  }
  return sortFonts(out);
}

/**
 * 列出配置目录里的字体文件。
 * @param {string} root
 * @param {{maxFiles?: number}} [opts]
 * @returns {{name: string, path: string, dir: string, kind: string, size: number}[]}
 */
export function listFontFiles(root, { maxFiles = 5000 } = {}) {
  const cfg = readFontConfig(root);
  const limit = Number.isFinite(maxFiles) ? maxFiles : 5000;
  return collectFontFiles(effectiveDirs(cfg), limit);
}

// ------------------------------------------------------------------ 字体定位

function stripExt(name) {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

function pushToMap(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** 建索引：basename → 文件，去扩展名 → 文件。只在配置/目录变化时重建。 */
function buildIndex(cfg) {
  const dirs = effectiveDirs(cfg);
  const files = collectFontFiles(dirs, Number.MAX_SAFE_INTEGER);

  const byBase = new Map();
  const byStem = new Map();
  for (const file of files) {
    const base = file.name.toLowerCase();
    pushToMap(byBase, base, file);
    pushToMap(byStem, stripExt(base), file);
  }

  // 目录 realpath 用于最后的越界检查；目录不存在就跳过。
  const realDirs = [];
  for (const dir of dirs) {
    try {
      realDirs.push(fs.realpathSync(dir));
    } catch {
      /* 目录刚被删掉 */
    }
  }

  return {
    dirs,
    stamp: dirs.map((d) => `${pathKey(d)}\u0000${dirStamp(d)}`).join("\u0001"),
    checkedAt: Date.now(),
    byBase,
    byStem,
    realDirs,
  };
}

function getIndex(rootAbs) {
  const key = pathKey(rootAbs);
  const cached = indexCache.get(key);

  // 热路径：1 秒内直接命中，不做任何 IO。
  if (cached && Date.now() - cached.checkedAt < INDEX_RECHECK_MS) return cached;

  const cfg = readFontConfig(rootAbs);
  const dirs = effectiveDirs(cfg);
  const stamp = dirs
    .map((d) => `${pathKey(d)}\u0000${dirStamp(d)}`)
    .join("\u0001");

  if (cached && cached.stamp === stamp) {
    cached.checkedAt = Date.now();
    return cached;
  }

  const fresh = buildIndex(cfg);
  indexCache.set(key, fresh);
  return fresh;
}

/** candidate 的真实路径必须落在某个配置目录的真实路径之内。 */
function verifyInside(candidate, realDirs) {
  let real;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    return false;
  }
  for (const dir of realDirs) {
    const rel = path.relative(dir, real);
    if (!rel || path.isAbsolute(rel)) continue;
    // ".." 只有作为独立段才表示越界；`..foo.ttf` 是目录内的正常文件名。
    if (rel === ".." || rel.startsWith("..\\") || rel.startsWith("../")) {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * 把 DXF STYLE 表里的字体名解析成本机绝对路径。
 *
 * 匹配顺序：
 *   1. basename 完全一致（忽略大小写）—— "txt.shx"
 *   2. 去掉扩展名后一致 —— 查询 "txt" 能命中 txt.shx，反之亦然
 *   3. kind 过滤在每一阶段都生效
 *
 * 安全：输入里出现 `..`、路径分隔符、盘符/绝对路径一律拒绝；
 *       命中后还要 realpath 确认在配置目录内。
 *
 * @param {string} name
 * @param {string} root
 * @param {{kind?: string|null}} [opts]
 * @returns {string|null}
 */
export function resolveFontFile(name, root, { kind = null } = {}) {
  if (typeof name !== "string") return null;
  const raw = name.trim();
  // 空名字、超长（Windows MAX_PATH 量级）直接拒绝。
  if (!raw || raw.length > 260) return null;
  // 路径分隔符 / 盘符 / 任何 `..` 都不接受：这里只认纯文件名。
  if (raw.includes("/") || raw.includes("\\")) return null;
  if (/^[a-zA-Z]:/.test(raw)) return null;
  if (raw.includes("..")) return null;

  let kindFilter = null;
  if (kind !== null && kind !== undefined && kind !== "") {
    kindFilter = String(kind).replace(/^\./, "").toLowerCase();
    if (!Object.values(FONT_KINDS).includes(kindFilter)) return null;
  }

  const index = getIndex(path.resolve(root));
  const lower = raw.toLowerCase();

  const candidates = [];
  const seen = new Set();
  const add = (file) => {
    if (kindFilter && file.kind !== kindFilter) return;
    const key = file.path.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(file);
  };

  // 1) 完整文件名（含扩展名）优先
  for (const file of index.byBase.get(lower) || []) add(file);
  // 2) 去扩展名匹配：txt.shx ↔ txt
  for (const file of index.byStem.get(stripExt(lower)) || []) add(file);

  for (const file of candidates) {
    // 兜底：即使索引里混进了目录外的文件（符号链接/目录联接），也不放行。
    if (!verifyInside(file.path, index.realDirs)) continue;
    return path.resolve(file.path);
  }
  return null;
}

/** 清空所有缓存（测试用；配置保存时也会调用）。 */
export function clearFontIndex() {
  dirScanCache.clear();
  indexCache.clear();
  autoProbeCache = { at: 0, dirs: [] };
}

// ---------------------------------------------------------------- STYLE 表

/**
 * 解析 DXF 文本里的 STYLE 表。
 * 组码：2 名称、3 主字体、4 大字体、40 固定字高、41 宽度因子、
 *       50 倾斜角、70 标志。缺省值：font/bigFont 空串、height 0、
 *       widthFactor 1、oblique 0、flags 0。
 *
 * @param {string} text
 * @returns {Record<string, {font: string, bigFont: string, height: number, widthFactor: number, oblique: number, flags: number}>}
 */
export function parseStyleTable(text) {
  if (typeof text !== "string" || !text) return {};
  const lines = text.split(/\r\n|\r|\n/);
  const styles = {};
  let current = null;

  const fresh = () => ({
    name: "",
    font: "",
    bigFont: "",
    height: 0,
    widthFactor: 1,
    oblique: 0,
    flags: 0,
  });

  const flush = () => {
    if (current && current.name) {
      styles[current.name] = {
        font: current.font,
        bigFont: current.bigFont,
        height: current.height,
        widthFactor: current.widthFactor,
        oblique: current.oblique,
        flags: current.flags,
      };
    }
    current = null;
  };

  const number = (value) => {
    const n = Number(String(value).trim());
    return Number.isFinite(n) ? n : null;
  };

  // 组码/值严格成对；遇到非法组码就中断当前记录。
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i].trim();
    const value = lines[i + 1];
    if (!/^\d+$/.test(code)) {
      flush();
      continue;
    }
    if (code === "0") {
      flush();
      if (value.trim().toUpperCase() === "STYLE") current = fresh();
      continue;
    }
    if (!current) continue;

    switch (code) {
      case "2":
        current.name = value.trim();
        break;
      case "3":
        current.font = value.trim();
        break;
      case "4":
        current.bigFont = value.trim();
        break;
      case "40": {
        const n = number(value);
        if (n !== null) current.height = n;
        break;
      }
      case "41": {
        const n = number(value);
        if (n !== null) current.widthFactor = n;
        break;
      }
      case "50": {
        const n = number(value);
        if (n !== null) current.oblique = n;
        break;
      }
      case "70": {
        const n = number(value);
        if (n !== null) current.flags = n;
        break;
      }
      default:
        break;
    }
  }
  flush();

  /* 样式名/字体名可能写成 `\U+XXXX` 转义（实测 施工005-车库消防.dwg：
   * TEXT 的组码 7 是 `\U+5B8B\U+4F53` 即"宋体"）。dxf-web 在解码整份 DXF 之后
   * 是按真实字符查样式的，这里不同步解码就会查不到 → 那些文字退回填充字体，
   * 也就是用户看到的"字体没改好"。 */
  const decodeEsc = (value) =>
    String(value || "").replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    );
  const decoded = {};
  for (const [name, v] of Object.entries(styles)) {
    decoded[decodeEsc(name)] = {
      ...v,
      font: decodeEsc(v.font),
      bigFont: decodeEsc(v.bigFont),
    };
  }
  return decoded;
}

/** 从完整 DXF 文本里截出 TABLES 段；没有 TABLES 返回空串。 */
function extractTablesSection(text) {
  const lines = text.split(/\r\n|\r|\n/);
  // 标准布局：0 / SECTION / 2 / TABLES / ...
  for (let i = 0; i + 3 < lines.length; i++) {
    if (lines[i].trim() !== "0") continue;
    if (lines[i + 1].trim().toUpperCase() !== "SECTION") continue;
    if (lines[i + 2].trim() !== "2") continue;
    if (lines[i + 3].trim().toUpperCase() !== "TABLES") continue;

    const start = i + 4;
    for (let j = start; j + 1 < lines.length; j++) {
      if (lines[j].trim() === "0" && lines[j + 1].trim().toUpperCase() === "ENDSEC") {
        return lines.slice(start, j).join("\n");
      }
    }
    return lines.slice(start).join("\n");
  }
  return "";
}

/** 只读文件前 8MB 的 TABLES 段。解析失败/没有 TABLES 一律返回 {}，不抛。 */
export function readStyleTable(dxfPath) {
  const MAX_BYTES = 8 * 1024 * 1024;
  let fd = null;
  try {
    fd = fs.openSync(dxfPath, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, MAX_BYTES);
    if (len <= 0) return {};
    const buf = Buffer.allocUnsafe(len);
    const read = fs.readSync(fd, buf, 0, len, 0);
    const body = buf.subarray(0, read);

    // DXF 的组码/变量都是 ASCII，先用 latin1 探测码页，再按码页解码字体名。
    const head = body.subarray(0, Math.min(body.length, 128 * 1024)).toString("latin1");
    const { encoding } = detectCodepageFromText(head);
    let text;
    try {
      text = new TextDecoder(encoding || "utf-8").decode(body);
    } catch {
      text = body.toString("utf8");
    }

    const tables = extractTablesSection(text);
    if (!tables) return {};
    return parseStyleTable(tables);
  } catch {
    return {};
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}
