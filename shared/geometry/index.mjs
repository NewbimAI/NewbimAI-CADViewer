/**
 * shared/geometry/index.mjs — pure 2D geometry kernel for CAD comparison.
 *
 * The public API below is FROZEN by docs/compare-contract.md §2.  Every
 * documented name and return shape is implemented here; sibling modules are
 * implementation details and are not part of the contract.
 *
 * Coordinate conventions
 * ----------------------
 * - All kernel output is drawing WCS (block INSERT transforms composed and
 *   OCS extrusion applied).
 * - Matrices are canvas-style [a, b, c, d, e, f]:
 *     x' = a*x + c*y + e,  y' = b*x + d*y + f
 * - Arcs/circles are always flattened to polylines.
 *
 * Entity input
 * ------------
 * Entities are dxf-parser v1.1.x objects.  LINE is accepted both in the
 * documented `{ start, end }` form and in dxf-parser's actual
 * `{ vertices: [start, end] }` form.  INSERT honours the block base point.
 *
 * Angle units: dxf-parser converts ARC group 50/51 (DXF degrees) to RADIANS
 * and sets `angleLength`; the kernel auto-detects that.  Synthetic entities
 * without `angleLength` are interpreted as DXF degrees (contract wording).
 * `ctx.angleUnits = "deg" | "rad"` overrides detection.
 *
 * Warning codes collected in ctx.warnings (Set<string>)
 * -----------------------------------------------------
 *   entity:<TYPE>, unsupported:<TYPE>, not-compared:hatch,
 *   dimension:no-block, insert:missing-block:<NAME>, insert:max-depth:<NAME>,
 *   insert:cycle:<NAME>, spline:approximated, arc:non-uniform-scale,
 *   hatch:path
 *
 * Known limitations (documented, not silently wrong)
 * --------------------------------------------------
 * - Text bboxes are the insertion point only (no font metrics).
 * - ELLIPSE normal/extrusion is not exposed by dxf-parser; ellipse centre is
 *   treated as WCS (per DXF spec).
 * - SPLINE rational weights are not present in dxf-parser output; only the
 *   polynomial B-spline (de Boor) is evaluated.
 * - HATCH support covers the boundary layouts parsers commonly expose
 *   (`boundaryPaths`/`paths` with `vertices` or `edges`); other layouts yield
 *   the `unsupported:HATCH` warning.  dxf-parser itself does not parse HATCH.
 * - MTEXT `\S` stacking is flattened to its content with `^` -> `/`.
 */

export {
  DEFAULT_ARC_STEP_DEG,
  bulgeToArc,
  arcToPoints,
  polylineLength,
  polygonArea,
  polylineAreaWithBulges,
  angleBetween,
  radiusFrom3Points,
  bboxOfPoints,
  bboxUnion,
  bboxesIntersect,
  bboxDistanceSq,
} from './math.mjs'

export {
  identityMatrix,
  composeMatrix,
  applyMatrix,
  matrixScale,
} from './matrix.mjs'

export { entityToPrimitives } from './entity.mjs'

export { entityFingerprint, entityPropertyKey } from './fingerprint.mjs'
