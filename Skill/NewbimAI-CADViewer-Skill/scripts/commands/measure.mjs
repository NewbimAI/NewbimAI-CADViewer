/**
 * measure —— 坐标测量（纯算式，不读 DXF、不起服务）。
 *
 * 为什么只做坐标测量：贴合图元的量（墙厚、门窗洞宽、房间净面积）必须走界面测量工具，
 * 它有端点/中点/圆心/象限点/交点/最近点吸附；在命令行里手写几何解析会与界面口径分叉。
 * 这里只回答"给两个/几个图纸坐标，距离/长度/面积/角度是多少"这类问题，
 * 答案与界面测量工具在同一个坐标系（图纸 WCS，单位 = 图纸单位）下可直接对照。
 */

const KINDS = ["distance", "length", "area", "angle"];

/**
 * 解析 "x,y;x,y"（也接受 x,y x,y / 中文分号 / 换行）。
 * @returns {{x:number,y:number}[]}
 */
export function parsePoints(raw) {
  const text = String(raw == null ? "" : raw).trim();
  if (!text) return [];
  return text
    .split(/[;\n；]+/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const parts = chunk.split(/[,，\s]+/).filter(Boolean);
      if (parts.length !== 2) {
        throw new Error(`坐标格式应为 x,y：收到 "${chunk}"`);
      }
      const x = Number(parts[0]);
      const y = Number(parts[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error(`坐标不是数字：收到 "${chunk}"`);
      }
      return { x, y };
    });
}

const round = (n, digits = 3) => {
  if (!Number.isFinite(n)) return n;
  const p = 10 ** digits;
  return Math.round(n * p) / p;
};

export function distance(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function polylineLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distance(points[i - 1], points[i]);
  return total;
}

/** 带符号面积（逆时针为正），与 docs/compare-contract.md 的 polygonArea 口径一致。 */
export function signedArea(points) {
  if (points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

/** 向量 (from→at) 的方位角：0° = +X，逆时针为正。 */
export function azimuth(from, at) {
  const deg = (Math.atan2(at.y - from.y, at.x - from.x) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/** 以 vertex 为顶点、射线 vertex→a 与 vertex→c 的夹角（0..180）。 */
export function angleAt(a, vertex, c) {
  const v1 = { x: a.x - vertex.x, y: a.y - vertex.y };
  const v2 = { x: c.x - vertex.x, y: c.y - vertex.y };
  const l1 = Math.hypot(v1.x, v1.y);
  const l2 = Math.hypot(v2.x, v2.y);
  if (l1 === 0 || l2 === 0) throw new Error("夹角测量需要三个互不重合的点");
  const cos = Math.min(1, Math.max(-1, (v1.x * v2.x + v1.y * v2.y) / (l1 * l2)));
  return (Math.acos(cos) * 180) / Math.PI;
}

/**
 * @param {{ kind?: string, points?: string, from?: string, to?: string }} opts
 */
export function measure(opts) {
  const kind = String(opts.kind || "").toLowerCase();
  if (!KINDS.includes(kind)) {
    throw new Error(`measure 需要子命令 ${KINDS.join("|")}`);
  }

  let points = parsePoints(opts.points);
  if (kind === "distance" && points.length === 0 && (opts.from || opts.to)) {
    points = [...parsePoints(opts.from), ...parsePoints(opts.to)];
  }

  const need = { distance: 2, length: 2, area: 3, angle: 3 }[kind];
  if (points.length < need) {
    throw new Error(`${kind} 至少需要 ${need} 个点：--points "x,y;x,y${need === 3 ? ";x,y" : ""}"`);
  }

  const base = {
    ok: true,
    kind,
    unit: "图纸单位（与 readout/text 的坐标一致；$INSUNITS=4 时为毫米）",
    points,
    note: "坐标测量只做算式；贴合图元的量（墙厚/洞宽/净面积）请用界面底部工具条的测量工具（带端点/中点/交点吸附）。",
  };

  if (kind === "distance") {
    const [a, b] = points;
    return {
      ...base,
      distance: round(distance(a, b)),
      dx: round(b.x - a.x),
      dy: round(b.y - a.y),
      azimuthDeg: round(azimuth(a, b)),
    };
  }

  if (kind === "length") {
    const segments = [];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      segments.push({
        from: a,
        to: b,
        dx: round(b.x - a.x),
        dy: round(b.y - a.y),
        length: round(distance(a, b)),
      });
    }
    return { ...base, segments, total: round(polylineLength(points)) };
  }

  if (kind === "area") {
    const area = signedArea(points);
    return {
      ...base,
      area: round(Math.abs(area)),
      signedArea: round(area),
      perimeter: round(polylineLength(points) + distance(points[points.length - 1], points[0])),
      orientation: area >= 0 ? "ccw" : "cw",
      closed: true,
    };
  }

  // angle：三个点 a → vertex → c
  const [a, vertex, c] = points;
  return {
    ...base,
    angleDeg: round(angleAt(a, vertex, c)),
    azimuthADeg: round(azimuth(vertex, a)),
    azimuthCDeg: round(azimuth(vertex, c)),
    legA: round(distance(vertex, a)),
    legC: round(distance(vertex, c)),
  };
}
