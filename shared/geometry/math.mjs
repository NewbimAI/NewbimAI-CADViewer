/**
 * shared/geometry/math.mjs
 *
 * Pure 2D geometry primitives used by the CAD comparison kernel.
 * No dependencies, no I/O.  Points are accepted either as `{x, y}` or `[x, y]`.
 *
 * All angles in the *public* API of this module are RADIANS unless a function
 * says otherwise (`angleBetween` takes degrees, `arcToPoints` takes radians).
 * Raw DXF entity angles are normalised by `shared/geometry/entity.mjs`.
 */

/** Default angular step used when flattening arcs/circles, in degrees. */
export const DEFAULT_ARC_STEP_DEG = 6

const TAU = Math.PI * 2
const DEG = Math.PI / 180

/* ------------------------------------------------------------------ */
/* small internal helpers                                              */
/* ------------------------------------------------------------------ */

function finite(v) {
  return typeof v === 'number' && Number.isFinite(v)
}

export function pointX(p) {
  if (!p) return NaN
  return finite(p.x) ? p.x : p[0]
}

export function pointY(p) {
  if (!p) return NaN
  return finite(p.y) ? p.y : p[1]
}

function stepRadians(stepDeg) {
  const d = finite(stepDeg) && stepDeg > 0 ? stepDeg : DEFAULT_ARC_STEP_DEG
  return d * DEG
}

/**
 * Push one point, optionally transformed by the affine matrix `m`
 * (`null` means identity, the fast path used by the kernel).
 * Non-finite coordinates are dropped instead of poisoning bounding boxes.
 */
export function _pushPoint(out, x, y, m) {
  if (!finite(x) || !finite(y)) return
  if (m) out.push([m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]])
  else out.push([x, y])
}

/**
 * Flatten an arc into `out` (internal fast path).
 *
 * `out`         target array of [x, y] pairs
 * `skipFirst`   do not emit the i === 0 sample (used when the caller already
 *               emitted the arc's start point, e.g. polyline bulge segments)
 * `m`           affine matrix applied on the fly, or null for identity.
 *
 * Sweep direction wraps through 2π (DXF arcs can run e.g. 350° -> 10°).
 * A zero sweep emits a single point.  Full circles (sweep = 2π) emit
 * `n + 1` samples, so first and last point coincide.
 */
export function _emitArc(out, cx, cy, r, start, end, ccw, stepDeg, m, skipFirst) {
  if (!finite(cx) || !finite(cy) || !finite(start) || !finite(end)) return

  if (!(r > 0)) {
    if (r === 0 && !skipFirst) _pushPoint(out, cx, cy, m)
    return
  }
  if (!finite(r)) return

  let sweep = ccw ? end - start : start - end
  if (!finite(sweep)) return

  if (Math.abs(sweep) < 1e-12) {
    // Degenerate arc: a single point, never a full circle by accident.
    if (!skipFirst) _pushPoint(out, cx + r * Math.cos(start), cy + r * Math.sin(start), m)
    return
  }

  if (sweep < 0) {
    sweep = TAU - (-sweep % TAU)
  } else if (sweep > TAU) {
    sweep %= TAU
  }
  if (sweep >= TAU - 1e-12) sweep = TAU

  const step = stepRadians(stepDeg)
  let n = Math.ceil(sweep / step - 1e-9)
  if (!finite(n) || n < 1) n = 1
  // Hard safety cap: a caller passing stepDeg ~ 0 must not freeze the process.
  if (n > 100000) n = 100000

  const dir = ccw ? 1 : -1
  const d = sweep / n
  const first = skipFirst ? 1 : 0
  for (let i = first; i <= n; i++) {
    const a = start + dir * d * i
    _pushPoint(out, cx + r * Math.cos(a), cy + r * Math.sin(a), m)
  }
}

/* ------------------------------------------------------------------ */
/* bulge / arc mathematics                                             */
/* ------------------------------------------------------------------ */

/**
 * Convert a polyline bulge segment to arc parameters.
 *
 * bulge = tan(theta / 4); positive bulge = counter-clockwise arc from p1 to p2.
 *
 * Returns `{ cx, cy, r, start, end, theta, ccw, length, sagitta }` or `null`
 * for bulge === 0 and for degenerate (zero-length chord) segments.
 *
 * Sign convention (verified by tests):
 *   b = 1, c = 1  ->  r = c/2, theta = π, length = πc/2, sagitta = c/2.
 */
export function bulgeToArc(p1, p2, bulge) {
  if (!p1 || !p2) return null
  const b = bulge
  if (!finite(b) || b === 0) return null

  const x1 = pointX(p1)
  const y1 = pointY(p1)
  const x2 = pointX(p2)
  const y2 = pointY(p2)
  if (!finite(x1) || !finite(y1) || !finite(x2) || !finite(y2)) return null

  const dx = x2 - x1
  const dy = y2 - y1
  const c = Math.hypot(dx, dy)
  if (!(c > 0) || !finite(c)) return null

  const theta = 4 * Math.atan(b)
  const half = theta / 2
  const sinHalf = Math.abs(Math.sin(half))
  if (!(sinHalf > 0)) return null

  const r = c / (2 * sinHalf)
  if (!finite(r) || !(r > 0)) return null

  // Distance from chord midpoint to the centre, along the left normal of
  // p1 -> p2.  d = (c/2) * cot(theta/2) = c * (1 - b²) / (4b).
  const d = (c * (1 - b * b)) / (4 * b)
  if (!finite(d)) return null

  const mx = (x1 + x2) / 2
  const my = (y1 + y2) / 2
  const nx = -dy / c // left normal
  const ny = dx / c
  const cx = mx + nx * d
  const cy = my + ny * d

  const start = Math.atan2(y1 - cy, x1 - cx)
  const end = Math.atan2(y2 - cy, x2 - cx)

  return {
    cx,
    cy,
    r,
    start,
    end,
    theta,
    ccw: b > 0,
    length: r * Math.abs(theta),
    sagitta: (Math.abs(b) * c) / 2,
  }
}

/**
 * Flatten an arc to an array of `[x, y]` points including both endpoints.
 * A full circle (|end - start| = 2π) returns n + 1 points with a duplicated
 * first/last point.  `stepDeg` is the maximum angular step.
 */
export function arcToPoints(cx, cy, r, start, end, ccw, stepDeg = DEFAULT_ARC_STEP_DEG) {
  const out = []
  _emitArc(out, cx, cy, r, start, end, !!ccw, stepDeg, null, false)
  return out
}

/* ------------------------------------------------------------------ */
/* lengths, areas, angles                                              */
/* ------------------------------------------------------------------ */

/** Total length of an open polyline (implicitly connected point list). */
export function polylineLength(points) {
  if (!Array.isArray(points) || points.length < 2) return 0
  let len = 0
  for (let i = 1; i < points.length; i++) {
    const ax = pointX(points[i - 1])
    const ay = pointY(points[i - 1])
    const bx = pointX(points[i])
    const by = pointY(points[i])
    if (!finite(ax) || !finite(ay) || !finite(bx) || !finite(by)) continue
    len += Math.hypot(bx - ax, by - ay)
  }
  return len
}

/**
 * Signed area of a polygon (implicitly closed), counter-clockwise positive.
 * Fewer than 3 points -> 0.
 */
export function polygonArea(points) {
  if (!Array.isArray(points) || points.length < 3) return 0
  let a = 0
  const n = points.length
  for (let i = 0; i < n; i++) {
    const p = points[i]
    const q = points[(i + 1) % n]
    const x1 = pointX(p)
    const y1 = pointY(p)
    const x2 = pointX(q)
    const y2 = pointY(q)
    if (!finite(x1) || !finite(y1) || !finite(x2) || !finite(y2)) continue
    a += x1 * y2 - x2 * y1
  }
  return a / 2
}

/**
 * Circular-segment area r²/2 · (θ - sin θ), with the sign of θ.
 * Uses a series for tiny θ to avoid catastrophic cancellation.
 */
function segmentArea(r, theta) {
  const at = Math.abs(theta)
  let core
  if (at < 1e-3) {
    const a2 = at * at
    core = (at * a2) / 6 * (1 - a2 / 20 + (a2 * a2) / 840)
  } else {
    core = at - Math.sin(at)
  }
  return (r * r) / 2 * core * (theta < 0 ? -1 : 1)
}

/**
 * Signed area of a closed polyline whose vertices carry per-vertex bulges.
 * `vertices` = `[{x, y, bulge?}, ...]`; the bulge of vertex i applies to the
 * segment i -> i+1 (wrapping to vertex 0 through the last vertex's bulge).
 *
 * Counter-clockwise positive.  A 2-vertex list with bulge 1 gives the area of
 * the circular segment, πc²/8.
 */
export function polylineAreaWithBulges(vertices) {
  if (!Array.isArray(vertices) || vertices.length < 2) return 0

  let area = polygonArea(vertices)
  const n = vertices.length
  for (let i = 0; i < n; i++) {
    const a = vertices[i]
    const b = vertices[(i + 1) % n]
    if (!a || !b) continue
    const bulge = a.bulge
    if (!finite(bulge) || bulge === 0) continue
    const arc = bulgeToArc(a, b, bulge)
    if (!arc) continue
    area += segmentArea(arc.r, arc.theta)
  }
  return area
}

/** Smallest angle between two directions given in DEGREES, in [0, 180]. */
export function angleBetween(a1, a2) {
  if (!finite(a1) || !finite(a2)) return NaN
  let d = Math.abs((a1 - a2) % 360)
  if (d > 180) d = 360 - d
  return d
}

/**
 * Circumradius of the triangle p1-p2-p3, or null when the points are
 * (numerically) collinear.  Works for `{x, y}` and `[x, y]` points.
 */
export function radiusFrom3Points(p1, p2, p3) {
  if (!p1 || !p2 || !p3) return null
  const x1 = pointX(p1)
  const y1 = pointY(p1)
  const x2 = pointX(p2)
  const y2 = pointY(p2)
  const x3 = pointX(p3)
  const y3 = pointY(p3)
  if (!finite(x1) || !finite(y1) || !finite(x2) || !finite(y2) || !finite(x3) || !finite(y3)) {
    return null
  }

  // Twice the signed triangle area.
  const area2 = (x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1)
  const scale = Math.max(1, Math.abs(x1), Math.abs(y1), Math.abs(x2), Math.abs(y2), Math.abs(x3), Math.abs(y3))
  if (!finite(area2) || Math.abs(area2) <= 1e-12 * scale * scale) {
    return null // collinear / degenerate
  }

  const a = Math.hypot(x2 - x3, y2 - y3)
  const b = Math.hypot(x1 - x3, y1 - y3)
  const c = Math.hypot(x1 - x2, y1 - y2)
  const radius = (a * b * c) / (2 * Math.abs(area2))
  return finite(radius) ? radius : null
}

/* ------------------------------------------------------------------ */
/* axis aligned bounding boxes                                         */
/* ------------------------------------------------------------------ */

/** `{minX, minY, maxX, maxY}` for a point list, or null when empty/invalid. */
export function bboxOfPoints(points) {
  if (!Array.isArray(points) || points.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let any = false
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    if (!p) continue
    const x = pointX(p)
    const y = pointY(p)
    if (!finite(x) || !finite(y)) continue
    any = true
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  return any ? { minX, minY, maxX, maxY } : null
}

/** Union of two bboxes; either null returns the other. */
export function bboxUnion(a, b) {
  if (!a) return b || null
  if (!b) return a
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  }
}

/** True when the two boxes overlap or touch (inflated by `pad`). */
export function bboxesIntersect(a, b, pad = 0) {
  if (!a || !b) return false
  const p = finite(pad) ? pad : 0
  return (
    a.minX - p <= b.maxX &&
    b.minX - p <= a.maxX &&
    a.minY - p <= b.maxY &&
    b.minY - p <= a.maxY
  )
}

/** Squared distance between two bboxes; 0 when they overlap. */
export function bboxDistanceSq(a, b) {
  if (!a || !b) return Infinity
  const dx = Math.max(a.minX - b.maxX, b.minX - a.maxX, 0)
  const dy = Math.max(a.minY - b.maxY, b.minY - a.maxY, 0)
  return dx * dx + dy * dy
}
