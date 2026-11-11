/**
 * DXF 码页探测。
 *
 * 为什么需要它：dxf-viewer 在 `Load()` 里用 `TextDecoder(fileEncoding)` 解码 DXF 文本，
 * 但它**不会**自己去读 `$DWGCODEPAGE`——必须在调用前把编码传进去（api.md 明确说明
 * 解析前就得知道编码）。不传就是 UTF-8 解码，GBK 图纸会整体乱码，看起来像"字体丢字"。
 *
 * 规则：
 *  - DXF R2007（$ACADVER = AC1021）及以后，字符串已经是 UTF-8，与 $DWGCODEPAGE 无关。
 *  - 更老的图按 $DWGCODEPAGE（ANSI_936 = GBK、ANSI_950 = Big5、ANSI_932 = Shift-JIS …）。
 *  - 探测失败返回 encoding: null，调用方保持现状（UTF-8），不会更糟。
 *
 * 只读文件头部若干 KB，不做全文件扫描。
 */
import fs from "node:fs";

/** `$DWGCODEPAGE` 取值 → `TextDecoder` 标签。 */
export const ENCODING_BY_CODEPAGE = Object.freeze({
  "ANSI_936": "gbk",
  "ANSI_950": "big5",
  "ANSI_932": "shift_jis",
  "ANSI_949": "euc-kr",
  "ANSI_874": "windows-874",
  "ANSI_1250": "windows-1250",
  "ANSI_1251": "windows-1251",
  "ANSI_1252": "windows-1252",
  "ANSI_1253": "windows-1253",
  "ANSI_1254": "windows-1254",
  "ANSI_1255": "windows-1255",
  "ANSI_1256": "windows-1256",
  "ANSI_1257": "windows-1257",
  "ANSI_1258": "windows-1258",
  "UTF-8": "utf-8",
});

/** `$ACADVER` 是否是 UTF-8 起点的版本（AC1021 = R2007）。 */
export function isUtf8Version(acadVer) {
  const m = /^AC(\d{4})$/.exec(String(acadVer || "").trim());
  return m ? Number(m[1]) >= 1021 : false;
}

/** 从头部文本里取一个 DXF 头变量：`  9\n$NAME\n<group>\n<value>` */
function readHeaderVar(head, name) {
  const re = new RegExp(
    "\\$" + name + "[ \\t]*\\r?\\n[ \\t]*\\d+[ \\t]*\\r?\\n([^\\r\\n]*)",
    "i"
  );
  const m = re.exec(head);
  return m ? m[1].trim() : null;
}

/**
 * 从 DXF 头部文本探测。
 * @param {string} head 文件前若干 KB（按 latin1 读取即可，头变量都是 ASCII）
 * @returns {{acadVer: string|null, codepage: string|null, encoding: string|null, utf8: boolean}}
 */
export function detectCodepageFromText(head) {
  const acadVer = readHeaderVar(head || "", "ACADVER");
  const codepage = readHeaderVar(head || "", "DWGCODEPAGE");
  const utf8 = isUtf8Version(acadVer);
  let encoding = null;
  if (utf8) encoding = "utf-8";
  else if (codepage) encoding = ENCODING_BY_CODEPAGE[codepage.toUpperCase()] ?? null;
  return { acadVer, codepage, encoding, utf8 };
}

/**
 * 读文件头并探测。文件不存在/读失败时返回全 null，不抛。
 * @param {string} filePath
 * @param {number} [maxBytes]
 */
export function readCodepage(filePath, maxBytes = 128 * 1024) {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, maxBytes);
      const buf = Buffer.allocUnsafe(len);
      fs.readSync(fd, buf, 0, len, 0);
      return detectCodepageFromText(buf.toString("latin1"));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { acadVer: null, codepage: null, encoding: null, utf8: false };
  }
}
