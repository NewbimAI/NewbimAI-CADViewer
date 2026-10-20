/**
 * 天正（TCH_*）检测 —— 两层判定。
 *
 * 背景（2026-10-19 实测）：cadcraft 转出的 DXF **不含** `TCH_*` 类名（DWG 段是压缩的，
 * 源文件字节扫描也不可靠），所以「DXF CLASSES 段确证对象」这一档在真实链路里很少命中；
 * 而 cadcraft 会**静默丢弃** TCH_* 对象（Proxy/skipped 都不可用作信号），
 * 唯一稳定可见的是天正制作留下的**样式/图块/图层名**（`_TCH_*`、`$TCH*`、`$TwtSys$*`）。
 *
 * 因此分两档：
 *   · level "objects"    —— 在「扫描用 DXF」的 CLASSES 段**确证**到 `TCH_*` 类名；
 *   · level "provenance" —— 未确证对象，但 `cadcraft info` 的名字里检出天正"制作痕迹"；
 *   · level "none"       —— 两者皆无。
 *
 * 本文件全程同步、绝不抛异常（检测只是提示，不该影响打开图纸）。
 */
import fs from "node:fs";

/* ───────────────────────── 第一档：DXF CLASSES 段扫描 ───────────────────────── */

/** 读多少行就放弃（防呆：CLASSES 段异常缺失时不会无休止扫整个大文件） */
const MAX_LINES = 200000;
/** 每次读盘的大小 */
const CHUNK = 4 * 1024 * 1024;

export function detectTchClasses(dxfPath) {
  const empty = { detected: false, classes: [] };
  if (!dxfPath || typeof dxfPath !== "string") return empty;

  let fd;
  try {
    fd = fs.openSync(dxfPath, "r");
    const buf = Buffer.allocUnsafe(CHUNK);
    let pending = ""; // 尚未遇到换行的残余（跨读盘块的行）
    let lineNo = 0;

    let expectCode = true; // 下一行是组码行？
    let code = NaN;
    let inClasses = false;
    let inClass = false;
    let wantName = false;
    const classes = [];
    const seen = new Set();
    let stop = false;

    /** @returns {boolean} true 表示可以停止读文件 */
    const handleLine = (raw) => {
      lineNo++;
      const line = raw.trim();
      if (expectCode) {
        // 组码行必须是整数；空行/脏行直接跳过，不当作组码（避免整份错位）
        if (!/^-?\d+$/.test(line)) return false;
        code = Number(line);
        expectCode = false;
        return false;
      }
      expectCode = true;
      const c = code;

      if (c === 2) {
        // 段名在 `0/SECTION` 之后的 `2/<段名>`：进入 CLASSES 段
        if (line === "CLASSES") {
          inClasses = true;
          inClass = false;
          wantName = false;
        }
        return false;
      }

      if (c === 0) {
        const v = line;
        if (v === "ENDSEC") {
          if (inClasses) return true; // CLASSES 段结束 → 立即停止读文件
        } else if (v === "CLASS") {
          if (inClasses) {
            inClass = true;
            wantName = true;
          }
        }
        return false;
      }

      /* 类名是 CLASS 记录里第一个 `1` 组码的值 */
      if (c === 1 && inClasses && inClass && wantName) {
        wantName = false;
        if (line.startsWith("TCH_") && !seen.has(line)) {
          seen.add(line);
          classes.push(line);
        }
      }
      return false;
    };

    while (!stop) {
      const bytes = fs.readSync(fd, buf, 0, buf.length, null);
      if (bytes === 0) break;
      // DXF 类名是 ASCII，按 latin1 逐字节解码不会踩多字节边界问题
      pending += buf.toString("latin1", 0, bytes);
      let nl;
      while ((nl = pending.indexOf("\n")) >= 0) {
        const raw = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        if (handleLine(raw) || lineNo >= MAX_LINES) {
          stop = true;
          break;
        }
      }
    }

    return { detected: classes.length > 0, classes };
  } catch {
    return empty;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/* ───────────────────────── 第二档：制作痕迹（名字）判定 ───────────────────────── */

/**
 * 天正痕迹规则（收紧，勿放宽）：
 *   （1）含 `_TCH_`；或（2）含 `$TCH` / `$TwtSys$`（不区分大小写）。
 * ⚠️ 不能裸匹配 `TCH` —— 图层名里的 `HATCH`（如 PUB_HATCH / COLU_HATCH）会被误伤。
 */
const TCH_NAME_RE = /(_TCH_|\$TCH|\$TwtSys\$)/i;

/** info 里参与判定的名字数组 */
const NAME_KEYS = ["textStyles", "dimStyles", "linetypes", "layers", "blocks"];

/** 取某个数组里的名字；元素可能是字符串，也可能是带 `.name` 的对象 */
function namesOf(info, key) {
  const arr = info?.[key];
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const e of arr) {
    if (typeof e === "string") out.push(e);
    else if (e && typeof e === "object" && typeof e.name === "string") out.push(e.name);
  }
  return out;
}

/**
 * 扫 `cadcraft info` 的 5 个名字数组，返回命中的天正痕迹名（去重、首次出现顺序，最多 12 个）。
 * `info` 缺失/非法 → `[]`。
 * @param {any} info cadcraft-cli info 的解析结果
 * @returns {string[]}
 */
export function detectTchProvenance(info) {
  if (!info || typeof info !== "object") return [];
  const seen = new Set();
  const out = [];
  for (const key of NAME_KEYS) {
    for (const name of namesOf(info, key)) {
      if (!name || !TCH_NAME_RE.test(name) || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
      if (out.length >= 12) return out;
    }
  }
  return out;
}

/* ───────────────────────── 分层入口 ───────────────────────── */

/**
 * 分层检测天正（契约，形状不可变）：
 *   { level: "objects"|"provenance"|"none", classes: string[], evidence: string[] }
 * 先确证对象（CLASSES 段有 TCH_* 类名）→ objects；
 * 否则看制作痕迹（名字）→ provenance；都没有 → none。
 * 出错一律退化成 none，绝不影响开图。
 * @param {{ dxfPath?: string, info?: any }} args
 */
export function detectTch({ dxfPath, info } = {}) {
  try {
    const cls = detectTchClasses(dxfPath);
    if (cls && Array.isArray(cls.classes) && cls.classes.length > 0) {
      return { level: "objects", classes: cls.classes, evidence: [] };
    }
  } catch {
    /* 退到下一档 */
  }
  try {
    const evidence = detectTchProvenance(info);
    if (evidence.length > 0) {
      return { level: "provenance", classes: [], evidence };
    }
  } catch {
    /* 退化成 none */
  }
  return { level: "none", classes: [], evidence: [] };
}

