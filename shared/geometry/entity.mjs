/**
 * shared/geometry/entity.mjs
 *
 * Entity -> primitive conversion for the CAD comparison kernel.
 *
 * Input entities follow the dxf-parser v1.1.x object shape.  All output
 * coordinates are WCS (block INSERT transforms and OCS extrusion composed).
 *
 * == Primitive shapes (frozen by docs/compare-contract.md §2) ==
 *   { kind: "polyline", points: [[x, y], ...], closed: boolean }
 *   { kind: "point", x, y }
 *   { kind: "text", x, y, height, rotation, text, layer }
 *
 * == Warnings (ctx.warnings is a Set<string>) ==
 *   entity:<TYPE>                 an entity threw while being converted
 *   unsupported:<TYPE>            type is not compared
 *   not-compared:hatch            HATCH skipped because includeHatch is false
 *   dimension:no-block            DIMENSION without a resolvable block
 *   insert:missing-block:<NAME>   INSERT referencing an unknown block
 *   insert:max-depth:<NAME>       INSERT nesting exceeded ctx.maxDepth
 *   insert:cycle:<NAME>           INSERT self/cyclic reference
 *   spline:approximated           SPLINE flattened through control points
 *   arc:non-uniform-scale         arc/circle under a non-uniform transform
 *   hatch:path                    HATCH boundary path could not be flattened
 *
 * The returned object also carries an optional `notCompared` reason string in
 * addition to the documented `{ primitives, bbox }`; the server diff engine
 * uses it to build the `not-compared` warnings.
 */

import { _emitArc, bulgeToArc, DEFAULT_ARC_STEP_DEG, _pushPoint } from './math.mjs'
import {
  identityMatrix,
  isIdentityMatrix,
  composeMatrix,
  _mulMatrix,
  matrixScale,
  _ocsMatrix,
} from './matrix.mjs'

const TAU = Math.PI * 2
const DEG = Math.PI / 180
const IDENTITY = identityMatrix()

const EMPTY_CTX = { blocks: null, warnings: null }

const MTEXT_PARAM_CODES = new Set(['f', 'F', 'H', 'W', 'Q', 'T', 'A', 'C', 'c', 'p'])
const WHITESPACE_RE = /\s+/g

function finite(v) {
  return typeof v === 'number' && Number.isFinite(v)
}

function warn(ctx, code) {
  if (ctx && ctx.warnings && typeof ctx.warnings.add === 'function') {
    ctx.warnings.add(code)
  }
}

function emptyResult(notCompared) {
  return notCompared
    ? { primitives: [], bbox: null, notCompared }
    : { primitives: [], bbox: null }
}

/* ------------------------------------------------------------------ */
/* text helpers (also used by the fingerprint module)                  */
/* ------------------------------------------------------------------ */

/**
 * Strip MTEXT inline formatting.  `\P` becomes `newline` (default space),
 * parameter codes (`\f`, `\H`, `\C`, ...) are dropped up to `;`, braces are
 * removed, `\S...;` stacking keeps its content with `^` -> `/`.
 * Non-string input yields "".
 */
export function plainText(input, newline) {
  if (typeof input !== 'string') return ''
  const nl = newline === undefined ? ' ' : newline
  let out = ''
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === '\\') {
      const next = input[i + 1]
      if (next === undefined) break
      if (next === 'P' || next === 'p') {
        out += nl
        i++
        continue
      }
      if (next === '~') {
        out += ' '
        i++
        continue
      }
      if (next === '\\') {
        out += '\\'
        i++
        continue
      }
      if (next === '{' || next === '}') {
        out += next
        i++
        continue
      }
      if (next === 'S') {
        i += 2
        while (i < input.length && input[i] !== ';') {
          out += input[i] === '^' ? '/' : input[i]
          i++
        }
        continue // the for-loop increment skips the ';'
      }
      if (MTEXT_PARAM_CODES.has(next)) {
        i += 2
        while (i < input.length && input[i] !== ';') i++
        continue
      }
      // Unknown escape: keep the payload, drop the backslash.
      out += next
      i++
      continue
    }
    if (ch === '{' || ch === '}') continue
    out += ch
  }
  return out
}

/** Font/size-independent text content: codes stripped, whitespace collapsed. */
export function normalizeText(input) {
  const s = plainText(input, ' ')
  return s.replace(WHITESPACE_RE, ' ').trim()
}

/* ------------------------------------------------------------------ */
/* angle handling                                                      */
/* ------------------------------------------------------------------ */

function anglesRadians(startAngle, endAngle, entity, ctx, defaultDegrees) {
  let s = finite(startAngle) ? startAngle : 0
  let e = finite(endAngle) ? endAngle : s + (defaultDegrees ? 360 : TAU)

  const units = ctx && ctx.angleUnits
  if (units === 'rad') return { start: s, end: e }
  if (units === 'deg') return { start: s * DEG, end: e * DEG }

  // Auto.  dxf-parser v1.1.x converts ARC/CIRCLE group 50/51 to radians and
  // also sets `angleLength` (= end - start, radians).  Use that as the
  // authoritative "these are radians" signal.
  if (finite(entity && entity.angleLength)) {
    const delta = e - s
    const al = entity.angleLength
    if (Math.abs(delta - al) <= 1e-6 * Math.max(1, Math.abs(al))) {
      return { start: s, end: e }
    }
  }

  // Angles beyond 2π can only be degrees (DXF stores 0..360).
  if (Math.abs(s) > TAU + 1e-9 || Math.abs(e) > TAU + 1e-9) {
    return { start: s * DEG, end: e * DEG }
  }

  // Contract wording for ARC: group 50/51 are DXF degrees.  Synthetic
  // callers that hand us radians should either set `angleLength` (as
  // dxf-parser does) or pass ctx.angleUnits = "rad".
  if (defaultDegrees) return { start: s * DEG, end: e * DEG }
  return { start: s, end: e }
}

/** Radians for ARC / CIRCLE. */
export function _arcRadians(entity, ctx) {
  return anglesRadians(entity.startAngle, entity.endAngle, entity, ctx, true)
}

/** Radians for ELLIPSE (DXF parametric angles are radians). */
export function _ellipseRadians(entity, ctx) {
  return anglesRadians(entity.startAngle, entity.endAngle, null, ctx, false)
}

function _hatchArcRadians(entity, ctx) {
  return anglesRadians(entity.startAngle, entity.endAngle, null, ctx, true)
}

/* ------------------------------------------------------------------ */
/* OCS / bounds helpers                                                */
/* ------------------------------------------------------------------ */

function numberOrNull(v) {
  return finite(v) ? v : null
}

function normalOf(entity) {
  if (!entity) return null
  const d = entity.extrusionDirection || entity.normalVector
  if (d && typeof d === 'object') {
    const nx = numberOrNull(d.x)
    const ny = numberOrNull(d.y)
    const nz = numberOrNull(d.z)
    if (nx !== null || ny !== null || nz !== null) {
      return { x: nx || 0, y: ny || 0, z: nz === null ? 1 : nz }
    }
    return null
  }
  if (
    entity.extrusionDirectionX !== undefined ||
    entity.extrusionDirectionY !== undefined ||
    entity.extrusionDirectionZ !== undefined
  ) {
    return {
      x: numberOrNull(entity.extrusionDirectionX) || 0,
      y: numberOrNull(entity.extrusionDirectionY) || 0,
      z: numberOrNull(entity.extrusionDirectionZ) === null ? 1 : entity.extrusionDirectionZ,
    }
  }
  return null
}

export function _normalOf(entity) {
  return normalOf(entity)
}

function firstZ(...candidates) {
  for (let i = 0; i < candidates.length; i++) {
    if (finite(candidates[i])) return candidates[i]
  }
  return 0
}

function elevationOf(entity) {
  if (!entity) return 0
  if (finite(entity.elevation)) return entity.elevation
  if (entity.center) return firstZ(entity.center.z, 0)
  if (entity.position) return firstZ(entity.position.z, 0)
  if (entity.startPoint) return firstZ(entity.startPoint.z, 0)
  if (Array.isArray(entity.points) && entity.points[0]) return firstZ(entity.points[0].z, 0)
  if (Array.isArray(entity.vertices) && entity.vertices[0]) {
    return firstZ(entity.vertices[0].z, 0)
  }
  return 0
}

/** OCS matrix for an entity, or null when it is already WCS / default. */
function ocsOf(entity) {
  const n = normalOf(entity)
  if (!n) return null
  return _ocsMatrix(n.x, n.y, n.z, elevationOf(entity))
}

/** parent * ocs, normalised to null when identity. */
function withOcs(parent, ocs) {
  if (!ocs) return parent
  const m = parent ? _mulMatrix(parent, ocs) : ocs
  return isIdentityMatrix(m) ? null : m
}

function checkArcScale(ctx, m) {
  if (!m) return
  const s = matrixScale(m)
  const hi = Math.max(s.sx, s.sy)
  if (hi > 0 && Math.abs(s.sx - s.sy) > 1e-9 * hi) {
    warn(ctx, 'arc:non-uniform-scale')
  }
}

/** ctx.arcStepDeg override (contract field), falling back to the default. */
function stepDegOf(ctx) {
  const s = ctx && ctx.arcStepDeg
  return finite(s) && s > 0 ? s : DEFAULT_ARC_STEP_DEG
}

function samePoint(a, b) {
  if (!a || !b) return false
  const eps = 1e-9 * (1 + Math.max(Math.abs(a[0]), Math.abs(a[1]), Math.abs(b[0]), Math.abs(b[1])))
  return Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps
}

function dropClosingPoint(points) {
  if (points.length > 1 && samePoint(points[0], points[points.length - 1])) points.pop()
  return points
}

/** Build the bbox of an already-converted primitive list. */
function resultOf(primitives, notCompared) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let any = false

  function add(x, y) {
    if (!finite(x) || !finite(y)) return
    any = true
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }

  for (let i = 0; i < primitives.length; i++) {
    const p = primitives[i]
    if (!p) continue
    if (p.kind === 'polyline') {
      const pts = p.points
      for (let j = 0; j < pts.length; j++) add(pts[j][0], pts[j][1])
    } else if (p.kind === 'point' || p.kind === 'text') {
      add(p.x, p.y)
    }
  }

  const bbox = any ? { minX, minY, maxX, maxY } : null
  return notCompared ? { primitives, bbox, notCompared } : { primitives, bbox }
}

/* ------------------------------------------------------------------ */
/* block lookup (case-insensitive, cached per ctx.blocks object)       */
/* ------------------------------------------------------------------ */

const blockIndexCache = new WeakMap()

function getBlock(ctx, name) {
  if (!ctx || !ctx.blocks || typeof ctx.blocks !== 'object') return null
  if (!name) return null
  const blocks = ctx.blocks
  let index = blockIndexCache.get(blocks)
  if (!index) {
    index = new Map()
    for (const key of Object.keys(blocks)) index.set(key.toUpperCase(), key)
    blockIndexCache.set(blocks, index)
  }
  const actual = index.get(String(name).toUpperCase())
  return actual === undefined ? null : blocks[actual] || null
}

export function _getBlock(ctx, name) {
  return getBlock(ctx, name)
}

/* ------------------------------------------------------------------ */
/* polyline / bulge flattening                                         */
/* ------------------------------------------------------------------ */

export function _collectVertices(entity) {
  const src = entity && entity.vertices
  if (!Array.isArray(src) || src.length === 0) return []
  // Fast path: dxf-parser output is nearly always usable as-is.
  let allUsable = true
  for (let i = 0; i < src.length; i++) {
    const v = src[i]
    if (!v || !finite(v.x) || !finite(v.y)) {
      allUsable = false
      break
    }
  }
  if (allUsable) return src
  const out = []
  for (let i = 0; i < src.length; i++) {
    const v = src[i]
    if (v && finite(v.x) && finite(v.y)) out.push(v)
  }
  return out
}

/**
 * Flatten a bulge polyline into WCS points.
 * `m` may be null (identity).  Returns the point array; emits the closing
 * duplicate removal for closed shapes.
 */
function flattenBulgePolyline(vertices, closed, m, ctx, warnScale) {
  const points = []
  const n = vertices.length
  if (n === 0) return points

  const first = vertices[0]
  _pushPoint(points, first.x, first.y, m)

  const segCount = closed ? n : n - 1
  let usedArc = false
  for (let i = 0; i < segCount; i++) {
    const a = vertices[i]
    const b = vertices[(i + 1) % n]
    const bulge = a && finite(a.bulge) ? a.bulge : 0
    if (bulge !== 0) {
      const arc = bulgeToArc(a, b, bulge)
      if (arc) {
        usedArc = true
        _emitArc(points, arc.cx, arc.cy, arc.r, arc.start, arc.end, arc.ccw,
          stepDegOf(ctx), m, true)
        continue
      }
    }
    _pushPoint(points, b.x, b.y, m)
  }

  if (closed) dropClosingPoint(points)
  if (usedArc && warnScale) checkArcScale(ctx, m)
  return points
}

/* ------------------------------------------------------------------ */
/* SPLINE (de Boor)                                                    */
/* ------------------------------------------------------------------ */

function splineData(entity) {
  const cps = entity.controlPoints
  const deg = finite(entity.degreeOfSplineCurve)
    ? entity.degreeOfSplineCurve
    : finite(entity.degree)
      ? entity.degree
      : null
  const knots = Array.isArray(entity.knotValues)
    ? entity.knotValues
    : Array.isArray(entity.knots)
      ? entity.knots
      : null

  if (!Array.isArray(cps) || cps.length < 2) return null
  if (!Number.isInteger(deg) || deg < 1 || deg >= cps.length) return null
  if (!knots || knots.length !== cps.length + deg + 1) return null

  for (let i = 0; i < knots.length; i++) {
    if (!finite(knots[i])) return null
    if (i > 0 && knots[i] < knots[i - 1]) return null
  }
  for (let i = 0; i < cps.length; i++) {
    if (!cps[i] || !finite(cps[i].x) || !finite(cps[i].y)) return null
  }

  const u0 = knots[deg]
  const u1 = knots[cps.length]
  if (!finite(u0) || !finite(u1) || !(u1 > u0)) return null

  return { cps, deg, knots, u0, u1 }
}

function findSpan(u, count, deg, knots) {
  const n = count - 1
  if (u >= knots[n + 1]) return n
  if (u <= knots[deg]) return deg
  let low = deg
  let high = n + 1
  let mid = (low + high) >> 1
  while (u < knots[mid] || u >= knots[mid + 1]) {
    if (u < knots[mid]) high = mid
    else low = mid
    mid = (low + high) >> 1
    if (mid <= low && mid + 1 >= high) break
  }
  return mid
}

/**
 * de Boor evaluation into preallocated buffers.  `bx`/`by` must have length
 * deg + 1.
 */
function deBoor(u, data, bx, by) {
  const { cps, deg, knots } = data
  const span = findSpan(u, cps.length, deg, knots)
  const base = span - deg
  for (let j = 0; j <= deg; j++) {
    const cp = cps[base + j]
    bx[j] = cp.x
    by[j] = cp.y
  }
  for (let r = 1; r <= deg; r++) {
    for (let j = deg; j >= r; j--) {
      const i = base + j
      const den = knots[i + deg - r + 1] - knots[i]
      const a = den === 0 ? 0 : (u - knots[i]) / den
      const ia = 1 - a
      bx[j] = ia * bx[j - 1] + a * bx[j]
      by[j] = ia * by[j - 1] + a * by[j]
    }
  }
  return [bx[deg], by[deg]]
}

function flattenSpline(entity, ctx, m) {
  const data = splineData(entity)
  if (!data) {
    warn(ctx, 'spline:approximated')
    const fallback = Array.isArray(entity.controlPoints) && entity.controlPoints.length
      ? entity.controlPoints
      : Array.isArray(entity.fitPoints)
        ? entity.fitPoints
        : []
    const out = []
    for (let i = 0; i < fallback.length; i++) {
      const p = fallback[i]
      if (p) _pushPoint(out, p.x, p.y, m)
    }
    return out
  }

  const segments = Math.max(16, Math.min(512, data.cps.length * 8))
  const bx = new Float64Array(data.deg + 1)
  const by = new Float64Array(data.deg + 1)
  const out = []
  const span = data.u1 - data.u0
  for (let i = 0; i <= segments; i++) {
    const u = i === segments ? data.u1 : data.u0 + (span * i) / segments
    const p = deBoor(u, data, bx, by)
    _pushPoint(out, p[0], p[1], m)
  }
  return out
}

/* ------------------------------------------------------------------ */
/* ELLIPSE                                                             */
/* ------------------------------------------------------------------ */

function ellipseSweep(entity, ctx) {
  const { start, end } = _ellipseRadians(entity, ctx)
  let sweep = end - start
  if (!finite(sweep)) return null
  if (Math.abs(sweep) < 1e-12) sweep = 0
  else if (sweep < 0) sweep = TAU - (-sweep % TAU)
  else if (sweep > TAU) sweep %= TAU
  if (sweep >= TAU - 1e-12) return { start, sweep: TAU, closed: true }
  return { start, sweep, closed: false }
}

function flattenEllipse(entity, ctx, m) {
  const c = entity.center
  const maj = entity.majorAxisEndPoint
  if (!c || !maj || !finite(c.x) || !finite(c.y) || !finite(maj.x) || !finite(maj.y)) {
    return { points: [], closed: false }
  }
  const ratio = finite(entity.axisRatio) ? entity.axisRatio : 1
  const sw = ellipseSweep(entity, ctx)
  if (!sw) return { points: [], closed: false }

  const mx = maj.x
  const my = maj.y
  const minorX = -my * ratio
  const minorY = mx * ratio

  const step = stepDegOf(ctx) * DEG
  let n = Math.ceil(sw.sweep / step - 1e-9)
  if (!finite(n) || n < 1) n = 1
  if (n > 100000) n = 100000

  const out = []
  for (let i = 0; i <= n; i++) {
    const t = sw.start + (sw.sweep * i) / n
    const ct = Math.cos(t)
    const st = Math.sin(t)
    _pushPoint(out, c.x + mx * ct + minorX * st, c.y + my * ct + minorY * st, m)
  }
  if (sw.closed) dropClosingPoint(out)
  return { points: out, closed: sw.closed }
}

/* ------------------------------------------------------------------ */
/* HATCH                                                               */
/* ------------------------------------------------------------------ */

function hatchEdgePoints(edge, ctx, out) {
  if (!edge) return false
  const kind = typeof edge.type === 'string' ? edge.type.toLowerCase() : ''
  const typeNum = typeof edge.type === 'number' ? edge.type : null

  const a = edge.start || edge.p1 || edge.from
  const b = edge.end || edge.p2 || edge.to
  if (a && b && finite(a.x) && finite(a.y) && finite(b.x) && finite(b.y)) {
    _pushPoint(out, a.x, a.y, null)
    _pushPoint(out, b.x, b.y, null)
    return true
  }

  if ((kind === 'arc' || typeNum === 2) && edge.center && finite(edge.radius)) {
    const ang = _hatchArcRadians(edge, ctx)
    _emitArc(out, edge.center.x, edge.center.y, edge.radius,
      ang.start, ang.end, !(edge.ccw === false || edge.counterClockwise === false),
      stepDegOf(ctx), null, out.length > 0)
    return true
  }

  if ((kind === 'ellipse' || typeNum === 3) && edge.center && edge.majorAxisEndPoint) {
    const e = flattenEllipse(edge, ctx, null)
    for (let i = 0; i < e.points.length; i++) {
      if (out.length === 0 || i > 0) out.push(e.points[i])
    }
    return e.points.length > 0
  }

  if ((kind === 'spline' || typeNum === 4) && Array.isArray(edge.controlPoints)) {
    const pts = flattenSpline(edge, ctx, null)
    for (let i = 0; i < pts.length; i++) {
      if (out.length === 0 || i > 0) out.push(pts[i])
    }
    return pts.length > 0
  }

  return false
}

function emitHatch(entity, ctx, m) {
  if (!ctx.includeHatch) {
    warn(ctx, 'not-compared:hatch')
    return emptyResult('hatch')
  }
  let paths = Array.isArray(entity.boundaryPaths)
    ? entity.boundaryPaths
    : Array.isArray(entity.paths)
      ? entity.paths
      : null

  // Some HATCH-like payloads are just a bulge vertex ring.
  if ((!paths || paths.length === 0) && Array.isArray(entity.vertices) && entity.vertices.length) {
    paths = [entity]
  }

  if (!paths || paths.length === 0) {
    warn(ctx, 'unsupported:HATCH')
    return emptyResult('hatch')
  }

  const total = withOcs(m, ocsOf(entity))
  const primitives = []
  for (let pi = 0; pi < paths.length; pi++) {
    const path = paths[pi]
    if (!path) continue
    const local = []

    if (Array.isArray(path.vertices) && path.vertices.length) {
      // Bulge-aware so arc boundary segments are not collapsed to chords.
      const pts = flattenBulgePolyline(path.vertices, true, null, ctx, false)
      for (let i = 0; i < pts.length; i++) local.push(pts[i])
    } else if (Array.isArray(path.edges) && path.edges.length) {
      for (let ei = 0; ei < path.edges.length; ei++) {
        if (!hatchEdgePoints(path.edges[ei], ctx, local)) {
          warn(ctx, 'hatch:path')
        }
      }
    } else if (Array.isArray(path) && path.length) {
      for (let i = 0; i < path.length; i++) {
        const v = path[i]
        if (v && finite(v.x) && finite(v.y)) local.push([v.x, v.y])
        else if (Array.isArray(v)) local.push([v[0], v[1]])
      }
    }

    if (local.length === 0) {
      warn(ctx, 'hatch:path')
      continue
    }

    const points = []
    for (let i = 0; i < local.length; i++) {
      _pushPoint(points, local[i][0], local[i][1], total)
    }
    dropClosingPoint(points)
    if (points.length) primitives.push({ kind: 'polyline', points, closed: true })
  }

  if (primitives.length === 0) {
    warn(ctx, 'unsupported:HATCH')
    return emptyResult('hatch')
  }
  return resultOf(primitives)
}

/* ------------------------------------------------------------------ */
/* TEXT / MTEXT                                                        */
/* ------------------------------------------------------------------ */

export function _textRotation(entity, type) {
  if (finite(entity.rotation)) return entity.rotation
  if (type === 'MTEXT' && entity.directionVector) {
    const dx = numberOrNull(entity.directionVector.x)
    const dy = numberOrNull(entity.directionVector.y)
    if (dx !== null && dy !== null && (dx !== 0 || dy !== 0)) {
      return Math.atan2(dy, dx) / DEG
    }
  }
  return 0
}

function transformAngleDegrees(angleDeg, m) {
  if (!m) return angleDeg
  const a = angleDeg * DEG
  const dx = Math.cos(a)
  const dy = Math.sin(a)
  const tx = m[0] * dx + m[2] * dy
  const ty = m[1] * dx + m[3] * dy
  if (!finite(tx) || !finite(ty) || (tx === 0 && ty === 0)) return angleDeg
  let deg = Math.atan2(ty, tx) / DEG
  if (deg < 0) deg += 360
  return deg
}

function emitText(entity, type, ctx, m) {
  const isMtext = type === 'MTEXT'
  const pos = isMtext ? entity.position : entity.startPoint
  if (!pos || !finite(pos.x) || !finite(pos.y)) {
    warn(ctx, 'entity:' + type)
    return emptyResult()
  }

  const height = isMtext
    ? finite(entity.height) ? entity.height : 0
    : finite(entity.textHeight) ? entity.textHeight : 0

  const total = withOcs(m, ocsOf(entity))
  const scale = total ? matrixScale(total) : { sx: 1, sy: 1 }
  const worldHeight = height * scale.sy

  const p = total
    ? { x: total[0] * pos.x + total[2] * pos.y + total[4], y: total[1] * pos.x + total[3] * pos.y + total[5] }
    : { x: pos.x, y: pos.y }

  const rotation = transformAngleDegrees(_textRotation(entity, type), total)
  const text = isMtext ? plainText(entity.text, '\n') : (typeof entity.text === 'string' ? entity.text : '')

  return resultOf([{
    kind: 'text',
    x: p.x,
    y: p.y,
    height: worldHeight,
    rotation,
    text,
    layer: typeof entity.layer === 'string' ? entity.layer : '0',
  }])
}

/* ------------------------------------------------------------------ */
/* main dispatch                                                       */
/* ------------------------------------------------------------------ */

function mergeChildResults(results) {
  const primitives = []
  let bbox = null
  let notCompared
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    if (!r) continue
    if (r.primitives) {
      for (let j = 0; j < r.primitives.length; j++) primitives.push(r.primitives[j])
    }
    if (r.bbox) {
      bbox = bbox
        ? {
            minX: Math.min(bbox.minX, r.bbox.minX),
            minY: Math.min(bbox.minY, r.bbox.minY),
            maxX: Math.max(bbox.maxX, r.bbox.maxX),
            maxY: Math.max(bbox.maxY, r.bbox.maxY),
          }
        : r.bbox
    }
    if (r.notCompared) notCompared = r.notCompared
  }
  const out = { primitives, bbox }
  if (notCompared) out.notCompared = notCompared
  return out
}

function emitLine(entity, ctx, m) {
  // Contract documents `start`/`end`; dxf-parser v1.1.x actually exposes
  // `vertices: [start, end]`.  Accept both.
  const verts = Array.isArray(entity.vertices) ? entity.vertices : null
  const s = entity.start || (verts ? verts[0] : null)
  const e = entity.end || (verts ? verts[1] : null)
  if (!s || !e || !finite(s.x) || !finite(s.y) || !finite(e.x) || !finite(e.y)) {
    warn(ctx, 'entity:LINE')
    return emptyResult()
  }
  const points = []
  _pushPoint(points, s.x, s.y, m)
  _pushPoint(points, e.x, e.y, m)
  return resultOf([{ kind: 'polyline', points, closed: false }])
}

function emitArc(entity, ctx, m) {
  const c = entity.center
  const r = entity.radius
  if (!c || !finite(c.x) || !finite(c.y) || !finite(r)) {
    warn(ctx, 'entity:ARC')
    return emptyResult()
  }
  const total = withOcs(m, ocsOf(entity))
  checkArcScale(ctx, total)

  const ang = _arcRadians(entity, ctx)
  const points = []
  _emitArc(points, c.x, c.y, r, ang.start, ang.end, true, stepDegOf(ctx), total, false)
  if (points.length === 0) return emptyResult()
  return resultOf([{ kind: 'polyline', points, closed: false }])
}

function emitCircle(entity, ctx, m) {
  const c = entity.center
  const r = entity.radius
  if (!c || !finite(c.x) || !finite(c.y) || !finite(r)) {
    warn(ctx, 'entity:CIRCLE')
    return emptyResult()
  }
  const total = withOcs(m, ocsOf(entity))
  checkArcScale(ctx, total)

  const points = []
  _emitArc(points, c.x, c.y, r, 0, TAU, true, stepDegOf(ctx), total, false)
  dropClosingPoint(points)
  if (points.length === 0) return emptyResult()
  return resultOf([{ kind: 'polyline', points, closed: true }])
}

function emitPoint(entity, ctx, m) {
  const p = entity.position || entity.point
  if (!p || !finite(p.x) || !finite(p.y)) {
    warn(ctx, 'entity:POINT')
    return emptyResult()
  }
  const total = withOcs(m, ocsOf(entity))
  const x = total ? total[0] * p.x + total[2] * p.y + total[4] : p.x
  const y = total ? total[1] * p.x + total[3] * p.y + total[5] : p.y
  return resultOf([{ kind: 'point', x, y }])
}

function emitSolid(entity, ctx, m) {
  const src = Array.isArray(entity.points) ? entity.points : []
  const points = []
  const total = withOcs(m, ocsOf(entity))
  for (let i = 0; i < src.length; i++) {
    const p = src[i]
    if (p && finite(p.x) && finite(p.y)) _pushPoint(points, p.x, p.y, total)
  }
  if (points.length === 0) {
    warn(ctx, 'entity:SOLID')
    return emptyResult()
  }
  // DXF SOLID stores 4 corners in 1-2-4-3 order for a non-bowtie outline.
  if (points.length === 4) {
    const t = points[2]
    points[2] = points[3]
    points[3] = t
  }
  dropClosingPoint(points)
  return resultOf([{ kind: 'polyline', points, closed: true }])
}

function emit3dFace(entity, ctx, m) {
  const src = Array.isArray(entity.vertices) ? entity.vertices : []
  const points = []
  for (let i = 0; i < src.length; i++) {
    const p = src[i]
    if (p && finite(p.x) && finite(p.y)) _pushPoint(points, p.x, p.y, m)
  }
  if (points.length === 0) {
    warn(ctx, 'entity:3DFACE')
    return emptyResult()
  }
  dropClosingPoint(points)
  return resultOf([{ kind: 'polyline', points, closed: true }])
}

function emitPolyline(entity, type, ctx, m) {
  const vertices = _collectVertices(entity)
  if (vertices.length === 0) return emptyResult()

  const is3d = type === 'POLYLINE' && (entity.is3dPolyline || entity.is3dPolygonMesh || entity.isPolyfaceMesh)
  const closed = entity.shape === true || entity.closed === true
  const total = is3d ? m : withOcs(m, ocsOf(entity))
  const points = flattenBulgePolyline(vertices, closed, total, ctx, !is3d)

  if (points.length === 0) return emptyResult()
  return resultOf([{ kind: 'polyline', points, closed }])
}

function emitEllipsePrimitive(entity, ctx, m) {
  const e = flattenEllipse(entity, ctx, m)
  if (e.points.length === 0) {
    warn(ctx, 'entity:ELLIPSE')
    return emptyResult()
  }
  return resultOf([{ kind: 'polyline', points: e.points, closed: e.closed }])
}

function emitSpline(entity, ctx, m) {
  const points = flattenSpline(entity, ctx, m)
  if (points.length === 0) {
    warn(ctx, 'unsupported:SPLINE')
    return emptyResult('spline')
  }
  const closed = !!entity.closed
  if (closed) dropClosingPoint(points)
  return resultOf([{
    kind: 'polyline',
    points,
    closed,
  }])
}

function emitInsert(entity, ctx, m, depth, stack) {
  const name = entity.name
  if (!name) {
    warn(ctx, 'entity:INSERT')
    return emptyResult()
  }
  const block = getBlock(ctx, name)
  if (!block || !Array.isArray(block.entities)) {
    warn(ctx, 'insert:missing-block:' + String(name).toUpperCase())
    return emptyResult('block-missing')
  }

  const maxDepth = Number.isInteger(ctx.maxDepth) ? ctx.maxDepth : 8
  if (depth >= maxDepth) {
    warn(ctx, 'insert:max-depth:' + String(name).toUpperCase())
    return emptyResult('max-depth')
  }

  const key = String(name).toUpperCase()
  if (stack.indexOf(key) >= 0) {
    warn(ctx, 'insert:cycle:' + key)
    return emptyResult('cycle')
  }

  const ocs = ocsOf(entity)
  const outer = withOcs(m, ocs)

  // Block base point: INSERT of a block whose base point is not (0,0) must
  // subtract it after scaling/rotation.  dxf-parser exposes it as
  // `block.position`; it is (0,0,0) for the vast majority of drawings.
  const base = block.position || {}
  const baseX = finite(base.x) ? base.x : 0
  const baseY = finite(base.y) ? base.y : 0

  function localInsert(insert) {
    const local = composeMatrix(outer || IDENTITY, insert)
    if (baseX !== 0 || baseY !== 0) {
      local[4] -= local[0] * baseX + local[2] * baseY
      local[5] -= local[1] * baseX + local[3] * baseY
    }
    return local
  }

  const cols = finite(entity.columnCount) ? Math.max(1, Math.floor(entity.columnCount)) : 1
  const rows = finite(entity.rowCount) ? Math.max(1, Math.floor(entity.rowCount)) : 1
  const colSpacing = finite(entity.columnSpacing) ? entity.columnSpacing : 0
  const rowSpacing = finite(entity.rowSpacing) ? entity.rowSpacing : 0
  const rotation = finite(entity.rotation) ? entity.rotation : 0

  stack.push(key)
  const results = []
  try {
    if (cols === 1 && rows === 1) {
      const local = localInsert(entity)
      const total = isIdentityMatrix(local) ? null : local
      for (let i = 0; i < block.entities.length; i++) {
        results.push(walk(block.entities[i], ctx, total, depth + 1, stack))
      }
    } else {
      const rad = rotation * DEG
      const cos = Math.cos(rad)
      const sin = Math.sin(rad)
      const base = entity.position || { x: 0, y: 0 }
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const ox = c * colSpacing
          const oy = r * rowSpacing
          const insert = {
            position: {
              x: (finite(base.x) ? base.x : 0) + ox * cos - oy * sin,
              y: (finite(base.y) ? base.y : 0) + ox * sin + oy * cos,
            },
            xScale: entity.xScale,
            yScale: entity.yScale,
            rotation,
          }
          const local = localInsert(insert)
          const total = isIdentityMatrix(local) ? null : local
          for (let i = 0; i < block.entities.length; i++) {
            results.push(walk(block.entities[i], ctx, total, depth + 1, stack))
          }
        }
      }
    }
  } finally {
    stack.pop()
  }
  return mergeChildResults(results)
}

function emitDimension(entity, ctx, m, depth, stack) {
  const name = entity.block || entity.name
  const block = name ? getBlock(ctx, name) : null
  if (!block || !Array.isArray(block.entities)) {
    warn(ctx, 'dimension:no-block')
    return emptyResult('dimension:no-block')
  }

  const maxDepth = Number.isInteger(ctx.maxDepth) ? ctx.maxDepth : 8
  if (depth >= maxDepth) {
    warn(ctx, 'insert:max-depth:' + String(name).toUpperCase())
    return emptyResult('max-depth')
  }

  const key = 'DIM:' + String(name).toUpperCase()
  if (stack.indexOf(key) >= 0) {
    warn(ctx, 'insert:cycle:' + String(name).toUpperCase())
    return emptyResult('cycle')
  }

  stack.push(key)
  const results = []
  try {
    for (let i = 0; i < block.entities.length; i++) {
      results.push(walk(block.entities[i], ctx, m, depth + 1, stack))
    }
  } finally {
    stack.pop()
  }
  return mergeChildResults(results)
}

function dispatch(entity, type, ctx, m, depth, stack) {
  switch (type) {
    case 'LINE':
      return emitLine(entity, ctx, m)
    case 'ARC':
      return emitArc(entity, ctx, m)
    case 'CIRCLE':
      return emitCircle(entity, ctx, m)
    case 'POINT':
      return emitPoint(entity, ctx, m)
    case 'SOLID':
      return emitSolid(entity, ctx, m)
    case '3DFACE':
      return emit3dFace(entity, ctx, m)
    case 'LWPOLYLINE':
    case 'POLYLINE':
      return emitPolyline(entity, type, ctx, m)
    case 'ELLIPSE':
      return emitEllipsePrimitive(entity, ctx, m)
    case 'SPLINE':
      return emitSpline(entity, ctx, m)
    case 'TEXT':
    case 'MTEXT':
      return emitText(entity, type, ctx, m)
    case 'INSERT':
      return emitInsert(entity, ctx, m, depth, stack)
    case 'DIMENSION':
      return emitDimension(entity, ctx, m, depth, stack)
    case 'HATCH':
      return emitHatch(entity, ctx, m)
    default:
      warn(ctx, 'unsupported:' + (type || 'UNKNOWN'))
      return emptyResult('unsupported')
  }
}

function walk(entity, ctx, m, depth, stack) {
  if (!entity || typeof entity !== 'object') {
    warn(ctx, 'entity:unknown')
    return emptyResult('error')
  }
  const type = entity.type ? String(entity.type).toUpperCase() : ''
  try {
    return dispatch(entity, type, ctx, m, depth, stack)
  } catch (err) {
    // One broken entity must never kill the drawing.
    warn(ctx, 'entity:' + (type || 'UNKNOWN'))
    return emptyResult('error')
  }
}

/**
 * Convert one dxf-parser entity into WCS primitives.
 *
 * ctx = { blocks, arcStepDeg?, maxDepth?, warnings: Set<string>,
 *         includeHatch?, angleUnits?: 'deg' | 'rad' | 'auto' }
 *
 * Returns `{ primitives, bbox }` (plus an optional `notCompared` reason).
 * Never throws.
 */
export function entityToPrimitives(entity, ctx, parentMatrix) {
  const context = ctx || EMPTY_CTX
  const m = parentMatrix && !isIdentityMatrix(parentMatrix) ? parentMatrix : null
  return walk(entity, context, m, 0, [])
}
