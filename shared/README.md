# `shared/geometry` — pure geometry kernel

Dependency-free 2D geometry kernel shared by `server/compare.js` and the web
overlay.  The public API is **frozen** by
[`docs/compare-contract.md`](../docs/compare-contract.md) §2.

```js
import {
  entityToPrimitives, entityFingerprint, entityPropertyKey,
  bulgeToArc, arcToPoints, polygonArea, polylineAreaWithBulges,
} from '../shared/geometry/index.mjs'
```

Run the tests (Node 20, no dependencies):

```sh
node --test shared/geometry/geometry.test.mjs
```

## Modules

| file             | contents                                                        |
| ---------------- | --------------------------------------------------------------- |
| `index.mjs`      | public re-exports only (the frozen API)                          |
| `math.mjs`       | bulge/arc maths, lengths/areas, angles, bboxes                   |
| `matrix.mjs`     | canvas-style 2D affines, INSERT composition, OCS axes algorithm  |
| `entity.mjs`     | dxf-parser entity → WCS primitives                               |
| `fingerprint.mjs`| canonical geometry fingerprint + presentation property key       |

`math.mjs`, `matrix.mjs`, `entity.mjs` and `fingerprint.mjs` are internal;
only the names re-exported from `index.mjs` are contractual.

## Coordinates

* Output is drawing **WCS**: OCS extrusion (arbitrary axis algorithm) is applied
  first, then the INSERT chain (`parent * T * R * S * T(-basePoint)`).
* Matrices are canvas-style `[a, b, c, d, e, f]`:
  `x' = a*x + c*y + e`, `y' = b*x + d*y + f`.
* Arcs and circles are always tessellated to polylines (`DEFAULT_ARC_STEP_DEG`
  = 6°, overridable with `ctx.arcStepDeg`).  Curve points are always generated
  in local/OCS space and transformed afterwards, so circles under non-uniform
  scale or tilted extrusion correctly become ellipses.

## Entity support (`entityToPrimitives`)

LINE (both contract `start`/`end` and dxf-parser `vertices`), ARC, CIRCLE,
LWPOLYLINE, POLYLINE, ELLIPSE, SPLINE (de Boor, fallback to control points),
INSERT (nested, depth `ctx.maxDepth ?? 8`, cycle-safe, block base point,
MINSERT grids), POINT, SOLID, 3DFACE, TEXT, MTEXT, DIMENSION (anonymous block),
HATCH (only with `ctx.includeHatch`).  Anything else returns no primitives and
an `unsupported:<TYPE>` warning.

`ctx = { blocks, warnings: Set<string>, arcStepDeg?, maxDepth?, includeHatch?, angleUnits? }`.

### Angle units

dxf-parser v1.1.x converts ARC group 50/51 to **radians** and sets
`angleLength`.  The kernel auto-detects that; synthetic entities without
`angleLength` are interpreted as DXF **degrees** (matching the contract text).
Set `ctx.angleUnits = "deg" | "rad"` to force one interpretation.  ELLIPSE
parametric angles default to radians (DXF spec / dxf-parser).

### Warnings (`ctx.warnings` is a `Set<string>`)

`entity:<TYPE>`, `unsupported:<TYPE>`, `not-compared:hatch`,
`dimension:no-block`, `insert:missing-block:<NAME>`, `insert:max-depth:<NAME>`,
`insert:cycle:<NAME>`, `spline:approximated`, `arc:non-uniform-scale`,
`hatch:path`.

`notCompared` is returned as an extra field (the contract return object is
`{ primitives, bbox }`; extra fields are additive).

## Fingerprint format

`entityFingerprint(entity, ctx, options)` returns a stable string:
`TYPE|field|field...`.  All numbers are quantised with
`q = options.quantize` (default `1e-6`) and encoded as integers
`round(value / q)` ("~" for non-finite).  The exact per-type grammar is
documented at the top of `fingerprint.mjs`; the diff engine may rely on:

* LINE / SOLID / 3DFACE point order is irrelevant.
* Closed LWPOLYLINE / POLYLINE are rotation-invariant (start vertex is
  canonicalised) and direction-invariant (reversed traversal with negated
  bulges produces the same string).
* Bulges, closed flags, text content (MTEXT codes stripped, whitespace
  collapsed), height, rotation and OCS normals participate.
* Handle, layer, colour, linetype, lineweight, transparency and thickness do
  not participate — they are handled by `entityPropertyKey`, which only emits
  the properties enabled in `options.compareProps` (default: all).

## Known limitations

* Text bboxes are the insertion point only (no font metrics).
* SPLINE rational weights are not available in dxf-parser output; only the
  polynomial B-spline is evaluated.
* HATCH parsing is limited to `boundaryPaths`/`paths` with `vertices` or
  `edges`; dxf-parser itself does not parse HATCH.
* ELLIPSE extrusion is not exposed by dxf-parser; ellipse coordinates are
  treated as WCS.
* The kernel is 2D: Z is only used for OCS elevation, never for comparison.
* MTEXT `\S` stacking is flattened to its content (`^` → `/`).
