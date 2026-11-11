/**
 * shared/geometry/matrix.mjs
 *
 * 2D affine matrices in canvas `setTransform` order: [a, b, c, d, e, f]
 *
 *   x' = a*x + c*y + e
 *   y' = b*x + d*y + f
 *
 * `composeMatrix(parent, insert)` composes `parent * insert`, i.e. the insert
 * transform is applied first, then the parent.
 */

const DEG = Math.PI / 180

function finite(v) {
  return typeof v === 'number' && Number.isFinite(v)
}

/** Identity matrix (new array each call). */
export function identityMatrix() {
  return [1, 0, 0, 1, 0, 0]
}

/** True when `m` is exactly the identity (cheap, called once per entity). */
export function isIdentityMatrix(m) {
  return (
    Array.isArray(m) &&
    m[0] === 1 && m[1] === 0 && m[2] === 0 &&
    m[3] === 1 && m[4] === 0 && m[5] === 0
  )
}

/** Apply a matrix to a point. */
export function applyMatrix(m, x, y) {
  if (!Array.isArray(m)) return { x, y }
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] }
}

/**
 * Matrix product `a * b` (apply b first, then a).
 * Internal helper, also used by the entity kernel for the OCS chain.
 */
export function _mulMatrix(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ]
}

/**
 * Compose the block transform of a dxf-parser INSERT entity with `parent`.
 *
 * Local transform (applied to block coordinates, in this order):
 *   scale -> rotate (degrees, CCW) -> translate to `position`.
 * Result: `parent * T * R * S`.
 */
export function composeMatrix(parent, insert) {
  const p = Array.isArray(parent) ? parent : identityMatrix()
  const ins = insert || {}

  const pos = ins.position || {}
  const px = finite(pos.x) ? pos.x : 0
  const py = finite(pos.y) ? pos.y : 0
  const sx = finite(ins.xScale) ? ins.xScale : 1
  const sy = finite(ins.yScale) ? ins.yScale : 1
  const rot = (finite(ins.rotation) ? ins.rotation : 0) * DEG

  const cos = Math.cos(rot)
  const sin = Math.sin(rot)

  // local = T * R * S
  const la = cos * sx
  const lb = sin * sx
  const lc = -sin * sy
  const ld = cos * sy

  return [
    p[0] * la + p[2] * lb,
    p[1] * la + p[3] * lb,
    p[0] * lc + p[2] * ld,
    p[1] * lc + p[3] * ld,
    p[0] * px + p[2] * py + p[4],
    p[1] * px + p[3] * py + p[5],
  ]
}

/**
 * Per-axis scale magnitudes of a matrix (always >= 0).
 * Used to detect non-uniform block scaling: arcs become ellipses and the
 * flattened representation is still correct, but callers should warn.
 */
export function matrixScale(m) {
  if (!Array.isArray(m)) return { sx: 1, sy: 1 }
  return {
    sx: Math.hypot(m[0], m[1]),
    sy: Math.hypot(m[2], m[3]),
  }
}

/**
 * Arbitrary Axis Algorithm (AutoCAD OCS).
 *
 * Given the extrusion direction (210/220/230) and an elevation along it,
 * build a 2D affine matrix that maps OCS (x, y) to WCS XY:
 *
 *   if |Nx| < 1/64 && |Ny| < 1/64:  Ax = Wy × N
 *   else:                            Ax = Wz × N
 *   Ax = normalize(Ax);  Ay = N × Ax
 *   WCS = x*Ax + y*Ay + elevation*N
 *
 * Returns null for the default normal (0, 0, 1) / missing normal, i.e. the
 * overwhelmingly common case, so hot paths pay almost nothing.
 *
 * NOTE: the projection of the OCS plane onto XY is not necessarily a
 * similarity transform (it can shear).  The kernel always flattens curves in
 * OCS space before applying this matrix, which keeps circles correct
 * (they become ellipses) under tilted extrusion.
 */
export function _ocsMatrix(nx, ny, nz, elevation) {
  if (!finite(nx) || !finite(ny) || !finite(nz)) return null

  const len = Math.hypot(nx, ny, nz)
  if (!(len > 0) || !finite(len)) return null

  const nX = nx / len
  const nY = ny / len
  const nZ = nz / len

  // Default normal: no OCS transform at all.
  if (Math.abs(nX) < 1e-14 && Math.abs(nY) < 1e-14 && nZ > 0) return null

  let axX
  let axY
  let axZ
  if (Math.abs(nX) < 1 / 64 && Math.abs(nY) < 1 / 64) {
    // Ax = (0,1,0) × N
    axX = nZ
    axY = 0
    axZ = -nX
  } else {
    // Ax = (0,0,1) × N
    axX = -nY
    axY = nX
    axZ = 0
  }

  const axLen = Math.hypot(axX, axY, axZ)
  if (!(axLen > 0) || !finite(axLen)) return null
  axX /= axLen
  axY /= axLen
  axZ /= axLen

  // Ay = N × Ax
  const ayX = nY * axZ - nZ * axY
  const ayY = nZ * axX - nX * axZ
  const ayZ = nX * axY - nY * axX

  const el = finite(elevation) ? elevation : 0

  // Only the XY components matter for the 2D comparison kernel.
  return [
    axX, axY,
    ayX, ayY,
    el * nX, el * nY,
  ]
}
