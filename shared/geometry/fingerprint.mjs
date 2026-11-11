/**
 * shared/geometry/fingerprint.mjs
 *
 * Canonical, presentation-independent entity fingerprints for the diff engine.
 * A fingerprint depends ONLY on the DXF type and geometry/text content.
 * Handles, layers, colours, linetypes, lineweights, transparency and thickness
 * are deliberately excluded — those live in `entityPropertyKey`.
 *
 * ============================ STRING FORMAT ============================
 * Grammar (all fields separated by "|", coordinates separated by ","):
 *
 *   FINGERPRINT := TYPE "|" FIELD ("|" FIELD)*
 *   FIELD       := KEY "=" VALUE | VALUE
 *
 * Numbers are quantised to the grid `q = options.quantize` (default 1e-6)
 * and stored as base-10 integers: n = round(value / q), "-0" normalised to 0.
 * Non-finite numbers become "~".  Text is stored as `T=<JSON string>` so
 * arbitrary characters cannot break the field separation.
 *
 * Per-type fields (this is part of the contract with server/compare.js):
 *   LINE       : x1,y1 | x2,y2                 (endpoints sorted lexicographically)
 *   ARC        : cx,cy | r | startRad | endRad | [N=nx,ny,nz]
 *   CIRCLE     : cx,cy | r | [N=...]
 *   POINT      : x,y | [N=nx,ny,nz]
 *   SOLID      : x,y | ...                     (points sorted, duplicates removed) | [N=...]
 *   3DFACE     : x,y | ...                     (points sorted, duplicates removed)
 *   LWPOLYLINE : C=0|1 | x,y,bulge ; ...       (bulge 0 when absent) | [E=elevation] | [N=...]
 *   POLYLINE   : C=0|1 | D3=0|1 | x,y,bulge; ... | [N=...]
 *   ELLIPSE    : cx,cy | mx,my | ratio | startRad | endRad
 *   SPLINE     : D=degree | C=0|1 | cp x,y; ... | K=knot; ...
 *   TEXT       : x,y | height | rotationDeg | T="..." | [N=...]
 *   MTEXT      : x,y | height | rotationDeg | T="..."
 *   INSERT     : NAME | x,y | sx | sy | rotationDeg | grid=cols,rows,colSpacing,rowSpacing | [N=...]
 *   DIMENSION  : BLOCK | x,y | measurement | T="..."
 *   HATCH      : path coordinates when the parser exposes them, else path count
 *   <other>    : TYPE|unsupported
 *
 * `N=` (OCS extrusion direction) appears only for entities whose DXF definition
 * is OCS based, and only when the normal differs from (0, 0, 1).
 *
 * Canonicalisation rules the diff engine may rely on:
 *   - LINE / SOLID / 3DFACE: point order does not matter.
 *   - LWPOLYLINE / POLYLINE: for a closed polyline the vertex list is rotated
 *     to the lexicographically smallest vertex, so "which vertex starts" does
 *     not matter.  Reversed vertex order (with bulges negated) is also
 *     canonicalised away for both closed and open polylines.
 *   - TEXT/MTEXT: MTEXT formatting codes are stripped and whitespace is
 *     collapsed, so font/size tags do not affect the fingerprint.
 * =======================================================================
 */

import { pointX, pointY } from './math.mjs'
import {
  _arcRadians,
  _ellipseRadians,
  _normalOf,
  _collectVertices,
  _textRotation,
  normalizeText,
} from './entity.mjs'

const DEFAULT_QUANTIZE = 1e-6

function finite(v) {
  return typeof v === 'number' && Number.isFinite(v)
}

function quantizeOf(options) {
  const q = options && finite(options.quantize) && options.quantize > 0
    ? options.quantize
    : DEFAULT_QUANTIZE
  return 1 / q
}

/** Quantised integer or null. */
function qi(v, invQ) {
  if (!finite(v)) return null
  const n = Math.round(v * invQ)
  if (!Number.isFinite(n)) return null
  return n === 0 ? 0 : n
}

function ns(n) {
  return n === null ? '~' : String(n)
}

function pointToken(p, invQ) {
  const x = p ? pointX(p) : NaN
  const y = p ? pointY(p) : NaN
  return ns(qi(x, invQ)) + ',' + ns(qi(y, invQ))
}

function compareNullable(a, b) {
  const av = a === null ? -Infinity : a
  const bv = b === null ? -Infinity : b
  if (av < bv) return -1
  if (av > bv) return 1
  return 0
}

function compareTriple(a, b) {
  let c = compareNullable(a[0], b[0])
  if (c) return c
  c = compareNullable(a[1], b[1])
  if (c) return c
  return compareNullable(a[2], b[2])
}

function compareSeq(a, b) {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const c = compareTriple(a[i], b[i])
    if (c) return c
  }
  return a.length - b.length
}

function rotateSeq(seq, k) {
  const n = seq.length
  if (k === 0) return seq
  const out = new Array(n)
  for (let i = 0; i < n; i++) out[i] = seq[(i + k) % n]
  return out
}

function bestRotation(seq) {
  const n = seq.length
  if (n <= 1) return seq
  let best = 0
  for (let i = 1; i < n; i++) {
    if (compareTriple(seq[i], seq[best]) < 0) best = i
  }
  let bestSeq = rotateSeq(seq, best)
  for (let i = 0; i < n; i++) {
    if (i === best) continue
    if (compareTriple(seq[i], seq[best]) !== 0) continue
    const cand = rotateSeq(seq, i)
    if (compareSeq(cand, bestSeq) < 0) bestSeq = cand
  }
  return bestSeq
}

/**
 * Reversed traversal of a vertex sequence.
 * For a closed ring the outgoing bulge of a reversed vertex is the negated
 * bulge of the previous edge; for an open chain the last vertex gets bulge 0.
 */
function reverseSeq(seq, closed) {
  const n = seq.length
  const out = new Array(n)
  if (n === 0) return out
  if (closed) {
    // out[0] = v0 with bulge -b[n-1]; out[k>=1] = v[n-k] with bulge -b[n-k-1]
    out[0] = [seq[0][0], seq[0][1], seq[n - 1][2] === null ? null : -seq[n - 1][2]]
    for (let k = 1; k < n; k++) {
      const j = n - k
      const prev = seq[j - 1]
      out[k] = [seq[j][0], seq[j][1], prev[2] === null ? null : -prev[2]]
    }
  } else {
    for (let k = 0; k < n; k++) {
      const j = n - 1 - k
      const bulge = k === n - 1 ? 0 : seq[n - 2 - k][2]
      out[k] = [seq[j][0], seq[j][1], bulge === null ? null : -bulge]
    }
  }
  return out
}

/** Canonical vertex sequence (closed: rotation invariant, both: reversal invariant). */
function canonicalSeq(seq, closed) {
  if (seq.length <= 1) return seq
  const forward = closed ? bestRotation(seq) : seq
  const backward = closed ? bestRotation(reverseSeq(seq, closed)) : reverseSeq(seq, closed)
  return compareSeq(forward, backward) <= 0 ? forward : backward
}

function verticesToken(vertices, closed, invQ) {
  const seq = []
  for (let i = 0; i < vertices.length; i++) {
    const v = vertices[i]
    if (!v) continue
    seq.push([qi(pointX(v), invQ), qi(pointY(v), invQ), qi(finite(v.bulge) ? v.bulge : 0, invQ)])
  }
  const canon = canonicalSeq(seq, closed)
  let out = 'C=' + (closed ? '1' : '0') + '|'
  for (let i = 0; i < canon.length; i++) {
    if (i) out += ';'
    out += ns(canon[i][0]) + ',' + ns(canon[i][1]) + ',' + ns(canon[i][2])
  }
  return out
}

function sortedPointsToken(points, invQ) {
  const tokens = []
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    if (!p) continue
    const x = pointX(p)
    const y = pointY(p)
    if (!finite(x) || !finite(y)) continue
    tokens.push([qi(x, invQ), qi(y, invQ)])
  }
  tokens.sort((a, b) => compareNullable(a[0], b[0]) || compareNullable(a[1], b[1]))
  let out = ''
  for (let i = 0; i < tokens.length; i++) {
    if (out) out += '|'
    out += ns(tokens[i][0]) + ',' + ns(tokens[i][1])
  }
  return out
}

function normalToken(entity, invQ) {
  const n = _normalOf(entity)
  if (!n) return ''
  const nx = qi(n.x, invQ)
  const ny = qi(n.y, invQ)
  const nz = qi(n.z, invQ)
  if (nx === 0 && ny === 0 && nz === qi(1, invQ)) return '' // default (0,0,1) on the grid
  return '|N=' + ns(nx) + ',' + ns(ny) + ',' + ns(nz)
}

function numberToken(v, invQ) {
  return ns(qi(v, invQ))
}

/* ------------------------------------------------------------------ */
/* per-type canonicalisation                                           */
/* ------------------------------------------------------------------ */

function fingerprintOf(entity, type, ctx, invQ) {
  switch (type) {
    case 'LINE': {
      // Accept both the documented {start,end} and dxf-parser's
      // {vertices:[start,end]}.  Endpoint order is irrelevant: sort
      // lexicographically by (x, y).
      const verts = Array.isArray(entity.vertices) ? entity.vertices : []
      const p1 = entity.start || verts[0]
      const p2 = entity.end || verts[1]
      const a = [
        qi(p1 ? pointX(p1) : NaN, invQ),
        qi(p1 ? pointY(p1) : NaN, invQ),
      ]
      const b = [
        qi(p2 ? pointX(p2) : NaN, invQ),
        qi(p2 ? pointY(p2) : NaN, invQ),
      ]
      const first = compareTriple([a[0], a[1], null], [b[0], b[1], null]) <= 0 ? a : b
      const second = first === a ? b : a
      return 'LINE|' + ns(first[0]) + ',' + ns(first[1]) +
        '|' + ns(second[0]) + ',' + ns(second[1])
    }

    case 'ARC': {
      const c = entity.center || {}
      const ang = _arcRadians(entity, ctx)
      return (
        'ARC|' + pointToken(c, invQ) +
        '|' + numberToken(entity.radius, invQ) +
        '|' + numberToken(ang.start, invQ) +
        '|' + numberToken(ang.end, invQ) +
        normalToken(entity, invQ)
      )
    }

    case 'CIRCLE': {
      const c = entity.center || {}
      return (
        'CIRCLE|' + pointToken(c, invQ) +
        '|' + numberToken(entity.radius, invQ) +
        normalToken(entity, invQ)
      )
    }

    case 'POINT': {
      const p = entity.position || entity.point || {}
      return 'POINT|' + pointToken(p, invQ) + normalToken(entity, invQ)
    }

    case 'SOLID':
      return 'SOLID|' + sortedPointsToken(Array.isArray(entity.points) ? entity.points : [], invQ) +
        normalToken(entity, invQ)

    case '3DFACE':
      return '3DFACE|' + sortedPointsToken(
        Array.isArray(entity.vertices) ? entity.vertices : [], invQ)

    case 'LWPOLYLINE':
    case 'POLYLINE': {
      const closed = entity.shape === true || entity.closed === true
      const verts = _collectVertices(entity)
      const d3 = type === 'POLYLINE' && entity.is3dPolyline ? 'D3=1|' : ''
      const elevation = type === 'LWPOLYLINE' && finite(entity.elevation)
        ? '|E=' + numberToken(entity.elevation, invQ)
        : ''
      const normal = type === 'POLYLINE' && entity.is3dPolyline
        ? ''
        : normalToken(entity, invQ)
      return type + '|' + d3 + verticesToken(verts, closed, invQ) + elevation + normal
    }

    case 'ELLIPSE': {
      const ang = _ellipseRadians(entity, ctx)
      const c = entity.center || {}
      const m = entity.majorAxisEndPoint || {}
      return (
        'ELLIPSE|' + pointToken(c, invQ) +
        '|' + pointToken(m, invQ) +
        '|' + numberToken(finite(entity.axisRatio) ? entity.axisRatio : 1, invQ) +
        '|' + numberToken(ang.start, invQ) +
        '|' + numberToken(ang.end, invQ)
      )
    }

    case 'SPLINE': {
      const deg = finite(entity.degreeOfSplineCurve)
        ? entity.degreeOfSplineCurve
        : finite(entity.degree) ? entity.degree : -1
      const cps = Array.isArray(entity.controlPoints) ? entity.controlPoints : []
      const knots = Array.isArray(entity.knotValues)
        ? entity.knotValues
        : Array.isArray(entity.knots) ? entity.knots : []
      let s = 'SPLINE|D=' + (deg === -1 ? '~' : String(deg)) +
        '|C=' + (entity.closed ? '1' : '0') + '|cp='
      for (let i = 0; i < cps.length; i++) {
        if (i) s += ';'
        s += pointToken(cps[i], invQ)
      }
      s += '|K='
      for (let i = 0; i < knots.length; i++) {
        if (i) s += ';'
        s += numberToken(knots[i], invQ)
      }
      return s
    }

    case 'TEXT':
    case 'MTEXT': {
      const isM = type === 'MTEXT'
      const p = isM ? entity.position : entity.startPoint
      const height = isM ? entity.height : entity.textHeight
      const text = normalizeText(entity.text)
      return (
        type + '|' + pointToken(p, invQ) +
        '|' + numberToken(height, invQ) +
        '|' + numberToken(_textRotation(entity, type), invQ) +
        '|T=' + JSON.stringify(text) +
        (isM ? '' : normalToken(entity, invQ))
      )
    }

    case 'INSERT': {
      const p = entity.position || {}
      const cols = finite(entity.columnCount) ? entity.columnCount : 1
      const rows = finite(entity.rowCount) ? entity.rowCount : 1
      const cs = finite(entity.columnSpacing) ? entity.columnSpacing : 0
      const rs = finite(entity.rowSpacing) ? entity.rowSpacing : 0
      return (
        'INSERT|' + String(entity.name || '').toUpperCase() +
        '|' + pointToken(p, invQ) +
        '|' + numberToken(finite(entity.xScale) ? entity.xScale : 1, invQ) +
        '|' + numberToken(finite(entity.yScale) ? entity.yScale : 1, invQ) +
        '|' + numberToken(finite(entity.rotation) ? entity.rotation : 0, invQ) +
        '|grid=' + [cols, rows, cs, rs].map((v) => numberToken(v, invQ)).join(',') +
        normalToken(entity, invQ)
      )
    }

    case 'DIMENSION': {
      const p = entity.anchorPoint || entity.middleOfText || {}
      return (
        'DIMENSION|' + String(entity.block || entity.name || '').toUpperCase() +
        '|' + pointToken(p, invQ) +
        '|' + numberToken(entity.actualMeasurement, invQ) +
        '|T=' + JSON.stringify(normalizeText(entity.text))
      )
    }

    case 'HATCH': {
      const paths = Array.isArray(entity.boundaryPaths)
        ? entity.boundaryPaths
        : Array.isArray(entity.paths) ? entity.paths : []
      let s = 'HATCH|' + paths.length
      for (let i = 0; i < paths.length; i++) {
        const path = paths[i]
        s += '|'
        if (path && Array.isArray(path.vertices)) {
          for (let j = 0; j < path.vertices.length; j++) {
            if (j) s += ';'
            const v = path.vertices[j]
            s += pointToken(v, invQ) + ',' + numberToken(finite(v && v.bulge) ? v.bulge : 0, invQ)
          }
        } else if (path && Array.isArray(path.edges)) {
          for (let j = 0; j < path.edges.length; j++) {
            const e = path.edges[j]
            if (j) s += ';'
            s += e && e.type !== undefined ? String(e.type) : '?'
          }
        } else {
          s += 'path'
        }
      }
      return s
    }

    default:
      // Unknown / unsupported entities are not compared; keep the string
      // stable and documented rather than guessing at geometry.
      return type + '|unsupported'
  }
}

/* ------------------------------------------------------------------ */
/* public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Canonical geometry fingerprint (string).  See the module header for the
 * exact format.  `ctx` is only used for `ctx.angleUnits`; `options.quantize`
 * defaults to 1e-6.
 */
export function entityFingerprint(entity, ctx, options) {
  // Tolerate entityFingerprint(entity, { quantize }) — handy in tests.
  let context = ctx
  let opts = options
  if (
    ctx &&
    !ctx.blocks &&
    !ctx.warnings &&
    options === undefined &&
    (ctx.quantize !== undefined || ctx.compareProps !== undefined)
  ) {
    context = null
    opts = ctx
  }

  const invQ = quantizeOf(opts)
  if (!entity || typeof entity !== 'object') return '~|invalid'
  const type = entity.type ? String(entity.type).toUpperCase() : '~|invalid'
  return fingerprintOf(entity, type, context, invQ)
}

const DEFAULT_COMPARE_PROPS = [
  'color',
  'layer',
  'linetype',
  'lineweight',
  'transparency',
  'thickness',
]

/** First defined value (undefined/null are skipped). */
function pick(...values) {
  for (let i = 0; i < values.length; i++) {
    if (values[i] !== undefined && values[i] !== null) return values[i]
  }
  return undefined
}

function propToken(key, value) {
  return key + '=' + (value === undefined || value === null ? '-' : String(value))
}

/**
 * Presentation / non-geometric property key.
 *
 * Only the properties listed in `options.compareProps` participate; when the
 * list is omitted all of color/layer/linetype/lineweight/transparency/thickness
 * are used.  The layer name is included only when "layer" is enabled.
 *
 * Format: `color=256|layer=WALLS|linetype=CONTINUOUS|lineweight=-3|...`
 */
export function entityPropertyKey(entity, options) {
  if (!entity || typeof entity !== 'object') return ''
  const list = Array.isArray(options && options.compareProps)
    ? options.compareProps
    : DEFAULT_COMPARE_PROPS

  const parts = []
  for (let i = 0; i < list.length; i++) {
    const name = String(list[i]).toLowerCase()
    switch (name) {
      case 'color':
        parts.push(propToken('color', pick(entity.colorIndex, entity.color)))
        break
      case 'layer':
        parts.push(propToken('layer', typeof entity.layer === 'string' ? entity.layer : '0'))
        break
      case 'linetype':
        parts.push(propToken('linetype', pick(entity.lineType, entity.linetype)))
        break
      case 'lineweight':
        parts.push(propToken('lineweight', entity.lineweight))
        break
      case 'transparency':
        parts.push(propToken('transparency', pick(entity.transparency, entity.transparencyValue)))
        break
      case 'thickness':
        parts.push(propToken('thickness', entity.thickness))
        break
      default:
        // Unknown compare property: ignore rather than emit unstable output.
        break
    }
  }
  return parts.join('|')
}
