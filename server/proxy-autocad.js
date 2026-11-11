/**
 * AutoCAD 标准「代理图形」（proxy graphics metafile）解码器。
 *
 * ## 和 `proxy-graphics.js` 的关系
 * `proxy-graphics.js` 是最早为 `IAEC_*` / `IWT_*` 自定义实体写的解码器，只覆盖
 * 实测到的那一小撮记录类型。后来对比 ezdxf 的 `ProxyGraphic` 与 ODA 规范才确认：
 * 那些 `310` 数据**本来就是 AutoCAD 标准代理图形格式**，只是 IAEC 只用了其中
 * 一个子集。本文件是完整的标准解码器；旧解码器保持不动，由上层按实体类型 /
 * 记录类型守卫选择（见 `classifyProxyGraphics`），避免一次改坏已验证的行为。
 *
 * ## 容器格式（小端）
 *   u32 totalSize              // 必须等于 310 拼接后的字节数
 *   u32 objectCount            // 声明记录数（部分写入器不准确，仅作参考）
 *   record[]                   // 从 offset 8 开始，直到 totalSize
 *
 *   record:
 *     u32 size                 // 本记录总字节数（含 8 字节头；通常 4 字节对齐）
 *     u32 opcode               // AcGi 操作码，见下表
 *     ...payload...
 *
 * ## 已实现的操作码（数值经 acad-cab.dxf / acad-s005.dxf 实测并与 ezdxf 1.4.5 对照）
 *   0  kAcGiOpBad                 空操作，跳过
 *   1  SetExtents                 48 字节包围盒，跳过
 *   2  Circle1                    center(3d) r normal(3d)
 *   3  Circle2                    3 个圆上点
 *   4  CircularArc1               center(3d) r normal(3d) startVec(3d) sweep arcType
 *   5  CircularArc2               3 个弧上点 + arcType
 *   6  Polyline                   u32 n + n 个 3d 点
 *   7  Polygon                    u32 n + n 个 3d 点（受 fill 状态影响）
 *   8  Mesh                       rows cols + rows*cols 个 3d 点（其余 traits 忽略）
 *   9  Shell                      u32 nVerts + 顶点 + u32 faceListSize + 面表（其余 traits 忽略）
 *  10  Text1                      pos normal dir height width oblique + ANSI 字符串
 *  11  Text2                      pos normal dir + ANSI 字符串 + ... + 字体名
 *  12  XLine                      两个 3d 点
 *  13  Ray                        两个 3d 点
 *  14  Color                      u32 ACI
 *  15  LayerName                  ANSI 字符串
 *  16  LayerIndex                 u32 图层表索引
 *  17  LineTypeName               ANSI 字符串
 *  18  LineTypeIndex              u32 线型表索引
 *  19  SelectionMarker            u32
 *  20  FillType                   u32（1 = 填充）
 *  21  BoundingBoxSave            空
 *  22  TrueColor                  u32（AcCmEntityColor 原始值）
 *  23  LineWeight                 u32（0xFFFFFFFF = ByLayer）
 *  24  LineTypeScale              f64
 *  25  Thickness                  f64
 *  26  PlotStyleName              8 字节（type + id）
 *  27  PushClipBoundary           未实现（计入 unsupportedKinds）
 *  28  PopClipBoundary            空
 *  29  PushTransformM             16 × f64，行主序，平移在 m[3]/m[7]/m[11]
 *  30  PushTransformV             同 29（视口变换，按 29 处理并计数）
 *  31  PopTransform               空
 *  32  PlineNormal                u32 n + 点 + normal(3d)
 *  33  LwPolyline                 位压缩，见下方 `decodeLwPolyline`
 *  34  Material                   未实现
 *  35  Mapper                     未实现
 *  36  UnicodeText                pos normal dir height width oblique + UTF-16 字符串
 *  37  Unknown37                  未定义，跳过
 *  38  UnicodeText2               pos normal dir + UTF-16 字符串 + ... + 字体名
 *  44  EllipticArc                center(3d) normal(3d) majorLen minorLen start end axisAngle
 *
 * 未列出的 opcode 一律按 size 跳过并计入 `unsupportedKinds`，不会让整条实体解码失败。
 *
 * ## 坐标/变换
 * 29 的 16 个 double 是行主序 4×4 矩阵，坐标按列向量左乘：
 *   x' = m[0]*x + m[1]*y + m[2]*z + m[3]
 *   y' = m[4]*x + m[5]*y + m[6]*z + m[7]
 * 本解码器只输出二维基本图元，z 忽略；文字高度按矩阵的 Y 轴长度缩放，宽度因子
 * 按 X/Y 轴长度比缩放，旋转角由文字方向向量经矩阵变换后得到。
 *
 * ## 安全边界
 * 310 来自不可信图纸。默认单条 ≤ 8 MiB、≤ 100 万条记录、≤ 200 万个输出点；
 * 结构不合法（size<8、越界、totalSize 不匹配）直接返回 null，由调用方保留原实体。
 */

import iconv from "iconv-lite";

/** AcGi 操作码。仅用于可读性，数值来自 ODA 规范 / ezdxf / 实测。 */
export const AUTOCAD_OPCODE = Object.freeze({
  BAD: 0,
  EXTENTS: 1,
  CIRCLE: 2,
  CIRCLE_3P: 3,
  CIRCULAR_ARC: 4,
  CIRCULAR_ARC_3P: 5,
  POLYLINE: 6,
  POLYGON: 7,
  MESH: 8,
  SHELL: 9,
  TEXT: 10,
  TEXT2: 11,
  XLINE: 12,
  RAY: 13,
  COLOR: 14,
  LAYER_NAME: 15,
  LAYER_INDEX: 16,
  LINETYPE_NAME: 17,
  LINETYPE_INDEX: 18,
  SELECTION_MARKER: 19,
  FILL_TYPE: 20,
  BOUNDING_BOX: 21,
  TRUE_COLOR: 22,
  LINE_WEIGHT: 23,
  LT_SCALE: 24,
  THICKNESS: 25,
  PLOT_STYLE: 26,
  PUSH_CLIP: 27,
  POP_CLIP: 28,
  PUSH_MATRIX: 29,
  PUSH_MATRIX_V: 30,
  POP_MATRIX: 31,
  POLYLINE_NORMAL: 32,
  LWPOLYLINE: 33,
  MATERIAL: 34,
  MAPPER: 35,
  UNICODE_TEXT: 36,
  UNKNOWN_37: 37,
  UNICODE_TEXT2: 38,
  ELLIPTIC_ARC: 44,
});

/** 有几何输出的 opcode。 */
const GEOMETRY_OPCODES = new Set([
  2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 32, 33, 36, 38, 44,
]);

/** `proxy-graphics.js` 已经覆盖的记录类型。用于 `classifyProxyGraphics` 的兼容判断。
 *  注意 33：旧解码器把它当作未解的 BLOB（窗框近似），新解码器按标准 LWPOLYLINE
 *  解出真实几何，所以 33 不在 legacy 集合里，出现 33 时优先走新解码器。 */
const LEGACY_OPCODES = new Set([
  2, 4, 6, 9, 14, 16, 18, 19, 20, 22, 23, 24, 25, 26, 29, 31, 32, 38,
]);

const DEFAULTS = Object.freeze({
  maxBytes: 8 * 1024 * 1024,
  maxRecords: 1_000_000,
  maxPoints: 2_000_000,
  maxStringChars: 65_536,
  maxMatrixDepth: 64,
  codepage: "gbk",
});

const TWO_PI = Math.PI * 2;

const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (typeof input === "string") {
    if (input.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(input)) return null;
    try {
      return Buffer.from(input, "hex");
    } catch {
      return null;
    }
  }
  return null;
}

function align4(n) {
  return (n + 3) & ~3;
}

function readPaddedAnsi(buf, offset, end, decodeAnsi, base = offset) {
  const limit = Math.min(end, buf.length);
  let zero = -1;
  for (let i = offset; i < limit; i++) {
    if (buf[i] === 0) {
      zero = i;
      break;
    }
  }
  const stop = zero >= 0 ? zero : limit;
  const bytes = buf.subarray(offset, stop);
  const after = zero >= 0 ? zero + 1 : limit;
  return { text: decodeAnsi(bytes), next: base + align4(after - base) };
}

function readPaddedUnicode(buf, offset, end, maxChars, base = offset) {
  const limit = Math.min(end, buf.length);
  let at = offset;
  let text = "";
  let units = 0;
  while (at + 1 < limit && units < maxChars) {
    const code = buf.readUInt16LE(at);
    if (code === 0) break;
    text += String.fromCharCode(code);
    at += 2;
    units++;
  }
  if (at + 1 < limit && buf.readUInt16LE(at) === 0) at += 2;
  return { text, next: base + align4(at - base), terminated: at <= limit };
}

/* ───────────────────────── 位流（LWPOLYLINE 用） ───────────────────────── */

class BitReader {
  constructor(buf, start = 0) {
    this.buf = buf;
    this.bit = start * 8;
  }

  get remaining() {
    return this.buf.length * 8 - this.bit;
  }

  readBit() {
    if (this.bit >= this.buf.length * 8) throw new RangeError("proxy bit stream exhausted");
    const index = this.bit++;
    return (this.buf[index >> 3] & (0x80 >> (index & 7))) ? 1 : 0;
  }

  readBits(count) {
    let value = 0;
    for (let i = 0; i < count; i++) value = (value << 1) | this.readBit();
    return value;
  }

  readUnsignedByte() {
    return this.readBits(8);
  }

  readAlignedBytes(count) {
    if ((this.bit & 7) === 0) {
      const start = this.bit >> 3;
      if (start + count > this.buf.length) throw new RangeError("proxy bit stream exhausted");
      this.bit += count * 8;
      return this.buf.subarray(start, start + count);
    }
    const out = Buffer.allocUnsafe(count);
    for (let i = 0; i < count; i++) out[i] = this.readUnsignedByte();
    return out;
  }

  readUnsignedLong() {
    if ((this.bit & 7) === 0) {
      const b = this.readAlignedBytes(4);
      return b.readUInt32LE(0);
    }
    const b1 = this.readBits(8);
    const b2 = this.readBits(8);
    const b3 = this.readBits(8);
    const b4 = this.readBits(8);
    return (b4 << 24) + (b3 << 16) + (b2 << 8) + b1;
  }

  readSignedLong() {
    const v = this.readUnsignedLong();
    return v & 0x80000000 ? -((~v & 0xffffffff) + 1) : v;
  }

  readFloat() {
    const b = this.readAlignedBytes(8);
    return b.readDoubleLE(0);
  }

  readBitShort() {
    const bits = this.readBits(2);
    if (bits === 0) {
      const b = this.readAlignedBytes(2);
      return b.readInt16LE(0);
    }
    if (bits === 1) return this.readUnsignedByte();
    if (bits === 2) return 0;
    return 256;
  }

  readBitLong() {
    const bits = this.readBits(2);
    if (bits === 0) return this.readSignedLong();
    if (bits === 1) return this.readUnsignedByte();
    if (bits === 2) return 0;
    return 256;
  }

  readBitDouble() {
    const bits = this.readBits(2);
    if (bits === 0) return this.readFloat();
    if (bits === 1) return 1;
    return 0;
  }

  readBitDoubleDefault(def) {
    const bits = this.readBits(2);
    if (bits === 0) return def;
    if (bits === 1) {
      const tail = Buffer.alloc(8);
      tail.writeDoubleLE(def, 0);
      this.readAlignedBytes(4).copy(tail, 0);
      return tail.readDoubleLE(0);
    }
    if (bits === 2) {
      const tail = Buffer.alloc(8);
      tail.writeDoubleLE(def, 0);
      tail[4] = this.readUnsignedByte();
      tail[5] = this.readUnsignedByte();
      tail[0] = this.readUnsignedByte();
      tail[1] = this.readUnsignedByte();
      tail[2] = this.readUnsignedByte();
      tail[3] = this.readUnsignedByte();
      return tail.readDoubleLE(0);
    }
    return this.readFloat();
  }
}

/* ───────────────────────── 几何辅助 ───────────────────────── */

function transformPoint(m, x, y) {
  if (!m) return [x, y];
  return [m[0] * x + m[1] * y + m[3], m[4] * x + m[5] * y + m[7]];
}

function matrixScale(m) {
  if (!m) return { sx: 1, sy: 1, rotation: 0 };
  const sx = Math.hypot(m[0], m[4]);
  const sy = Math.hypot(m[1], m[5]);
  return { sx: sx || 1, sy: sy || 1, rotation: Math.atan2(m[4], m[0]) };
}

function transformDirection(m, x, y) {
  if (!m) return [x, y];
  return [m[0] * x + m[1] * y, m[4] * x + m[5] * y];
}

function circleFrom3Points(p1, p2, p3) {
  const ax = p1[0], ay = p1[1];
  const bx = p2[0], by = p2[1];
  const cx = p3[0], cy = p3[1];
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = ax * ax + ay * ay;
  const b2 = bx * bx + by * by;
  const c2 = cx * cx + cy * cy;
  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
  const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  return { cx: ux, cy: uy, r: Math.hypot(ax - ux, ay - uy) };
}

function arcPoints(cx, cy, r, start, sweep, maxPoints) {
  if (!(r > 0) || !Number.isFinite(sweep) || sweep === 0) return null;
  const steps = Math.max(2, Math.min(maxPoints, Math.ceil(Math.abs(sweep) / (Math.PI / 18))));
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const a = start + (sweep * i) / steps;
    points.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return points;
}

/** bulge = tan(θ/4)，把一段圆弧展开成折线点（不含起点）。 */
function bulgePoints(p1, p2, bulge) {
  if (!bulge || Math.abs(bulge) < 1e-12) return [p2];
  const theta = 4 * Math.atan(bulge);
  const dx = p2[0] - p1[0];
  const dy = p2[1] - p1[1];
  const c = (1 - bulge * bulge) / (4 * bulge);
  const cx = (p1[0] + p2[0]) / 2 - dy * c;
  const cy = (p1[1] + p2[1]) / 2 + dx * c;
  const r = Math.hypot(p1[0] - cx, p1[1] - cy);
  const a0 = Math.atan2(p1[1] - cy, p1[0] - cx);
  const a1 = Math.atan2(p2[1] - cy, p2[0] - cx);
  let sweep = a1 - a0;
  if (bulge > 0 && sweep <= 0) sweep += TWO_PI;
  if (bulge < 0 && sweep >= 0) sweep -= TWO_PI;
  const steps = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 18)));
  const out = [];
  for (let i = 1; i <= steps; i++) {
    const a = a0 + (sweep * i) / steps;
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return out;
}

/* ───────────────────────── 主解码器 ───────────────────────── */

/**
 * 结构探测：不产出图元，只判断这段 310 是否是合法的代理图形容器。
 * @param {string|Buffer|Uint8Array} input 十六进制串或字节
 * @param {{maxBytes?:number,maxRecords?:number}} [options]
 * @returns {{ok:boolean, reason?:string, bytes?:number, totalSize?:number,
 *            declaredCount?:number, records?:number, opcodes?:number[],
 *            hasGeometry?:boolean, traitOnly?:boolean}}
 */
export function probeAutoCadProxy(input, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULTS.maxBytes;
  const maxRecords = options.maxRecords ?? DEFAULTS.maxRecords;
  const buf = toBuffer(input);
  if (!buf) return { ok: false, reason: "not-binary" };
  if (buf.length < 8) return { ok: false, reason: "too-small", bytes: buf.length };
  if (buf.length > maxBytes) return { ok: false, reason: "too-large", bytes: buf.length };
  const total = buf.readUInt32LE(0);
  const declaredCount = buf.readUInt32LE(4);
  if (total !== buf.length) {
    return { ok: false, reason: "length-mismatch", bytes: buf.length, totalSize: total };
  }
  if (declaredCount > maxRecords) {
    return { ok: false, reason: "record-count", declaredCount };
  }
  const opcodes = [];
  let pos = 8;
  let hasGeometry = false;
  while (pos + 8 <= total) {
    const size = buf.readUInt32LE(pos);
    const opcode = buf.readUInt32LE(pos + 4);
    if (size < 8 || pos + size > total) {
      return { ok: false, reason: "broken-record", offset: pos, size, opcode };
    }
    opcodes.push(opcode);
    if (GEOMETRY_OPCODES.has(opcode)) hasGeometry = true;
    pos += size;
    if (opcodes.length > maxRecords) return { ok: false, reason: "record-count" };
  }
  if (pos !== total) return { ok: false, reason: "trailing-bytes", offset: pos };
  return {
    ok: true,
    bytes: buf.length,
    totalSize: total,
    declaredCount,
    records: opcodes.length,
    opcodes,
    hasGeometry,
    traitOnly: !hasGeometry,
  };
}

/**
 * 上层选择器：`proxy-graphics.js` 还是本文件？
 *
 * 说明：两者的容器**完全相同**，IAEC 的 `310` 就是标准代理图形的子集，所以
 * 不存在“格式特征”能 100% 区分。这里的规则是保守的：
 *   1. 没有几何记录（只有 14/16/18/20/22/23... 属性）→ trait-only，谁都别解；
 *   2. 实体名是 `ACAD_PROXY_ENTITY` → 标准解码器；
 *   3. 出现旧解码器没覆盖的 opcode（3/5/7/8/10/11/12/13/15/17/21/27/28/30/34/35/36/37/44）
 *      → 标准解码器；
 *   4. 其余（纯 IAEC 子集）→ legacy，继续走 `proxy-graphics.js`，行为不变。
 *
 * @returns {"autocad"|"legacy"|"trait-only"|"none"}
 */
export function classifyProxyGraphics(input, options = {}) {
  const probe = probeAutoCadProxy(input, options);
  if (!probe.ok) return "none";
  if (!probe.hasGeometry) return "trait-only";
  if (String(options.entityType ?? "").toUpperCase() === "ACAD_PROXY_ENTITY") return "autocad";
  if (probe.opcodes.some((op) => !LEGACY_OPCODES.has(op))) return "autocad";
  return "legacy";
}

/**
 * 解码一条实体的 AutoCAD 标准代理图形。
 *
 * @param {string|Buffer|Uint8Array} input 310 拼接后的十六进制串或字节
 * @param {{
 *   maxBytes?:number, maxRecords?:number, maxPoints?:number,
 *   maxStringChars?:number, maxMatrixDepth?:number, codepage?:string,
 *   decodeAnsi?:(bytes:Buffer)=>string
 * }} [options]
 * @returns {{primitives:Array, unsupportedKinds:object, stats:object,
 *            matrix:number[]|null}|null}
 *          结构损坏/超限返回 null；只有属性没有几何时返回空 primitives（stats.traitOnly=true）
 */
export function decodeAutoCadProxy(input, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULTS.maxBytes;
  const maxRecords = options.maxRecords ?? DEFAULTS.maxRecords;
  const maxPoints = options.maxPoints ?? DEFAULTS.maxPoints;
  const maxStringChars = options.maxStringChars ?? DEFAULTS.maxStringChars;
  const maxMatrixDepth = options.maxMatrixDepth ?? DEFAULTS.maxMatrixDepth;
  const buf = toBuffer(input);
  if (!buf || buf.length < 8 || buf.length > maxBytes) return null;
  const total = buf.readUInt32LE(0);
  const declaredCount = buf.readUInt32LE(4);
  if (total !== buf.length || declaredCount > maxRecords) return null;

  const decodeAnsi =
    typeof options.decodeAnsi === "function"
      ? options.decodeAnsi
      : (bytes) => {
          const encoding = options.codepage ?? DEFAULTS.codepage;
          try {
            return iconv.decode(bytes, encoding);
          } catch {
            return bytes.toString("latin1");
          }
        };

  const primitives = [];
  const unsupportedKinds = Object.create(null);
  const stats = {
    bytes: buf.length,
    totalSize: total,
    declaredCount,
    records: 0,
    geometryRecords: 0,
    primitives: 0,
    polylines: 0,
    triangles: 0,
    texts: 0,
    circles: 0,
    arcs: 0,
    ellipses: 0,
    meshes: 0,
    shells: 0,
    lwpolylines: 0,
    xlines: 0,
    rays: 0,
    matrices: 0,
    viewportMatrices: 0,
    maxMatrixDepth: 0,
    fillRecords: 0,
    layers: 0,
    colors: 0,
    trueColors: 0,
    skipped: 0,
    degenerateFaces: 0,
    hasGeometry: false,
    traitOnly: false,
    truncated: false,
  };

  const state = {
    matrix: null,
    stack: [],
    fill: false,
    lastMatrix: null,
    points: 0,
  };

  const markUnsupported = (opcode) => {
    unsupportedKinds[opcode] = (unsupportedKinds[opcode] || 0) + 1;
  };

  const pushPoints = (points) => {
    state.points += points.length;
    if (state.points > maxPoints) {
      stats.truncated = true;
      throw new RangeError("proxy point limit exceeded");
    }
  };

  const emitPolyline = (points, closed = false, extra = null) => {
    if (!Array.isArray(points) || points.length < 2) return;
    pushPoints(points);
    const prim = { type: "polyline", points, closed: !!closed };
    if (extra) Object.assign(prim, extra);
    primitives.push(prim);
    stats.polylines++;
  };

  const emitTriangle = (a, b, c) => {
    if (!a || !b || !c) return;
    const area = Math.abs(
      (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])
    );
    if (area <= 1e-9) {
      stats.degenerateFaces++;
      return;
    }
    pushPoints([a, b, c]);
    primitives.push({ type: "triangle", points: [a, b, c] });
    stats.triangles++;
  };

  const emitTriangulated = (points) => {
    for (let i = 1; i + 1 < points.length; i++) emitTriangle(points[0], points[i], points[i + 1]);
  };

  const readPoints = (pos, count, stride = 24) => {
    const points = [];
    for (let i = 0; i < count; i++) {
      const at = pos + i * stride;
      const x = buf.readDoubleLE(at);
      const y = buf.readDoubleLE(at + 8);
      if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
      points.push(transformPoint(state.matrix, x, y));
    }
    return points;
  };

  const readTextCommon = (pos) => {
    const x = buf.readDoubleLE(pos);
    const y = buf.readDoubleLE(pos + 8);
    const nx = buf.readDoubleLE(pos + 24);
    const ny = buf.readDoubleLE(pos + 32);
    const dx = buf.readDoubleLE(pos + 48);
    const dy = buf.readDoubleLE(pos + 56);
    return { x, y, nx, ny, dx, dy };
  };

  const emitText = (pos, end, mode) => {
    const base = readTextCommon(pos);
    if (![base.x, base.y, base.dx, base.dy].every(isFiniteNumber)) return;
    let at;
    let text = "";
    let height;
    let widthFactor = 1;
    let oblique = 0;
    let font = "";
    let bigFont = "";

    try {
      if (mode === "unicode" || mode === "unicode2") {
        const first = readPaddedUnicode(buf, pos + 72, end, maxStringChars, pos);
        text = first.text;
        at = first.next;
        if (mode === "unicode") {
          if (at + 24 > end) return;
          height = buf.readDoubleLE(at);
          widthFactor = buf.readDoubleLE(at + 8);
          oblique = buf.readDoubleLE(at + 16);
        } else {
          at += 8; // 两个 int32：字符串长度 / raw
          if (at + 4 * 8 + 5 * 4 + 4 * 4 > end) return;
          height = buf.readDoubleLE(at);
          widthFactor = buf.readDoubleLE(at + 8);
          oblique = buf.readDoubleLE(at + 16);
          at += 32 + 20 + 16; // 4 doubles + 5 个 flag + bold/italic/charset/pitch
          try {
            const typeface = readPaddedUnicode(buf, at, end, maxStringChars, pos);
            at = typeface.next;
            const fontR = readPaddedUnicode(buf, at, end, maxStringChars, pos);
            at = fontR.next;
            const bigR = readPaddedUnicode(buf, at, end, maxStringChars, pos);
            font = fontR.text;
            bigFont = bigR.text;
          } catch {
            /* 字体名损坏不影响正文 */
          }
        }
      } else {
        const first = readPaddedAnsi(buf, pos + (mode === "text" ? 96 : 72), end, decodeAnsi, pos);
        text = first.text;
        at = first.next;
        if (mode === "text") {
          if (pos + 96 > end) return;
          height = buf.readDoubleLE(pos + 72);
          widthFactor = buf.readDoubleLE(pos + 80);
          oblique = buf.readDoubleLE(pos + 88);
        } else {
          at += 8; // length + raw
          if (at + 4 * 8 + 5 * 4 > end) return;
          height = buf.readDoubleLE(at);
          widthFactor = buf.readDoubleLE(at + 8);
          oblique = buf.readDoubleLE(at + 16);
          at += 32 + 20;
          try {
            const fontR = readPaddedAnsi(buf, at, end, decodeAnsi, pos);
            at = fontR.next;
            const bigR = readPaddedAnsi(buf, at, end, decodeAnsi, pos);
            font = fontR.text;
            bigFont = bigR.text;
          } catch {
            /* 字体名损坏不影响正文 */
          }
        }
      }
    } catch {
      markUnsupported(mode === "text" ? 10 : mode === "text2" ? 11 : mode === "unicode" ? 36 : 38);
      return;
    }

    if (!isFiniteNumber(height) || !(height > 0) || height > 1e7) {
      markUnsupported(mode === "text" ? 10 : mode === "text2" ? 11 : mode === "unicode" ? 36 : 38);
      return;
    }
    if (!isFiniteNumber(widthFactor) || widthFactor <= 0) widthFactor = 1;
    if (!isFiniteNumber(oblique)) oblique = 0;

    const scale = matrixScale(state.matrix);
    const dir = transformDirection(state.matrix, base.dx, base.dy);
    const rotation = Math.abs(dir[0]) + Math.abs(dir[1]) > 1e-12 ? Math.atan2(dir[1], dir[0]) : scale.rotation;
    const [px, py] = transformPoint(state.matrix, base.x, base.y);
    const h = height * (scale.sy || 1);
    const wf = widthFactor * ((scale.sx || 1) / (scale.sy || 1));
    primitives.push({
      type: "text",
      text,
      x: px,
      y: py,
      height: h,
      widthFactor: wf,
      rotation,
      oblique,
      font,
      bigFont,
    });
    stats.texts++;
  };

  const start = 8;
  let pos = start;
  while (pos + 8 <= total) {
    const size = buf.readUInt32LE(pos);
    const opcode = buf.readUInt32LE(pos + 4);
    if (size < 8 || pos + size > total) return null;
    const end = pos + size;
    const p = pos + 8;
    stats.records++;
    if (GEOMETRY_OPCODES.has(opcode)) stats.geometryRecords++;

    try {
      switch (opcode) {
        case AUTOCAD_OPCODE.BAD:
        case AUTOCAD_OPCODE.EXTENTS:
        case AUTOCAD_OPCODE.BOUNDING_BOX:
        case AUTOCAD_OPCODE.POP_CLIP:
        case AUTOCAD_OPCODE.UNKNOWN_37:
          stats.skipped++;
          break;

        case AUTOCAD_OPCODE.COLOR:
          stats.colors++;
          break;

        case AUTOCAD_OPCODE.LAYER_INDEX:
          stats.layers++;
          break;

        case AUTOCAD_OPCODE.FILL_TYPE:
          state.fill = buf.readUInt32LE(p) === 1;
          if (state.fill) stats.fillRecords++;
          else stats.fillRecords += 0;
          break;

        case AUTOCAD_OPCODE.TRUE_COLOR:
          stats.trueColors++;
          break;

        case AUTOCAD_OPCODE.LAYER_NAME:
        case AUTOCAD_OPCODE.LINETYPE_NAME:
        case AUTOCAD_OPCODE.LINETYPE_INDEX:
        case AUTOCAD_OPCODE.SELECTION_MARKER:
        case AUTOCAD_OPCODE.LINE_WEIGHT:
        case AUTOCAD_OPCODE.LT_SCALE:
        case AUTOCAD_OPCODE.THICKNESS:
        case AUTOCAD_OPCODE.PLOT_STYLE:
          stats.skipped++;
          break;

        case AUTOCAD_OPCODE.PUSH_MATRIX:
        case AUTOCAD_OPCODE.PUSH_MATRIX_V: {
          if (size < 8 + 128 || state.stack.length >= maxMatrixDepth) {
            markUnsupported(opcode);
            break;
          }
          const m = new Array(16);
          for (let k = 0; k < 16; k++) m[k] = buf.readDoubleLE(p + k * 8);
          if (!m.every(isFiniteNumber)) {
            markUnsupported(opcode);
            break;
          }
          state.stack.push(state.matrix);
          state.matrix = m;
          state.lastMatrix = m;
          stats.matrices++;
          if (opcode === AUTOCAD_OPCODE.PUSH_MATRIX_V) stats.viewportMatrices++;
          stats.maxMatrixDepth = Math.max(stats.maxMatrixDepth, state.stack.length);
          break;
        }

        case AUTOCAD_OPCODE.POP_MATRIX:
          if (state.stack.length) state.matrix = state.stack.pop();
          break;

        case AUTOCAD_OPCODE.POLYLINE:
        case AUTOCAD_OPCODE.POLYGON:
        case AUTOCAD_OPCODE.POLYLINE_NORMAL: {
          const count = buf.readUInt32LE(p);
          if (count < 1 || count > 1_000_000) return null;
          const stride = 24;
          const need = p + 4 + count * stride;
          if (need > end) return null;
          const points = readPoints(p + 4, count, stride);
          if (!points) return null;
          if (opcode === AUTOCAD_OPCODE.POLYGON && state.fill) {
            emitTriangulated(points);
          } else {
            emitPolyline(points, opcode === AUTOCAD_OPCODE.POLYGON);
          }
          state.fill = false;
          break;
        }

        case AUTOCAD_OPCODE.CIRCLE: {
          if (size < 64) return null;
          const cx = buf.readDoubleLE(p);
          const cy = buf.readDoubleLE(p + 8);
          const r = buf.readDoubleLE(p + 24);
          if (!isFiniteNumber(cx) || !isFiniteNumber(cy) || !(r > 0) || r > 1e12) break;
          const points = [];
          for (let i = 0; i < 32; i++) {
            const a = (i / 32) * TWO_PI;
            points.push(transformPoint(state.matrix, cx + Math.cos(a) * r, cy + Math.sin(a) * r));
          }
          emitPolyline(points, true);
          stats.circles++;
          state.fill = false;
          break;
        }

        case AUTOCAD_OPCODE.CIRCLE_3P: {
          if (size < 8 + 72) return null;
          const pts = readPoints(p, 3);
          if (!pts) return null;
          const c = circleFrom3Points(pts[0], pts[1], pts[2]);
          if (!c) break;
          const points = [];
          for (let i = 0; i < 32; i++) {
            const a = (i / 32) * TWO_PI;
            points.push(transformPoint(state.matrix, c.cx + Math.cos(a) * c.r, c.cy + Math.sin(a) * c.r));
          }
          emitPolyline(points, true);
          stats.circles++;
          state.fill = false;
          break;
        }

        case AUTOCAD_OPCODE.CIRCULAR_ARC: {
          if (size < 100) return null;
          const cx = buf.readDoubleLE(p);
          const cy = buf.readDoubleLE(p + 8);
          const r = buf.readDoubleLE(p + 24);
          const ux = buf.readDoubleLE(p + 56);
          const uy = buf.readDoubleLE(p + 64);
          const sweep = buf.readDoubleLE(p + 80);
          if (![cx, cy, r, ux, uy, sweep].every(isFiniteNumber) || !(r > 0)) break;
          if (!sweep || Math.abs(sweep) > TWO_PI + 1e-6) break;
          const local = arcPoints(cx, cy, r, Math.atan2(uy, ux), sweep, 1024);
          if (!local) break;
          emitPolyline(local.map(([x, y]) => transformPoint(state.matrix, x, y)), false);
          stats.arcs++;
          state.fill = false;
          break;
        }

        case AUTOCAD_OPCODE.CIRCULAR_ARC_3P: {
          if (size < 8 + 76) return null;
          const pts = readPoints(p, 3);
          if (!pts) return null;
          const c = circleFrom3Points(pts[0], pts[1], pts[2]);
          if (!c) break;
          // 3 点弧的顺序：起点、弧上一点、终点；用扫描方向判断
          let a0 = Math.atan2(pts[0][1] - c.cy, pts[0][0] - c.cx);
          let a1 = Math.atan2(pts[2][1] - c.cy, pts[2][0] - c.cx);
          let sweep = a1 - a0;
          const mid = Math.atan2(pts[1][1] - c.cy, pts[1][0] - c.cx);
          const norm = (a) => ((a % TWO_PI) + TWO_PI) % TWO_PI;
          if (norm(mid - a0) > norm(a1 - a0)) {
            if (sweep <= 0) sweep += TWO_PI;
          } else if (sweep >= 0) {
            sweep -= TWO_PI;
          }
          const local = arcPoints(c.cx, c.cy, c.r, a0, sweep, 1024);
          if (!local) break;
          emitPolyline(local.map(([x, y]) => transformPoint(state.matrix, x, y)), false);
          stats.arcs++;
          state.fill = false;
          break;
        }

        case AUTOCAD_OPCODE.ELLIPTIC_ARC: {
          if (size < 8 + 88) return null;
          const cx = buf.readDoubleLE(p);
          const cy = buf.readDoubleLE(p + 8);
          const major = buf.readDoubleLE(p + 48);
          const minor = buf.readDoubleLE(p + 56);
          const startParam = buf.readDoubleLE(p + 64);
          const endParam = buf.readDoubleLE(p + 72);
          const axisAngle = buf.readDoubleLE(p + 80);
          if (![cx, cy, major, minor, startParam, endParam, axisAngle].every(isFiniteNumber)) break;
          if (!(major > 0) || !(minor > 0)) break;
          let sweep = endParam - startParam;
          if (sweep <= 0) sweep += TWO_PI;
          const steps = Math.max(2, Math.min(2048, Math.ceil(Math.abs(sweep) / (Math.PI / 18))));
          const cosR = Math.cos(axisAngle);
          const sinR = Math.sin(axisAngle);
          const points = [];
          for (let i = 0; i <= steps; i++) {
            const t = startParam + (sweep * i) / steps;
            const ex = major * Math.cos(t);
            const ey = minor * Math.sin(t);
            points.push(transformPoint(state.matrix, cx + ex * cosR - ey * sinR, cy + ex * sinR + ey * cosR));
          }
          emitPolyline(points, false);
          stats.ellipses++;
          state.fill = false;
          break;
        }

        case AUTOCAD_OPCODE.MESH: {
          if (size < 8 + 8) return null;
          const rows = buf.readUInt32LE(p);
          const cols = buf.readUInt32LE(p + 4);
          const n = rows * cols;
          if (!(rows >= 1) || !(cols >= 1) || n > 200_000) break;
          if (p + 8 + n * 24 > end) return null;
          const grid = readPoints(p + 8, n, 24);
          if (!grid) return null;
          if (state.fill) {
            for (let r = 0; r + 1 < rows; r++) {
              for (let c = 0; c + 1 < cols; c++) {
                const i0 = r * cols + c;
                const i1 = i0 + 1;
                const i2 = i0 + cols;
                const i3 = i2 + 1;
                emitTriangle(grid[i0], grid[i1], grid[i3]);
                emitTriangle(grid[i0], grid[i3], grid[i2]);
              }
            }
          } else {
            for (let r = 0; r < rows; r++) emitPolyline(grid.slice(r * cols, r * cols + cols), false);
            for (let c = 0; c < cols; c++) {
              const line = [];
              for (let r = 0; r < rows; r++) line.push(grid[r * cols + c]);
              emitPolyline(line, false);
            }
          }
          stats.meshes++;
          state.fill = false;
          break;
        }

        case AUTOCAD_OPCODE.SHELL: {
          if (size < 8 + 8) return null;
          const n = buf.readUInt32LE(p);
          if (!(n >= 1) || n > 200_000) break;
          let at = p + 4;
          if (at + n * 24 + 4 > end) return null;
          const vertices = readPoints(at, n, 24);
          if (!vertices) return null;
          at += n * 24;
          const faceListSize = buf.readUInt32LE(at);
          at += 4;
          if (faceListSize > 2_000_000) break;
          const faces = [];
          let readInts = 0;
          while (readInts < faceListSize && at + 4 <= end) {
            const raw = buf.readInt32LE(at);
            at += 4;
            readInts++;
            const count = Math.abs(raw);
            if (count < 1 || count > 100_000 || readInts + count > faceListSize) break;
            const idx = [];
            for (let i = 0; i < count; i++) {
              const v = buf.readInt32LE(at);
              at += 4;
              idx.push(v);
            }
            readInts += count;
            faces.push(idx);
          }
          for (const face of faces) {
            const pts = face.map((i) => vertices[i]).filter(Boolean);
            if (pts.length < 3) continue;
            if (state.fill) emitTriangulated(pts);
            else emitPolyline(pts, true);
          }
          stats.shells++;
          state.fill = false;
          break;
        }

        case AUTOCAD_OPCODE.LWPOLYLINE: {
          const decoded = decodeLwPolyline(buf, p, end, {
            transformPoint: (x, y) => transformPoint(state.matrix, x, y),
          });
          if (!decoded) {
            markUnsupported(opcode);
            break;
          }
          emitPolyline(decoded.points, decoded.closed);
          stats.lwpolylines++;
          state.fill = false;
          break;
        }

        case AUTOCAD_OPCODE.TEXT:
          if (size < 80) return null;
          emitText(p, end, "text");
          state.fill = false;
          break;

        case AUTOCAD_OPCODE.TEXT2:
          if (size < 80) return null;
          emitText(p, end, "text2");
          state.fill = false;
          break;

        case AUTOCAD_OPCODE.UNICODE_TEXT:
          if (size < 80) return null;
          emitText(p, end, "unicode");
          state.fill = false;
          break;

        case AUTOCAD_OPCODE.UNICODE_TEXT2:
          if (size < 80) return null;
          emitText(p, end, "unicode2");
          state.fill = false;
          break;

        case AUTOCAD_OPCODE.XLINE:
        case AUTOCAD_OPCODE.RAY: {
          if (size < 8 + 48) return null;
          const a = readPoints(p, 1, 24);
          const b = readPoints(p + 24, 1, 24);
          if (!a || !b) return null;
          emitPolyline([a[0], b[0]], false, { infinite: true });
          if (opcode === AUTOCAD_OPCODE.XLINE) stats.xlines++;
          else stats.rays++;
          state.fill = false;
          break;
        }

        case AUTOCAD_OPCODE.PUSH_CLIP:
        case AUTOCAD_OPCODE.MATERIAL:
        case AUTOCAD_OPCODE.MAPPER:
          markUnsupported(opcode);
          break;

        default:
          markUnsupported(opcode);
          break;
      }
    } catch (err) {
      if (err instanceof RangeError) {
        stats.truncated = true;
        return null;
      }
      return null;
    }

    pos = end;
  }

  if (pos !== total) return null;

  stats.primitives = primitives.length;
  stats.points = state.points;
  stats.hasGeometry = stats.geometryRecords > 0;
  stats.traitOnly = !stats.hasGeometry;
  return {
    primitives,
    unsupportedKinds: { ...unsupportedKinds },
    stats,
    matrix: state.lastMatrix,
  };
}

/**
 * 33 号 LWPOLYLINE 的位压缩解析：u32 numDataBytes，然后按 ODA 的 bit stream 读。
 * 返回的是**已经应用当前矩阵**的折线点；bulge 会在局部坐标展开后再变换。
 */
function decodeLwPolyline(buf, payloadStart, end, { transformPoint }) {
  try {
    const bs = new BitReader(buf, payloadStart);
    const declaredBytes = bs.readUnsignedLong();
    if (declaredBytes > end - payloadStart - 4) return null;
    const flag = bs.readBitShort();
    let constWidth = null;
    let elevation = null;
    let thickness = null;
    let extrusion = null;
    if (flag & 4) constWidth = bs.readBitDouble();
    if (flag & 8) elevation = bs.readBitDouble();
    if (flag & 2) thickness = bs.readBitDouble();
    if (flag & 1) extrusion = [bs.readBitDouble(), bs.readBitDouble(), bs.readBitDouble()];
    const closed = (flag & 512) !== 0;
    const numPoints = bs.readBitLong();
    if (!(numPoints >= 1) || numPoints > 1_000_000) return null;
    let numBulges = 0;
    let numVertexIds = 0;
    let numWidths = 0;
    if (flag & 16) numBulges = bs.readBitLong();
    if (flag & 1024) numVertexIds = bs.readBitLong();
    if (flag & 32) numWidths = bs.readBitLong();
    if (numBulges < 0 || numBulges > numPoints) return null;
    if (numVertexIds < 0 || numVertexIds > numPoints) return null;
    if (numWidths < 0 || numWidths > numPoints) return null;

    const local = [];
    let prevX = bs.readFloat();
    let prevY = bs.readFloat();
    if (!isFiniteNumber(prevX) || !isFiniteNumber(prevY)) return null;
    local.push([prevX, prevY]);
    for (let i = 1; i < numPoints; i++) {
      const x = bs.readBitDoubleDefault(prevX);
      const y = bs.readBitDoubleDefault(prevY);
      if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
      prevX = x;
      prevY = y;
      local.push([x, y]);
    }
    const bulges = [];
    for (let i = 0; i < numBulges; i++) bulges.push(bs.readBitDouble());
    for (let i = 0; i < numVertexIds; i++) bs.readBitLong();
    for (let i = 0; i < numWidths; i++) {
      bs.readBitDouble();
      bs.readBitDouble();
    }

    const points = [transformPoint(local[0][0], local[0][1])];
    for (let i = 0; i < local.length; i++) {
      const isLast = i === local.length - 1;
      if (isLast && !closed) break;
      const next = isLast ? local[0] : local[i + 1];
      const bulge = bulges[i] ?? 0;
      const segment = bulgePoints(local[i], next, bulge);
      for (const [x, y] of segment) points.push(transformPoint(x, y));
    }
    return { points, closed };
  } catch {
    return null;
  }
}
