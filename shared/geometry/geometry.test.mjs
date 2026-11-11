/**
 * shared/geometry/geometry.test.mjs
 *
 * Run from the repo root:
 *   node --test shared/geometry/geometry.test.mjs
 *
 * Node 20, no external dependencies.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import * as g from './index.mjs'

const PI = Math.PI
const TAU = Math.PI * 2

function close(actual, expected, tol = 1e-9, msg) {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    msg || `expected ${actual} to be within ${tol} of ${expected}`,
  )
}

function finitePoints(points) {
  for (const p of points) {
    assert.ok(Array.isArray(p), 'point must be an array')
    assert.equal(p.length, 2)
    assert.ok(Number.isFinite(p[0]) && Number.isFinite(p[1]), `non-finite point ${p}`)
  }
}

function ctx(extra = {}) {
  return { blocks: {}, maxDepth: 8, warnings: new Set(), ...extra }
}

/* ------------------------------------------------------------------ */
/* API surface                                                         */
/* ------------------------------------------------------------------ */

test('exports exactly the frozen contract API', () => {
  const expected = [
    'DEFAULT_ARC_STEP_DEG',
    'angleBetween', 'applyMatrix', 'arcToPoints',
    'bboxDistanceSq', 'bboxOfPoints', 'bboxUnion', 'bboxesIntersect',
    'bulgeToArc', 'composeMatrix', 'entityFingerprint', 'entityPropertyKey',
    'entityToPrimitives', 'identityMatrix', 'matrixScale', 'polygonArea',
    'polylineAreaWithBulges', 'polylineLength', 'radiusFrom3Points',
  ].sort()
  assert.deepEqual(Object.keys(g).sort(), expected)
  assert.equal(g.DEFAULT_ARC_STEP_DEG, 6)
})

/* ------------------------------------------------------------------ */
/* bulge maths                                                         */
/* ------------------------------------------------------------------ */

test('half-circle bulge b=1: radius, length, sagitta', () => {
  const arc = g.bulgeToArc({ x: 0, y: 0 }, { x: 1, y: 0 }, 1)
  assert.ok(arc)
  close(arc.r, 0.5)
  close(arc.ccw, true)
  close(Math.abs(arc.theta), PI)
  close(arc.length, (PI * 1) / 2)
  close(arc.sagitta, 0.5)
  close(arc.cx, 0.5)
  close(arc.cy, 0)
})

test('half-circle bulge: circular segment area = pi*c^2/8', () => {
  const area = g.polylineAreaWithBulges([
    { x: 0, y: 0, bulge: 1 },
    { x: 1, y: 0 },
  ])
  close(area, (PI * 1) / 8)
})

test('negative bulge (clockwise) mirrors the arc', () => {
  const arc = g.bulgeToArc({ x: 0, y: 0 }, { x: 1, y: 0 }, -1)
  assert.ok(arc)
  assert.equal(arc.ccw, false)
  close(arc.length, PI / 2)

  // Mid-arc: +b bows down (-y), -b bows up (+y).
  const midAngle = arc.start - Math.abs(arc.theta) / 2
  const midY = arc.cy + arc.r * Math.sin(midAngle)
  close(midY, 0.5)

  const positive = g.bulgeToArc({ x: 0, y: 0 }, { x: 1, y: 0 }, 1)
  const midAngle2 = positive.start + positive.theta / 2
  const midY2 = positive.cy + positive.r * Math.sin(midAngle2)
  close(midY2, -0.5)

  // Signed area flips.
  close(g.polylineAreaWithBulges([{ x: 0, y: 0, bulge: -1 }, { x: 1, y: 0 }]), -PI / 8)
})

test('polylineAreaWithBulges: CCW square with 4 semicircle bulges', () => {
  const square = [
    { x: 0, y: 0, bulge: 1 },
    { x: 1, y: 0, bulge: 1 },
    { x: 1, y: 1, bulge: 1 },
    { x: 0, y: 1, bulge: 1 },
  ]
  close(g.polygonArea(square), 1)
  // square area + 4 * (pi * c^2 / 8)
  close(g.polylineAreaWithBulges(square), 1 + 4 * (PI / 8))
})

test('bulgeToArc returns null for zero bulge and zero-length chord', () => {
  assert.equal(g.bulgeToArc({ x: 0, y: 0 }, { x: 1, y: 0 }, 0), null)
  assert.equal(g.bulgeToArc({ x: 1, y: 1 }, { x: 1, y: 1 }, 1), null)
  assert.equal(g.bulgeToArc({ x: 0, y: 0 }, { x: 1, y: 0 }, NaN), null)
})

/* ------------------------------------------------------------------ */
/* polygons / angles / radius                                          */
/* ------------------------------------------------------------------ */

test('polygonArea: CCW positive, reversed negative', () => {
  const square = [[0, 0], [1, 0], [1, 1], [0, 1]]
  close(g.polygonArea(square), 1)
  close(g.polygonArea([...square].reverse()), -1)
  assert.equal(g.polygonArea([]), 0)
  assert.equal(g.polygonArea([[0, 0], [0, 0], [0, 0]]), 0)
})

test('radiusFrom3Points', () => {
  close(g.radiusFrom3Points({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }), Math.SQRT1_2)
  assert.equal(g.radiusFrom3Points({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }), null)
  assert.equal(g.radiusFrom3Points([0, 0], [1, 0], [2, 0]), null)
  assert.equal(g.radiusFrom3Points({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }), null)
})

test('angleBetween returns 0..180', () => {
  close(g.angleBetween(350, 10), 20)
  close(g.angleBetween(10, 350), 20)
  close(g.angleBetween(0, 180), 180)
  close(g.angleBetween(0, 90), 90)
  close(g.angleBetween(45, 45), 0)
  close(g.angleBetween(-90, 90), 180)
})

/* ------------------------------------------------------------------ */
/* degenerates / numeric safety                                        */
/* ------------------------------------------------------------------ */

test('degenerate zero-length geometry never yields NaN', () => {
  assert.equal(g.polylineLength([[0, 0], [0, 0]]), 0)
  assert.equal(g.polylineLength([]), 0)

  const pts = g.arcToPoints(0, 0, 0, 0, 1, true)
  finitePoints(pts)
  assert.equal(pts.length, 1)

  const z = g.entityToPrimitives({
    type: 'LINE',
    start: { x: 5, y: 5 },
    end: { x: 5, y: 5 },
  }, ctx())
  finitePoints(z.primitives[0].points)
  close(z.bbox.minX, 5)
  close(z.bbox.maxX, 5)
  close(z.bbox.minY, 5)
  close(z.bbox.maxY, 5)
})

test('bboxOfPoints([]) is null and bbox helpers behave', () => {
  assert.equal(g.bboxOfPoints([]), null)
  assert.equal(g.bboxOfPoints(null), null)

  const b = g.bboxOfPoints([[1, 2], [3, -4]])
  assert.deepEqual(b, { minX: 1, minY: -4, maxX: 3, maxY: 2 })

  assert.deepEqual(g.bboxUnion(null, b), b)
  assert.deepEqual(g.bboxUnion(b, null), b)
  assert.deepEqual(g.bboxUnion(b, { minX: 0, minY: 0, maxX: 0.5, maxY: 0.5 }),
    { minX: 0, minY: -4, maxX: 3, maxY: 2 })

  const c = { minX: 2, minY: 0, maxX: 4, maxY: 1 }
  assert.equal(g.bboxesIntersect(b, c), true)
  assert.equal(g.bboxesIntersect(b, { minX: 10, minY: 10, maxX: 11, maxY: 11 }), false)
  assert.equal(g.bboxesIntersect({ minX: 0, minY: 0, maxX: 1, maxY: 1 },
    { minX: 1.5, minY: 0, maxX: 2, maxY: 1 }, 0.5), true)

  close(g.bboxDistanceSq({ minX: 0, minY: 0, maxX: 1, maxY: 1 },
    { minX: 2, minY: 3, maxX: 4, maxY: 5 }), 5)
  assert.equal(g.bboxDistanceSq(b, c), 0)
})

/* ------------------------------------------------------------------ */
/* matrices                                                            */
/* ------------------------------------------------------------------ */

test('matrix basics and INSERT composition', () => {
  const id = g.identityMatrix()
  assert.deepEqual(g.applyMatrix(id, 3, 4), { x: 3, y: 4 })

  const parent = [1, 0, 0, 1, 10, 20] // translate (10, 20)
  const m = g.composeMatrix(parent, {
    position: { x: 1, y: 2 },
    xScale: 2,
    yScale: 2,
    rotation: 90,
  })
  assert.deepEqual(g.applyMatrix(m, 1, 0), { x: 11, y: 24 })

  assert.deepEqual(g.matrixScale([2, 0, 0, 3, 0, 0]), { sx: 2, sy: 3 })
  const rotated = g.composeMatrix(g.identityMatrix(), {
    position: { x: 0, y: 0 }, xScale: 2, yScale: 2, rotation: 37,
  })
  const s = g.matrixScale(rotated)
  close(s.sx, 2)
  close(s.sy, 2)
})

/* ------------------------------------------------------------------ */
/* arc flattening                                                      */
/* ------------------------------------------------------------------ */

test('arcToPoints includes endpoints and honours stepDeg', () => {
  const quarter = g.arcToPoints(0, 0, 1, 0, PI / 2, true, 6)
  assert.equal(quarter.length, 16) // 15 segments + 1
  close(quarter[0][0], 1)
  close(quarter[0][1], 0)
  close(quarter[quarter.length - 1][0], 0)
  close(quarter[quarter.length - 1][1], 1)

  const full = g.arcToPoints(0, 0, 2, 0, TAU, true, 6)
  assert.equal(full.length, 61)
  close(full[0][0], full[60][0], 1e-12)
  close(full[0][1], full[60][1], 1e-12)

  const coarse = g.arcToPoints(0, 0, 1, 0, TAU, true, 90)
  assert.equal(coarse.length, 5)
})

test('arcToPoints wraps across 0 degrees and mirrors for CW', () => {
  // 350deg -> 10deg CCW is a 20 degree arc crossing zero.
  const pts = g.arcToPoints(0, 0, 1, (350 * PI) / 180, (10 * PI) / 180, true, 6)
  finitePoints(pts)
  // 20 / 6 => 4 segments
  assert.equal(pts.length, 5)
  close(pts[0][1], Math.sin((350 * PI) / 180))
  close(pts[4][0], Math.cos((10 * PI) / 180))

  const cw = g.arcToPoints(0.5, 0, 0.5, PI, 0, false, 6)
  const mid = cw[Math.floor(cw.length / 2)]
  assert.ok(mid[1] > 0)
})

/* ------------------------------------------------------------------ */
/* entityToPrimitives: basics                                          */
/* ------------------------------------------------------------------ */

test('LINE -> polyline, inserts apply the matrix', () => {
  const r = g.entityToPrimitives(
    { type: 'LINE', start: { x: 0, y: 0 }, end: { x: 2, y: 0 } },
    ctx(),
  )
  assert.equal(r.primitives.length, 1)
  assert.equal(r.primitives[0].kind, 'polyline')
  assert.equal(r.primitives[0].closed, false)
  assert.deepEqual(r.primitives[0].points, [[0, 0], [2, 0]])
  assert.deepEqual(r.bbox, { minX: 0, minY: 0, maxX: 2, maxY: 0 })

  // dxf-parser v1.1.x actually exposes LINE endpoints as `vertices`.
  const parsedShape = g.entityToPrimitives(
    { type: 'LINE', vertices: [{ x: 0, y: 0 }, { x: 3, y: 4 }] },
    ctx(),
  )
  assert.deepEqual(parsedShape.primitives[0].points, [[0, 0], [3, 4]])
  assert.equal(
    g.entityFingerprint({ type: 'LINE', vertices: [{ x: 0, y: 0 }, { x: 3, y: 4 }] }, ctx()),
    g.entityFingerprint({ type: 'LINE', start: { x: 3, y: 4 }, end: { x: 0, y: 0 } }, ctx()),
  )
})

test('ARC in DXF degrees and in dxf-parser radians agree', () => {
  const options = [
    { type: 'ARC', center: { x: 0, y: 0 }, radius: 1, startAngle: 0, endAngle: 90 },
    // dxf-parser v1.1.x: radians + angleLength
    { type: 'ARC', center: { x: 0, y: 0 }, radius: 1, startAngle: 0, endAngle: PI / 2, angleLength: PI / 2 },
  ]
  for (const entity of options) {
    const r = g.entityToPrimitives(entity, ctx())
    const pts = r.primitives[0].points
    finitePoints(pts)
    close(pts[0][0], 1)
    close(pts[0][1], 0)
    close(pts[pts.length - 1][0], 0)
    close(pts[pts.length - 1][1], 1)
    for (const [x, y] of pts) close(Math.hypot(x, y), 1)
  }
})

test('CIRCLE -> closed polyline with correct bbox', () => {
  const r = g.entityToPrimitives({ type: 'CIRCLE', center: { x: 1, y: 2 }, radius: 3 }, ctx())
  assert.equal(r.primitives.length, 1)
  assert.equal(r.primitives[0].closed, true)
  assert.equal(r.primitives[0].points.length, 60)
  close(r.bbox.minX, -2)
  close(r.bbox.maxX, 4)
  close(r.bbox.minY, -1)
  close(r.bbox.maxY, 5)

  // ctx.arcStepDeg controls tessellation.
  const coarse = g.entityToPrimitives(
    { type: 'CIRCLE', center: { x: 0, y: 0 }, radius: 1 },
    ctx({ arcStepDeg: 90 }),
  )
  assert.equal(coarse.primitives[0].points.length, 4)
})

test('POINT / TEXT / MTEXT primitives', () => {
  const p = g.entityToPrimitives({ type: 'POINT', position: { x: 4, y: 5 } }, ctx())
  assert.deepEqual(p.primitives[0], { kind: 'point', x: 4, y: 5 })

  const t = g.entityToPrimitives({
    type: 'TEXT',
    startPoint: { x: 1, y: 2 },
    textHeight: 0.5,
    rotation: 30,
    text: ' Hello ',
    layer: 'WALLS',
  }, ctx())
  assert.deepEqual(t.primitives[0], {
    kind: 'text', x: 1, y: 2, height: 0.5, rotation: 30, text: ' Hello ', layer: 'WALLS',
  })

  const m = g.entityToPrimitives({
    type: 'MTEXT',
    position: { x: 0, y: 0 },
    height: 1,
    text: 'Hello\\PWorld',
  }, ctx())
  assert.equal(m.primitives[0].kind, 'text')
  assert.equal(m.primitives[0].text, 'Hello\nWorld')

  // Text height follows the block scale.
  const block = { entities: [{ type: 'TEXT', startPoint: { x: 0, y: 0 }, textHeight: 1, text: 'x' }] }
  const ins = g.entityToPrimitives(
    { type: 'INSERT', name: 'B', position: { x: 0, y: 0 }, xScale: 2, yScale: 3 },
    ctx({ blocks: { B: block } }),
  )
  close(ins.primitives[0].height, 3)
})

/* ------------------------------------------------------------------ */
/* LWPOLYLINE / bulge entities                                         */
/* ------------------------------------------------------------------ */

test('LWPOLYLINE bulge emits a true arc, not a chord', () => {
  const r = g.entityToPrimitives({
    type: 'LWPOLYLINE',
    vertices: [{ x: 0, y: 0, bulge: 1 }, { x: 1, y: 0 }],
    shape: true,
  }, ctx())

  const prim = r.primitives[0]
  assert.equal(prim.closed, true)
  assert.ok(prim.points.length > 10, 'must be tessellated')

  // Semicircle below the chord, then closed.
  close(r.bbox.minY, -0.5)
  close(r.bbox.maxY, 0)
  const hasApex = prim.points.some(([x, y]) => Math.abs(x - 0.5) < 1e-9 && Math.abs(y + 0.5) < 1e-9)
  assert.ok(hasApex, 'arc apex must be present')

  // Sampled area converges to the circular segment area.
  close(Math.abs(g.polygonArea(prim.points)), PI / 8, 0.01)
})

test('open LWPOLYLINE bulge does not close the loop', () => {
  const r = g.entityToPrimitives({
    type: 'LWPOLYLINE',
    vertices: [{ x: 0, y: 0, bulge: 1 }, { x: 1, y: 0 }],
    shape: false,
  }, ctx())
  assert.equal(r.primitives[0].closed, false)
  close(r.bbox.minY, -0.5)
  close(r.bbox.maxY, 0)
})

test('POLYLINE (VERTEX list) handles closed flag and bulges', () => {
  const r = g.entityToPrimitives({
    type: 'POLYLINE',
    shape: true,
    vertices: [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 2 },
      { x: 0, y: 2 },
    ],
  }, ctx())
  assert.equal(r.primitives[0].closed, true)
  assert.equal(r.primitives[0].points.length, 4)
  close(g.polygonArea(r.primitives[0].points), 4)
})

/* ------------------------------------------------------------------ */
/* INSERT blocks, cycles, depth                                        */
/* ------------------------------------------------------------------ */

test('INSERT recursion composes position/scale/rotation', () => {
  const blocks = {
    BLK: { entities: [{ type: 'CIRCLE', center: { x: 0, y: 0 }, radius: 1 }] },
  }
  const r = g.entityToPrimitives({
    type: 'INSERT', name: 'BLK', position: { x: 10, y: 20 }, xScale: 2, yScale: 2,
  }, ctx({ blocks }))
  assert.equal(r.primitives.length, 1)
  close(r.bbox.minX, 8)
  close(r.bbox.maxX, 12)
  close(r.bbox.minY, 18)
  close(r.bbox.maxY, 22)
})

test('INSERT subtracts a non-zero block base point', () => {
  const blocks = {
    B: {
      position: { x: 1, y: 1, z: 0 },
      entities: [{ type: 'CIRCLE', center: { x: 1, y: 1 }, radius: 1 }],
    },
  }
  const r = g.entityToPrimitives({
    type: 'INSERT', name: 'B', position: { x: 10, y: 10 }, xScale: 2, yScale: 2,
  }, ctx({ blocks }))
  // Block point (1,1) lands exactly on the insertion point (10,10).
  close(r.bbox.minX, 8)
  close(r.bbox.maxX, 12)
  close(r.bbox.minY, 8)
  close(r.bbox.maxY, 12)
})

test('non-uniform INSERT scale squashes circles and warns', () => {
  const warnings = new Set()
  const blocks = { BLK: { entities: [{ type: 'CIRCLE', center: { x: 0, y: 0 }, radius: 1 }] } }
  const r = g.entityToPrimitives({
    type: 'INSERT', name: 'BLK', position: { x: 0, y: 0 }, xScale: 4, yScale: 1,
  }, ctx({ blocks, warnings }))

  close(r.bbox.minX, -4)
  close(r.bbox.maxX, 4)
  close(r.bbox.minY, -1)
  close(r.bbox.maxY, 1)
  assert.ok(warnings.has('arc:non-uniform-scale'))
})

test('INSERT cycles and depth limits are guarded', () => {
  const cyclic = { A: { entities: [{ type: 'INSERT', name: 'A', position: { x: 0, y: 0 } }] } }
  const warnings = new Set()
  const r = g.entityToPrimitives(
    { type: 'INSERT', name: 'A', position: { x: 0, y: 0 } },
    ctx({ blocks: cyclic, warnings }),
  )
  assert.equal(r.primitives.length, 0)
  assert.ok([...warnings].some((w) => w.startsWith('insert:cycle:')), [...warnings].join(','))

  const deep = {
    A: { entities: [{ type: 'INSERT', name: 'B', position: { x: 0, y: 0 } }] },
    B: { entities: [{ type: 'INSERT', name: 'C', position: { x: 0, y: 0 } }] },
    C: { entities: [{ type: 'LINE', start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }] },
  }
  const w2 = new Set()
  const limited = g.entityToPrimitives(
    { type: 'INSERT', name: 'A', position: { x: 0, y: 0 } },
    ctx({ blocks: deep, maxDepth: 1, warnings: w2 }),
  )
  assert.equal(limited.primitives.length, 0)
  assert.ok([...w2].some((w) => w.startsWith('insert:max-depth:')))
})

test('missing INSERT block warns without throwing', () => {
  const warnings = new Set()
  const r = g.entityToPrimitives(
    { type: 'INSERT', name: 'NOPE', position: { x: 0, y: 0 } },
    ctx({ warnings }),
  )
  assert.equal(r.primitives.length, 0)
  assert.ok(warnings.has('insert:missing-block:NOPE'))
})

/* ------------------------------------------------------------------ */
/* OCS arbitrary axis algorithm                                        */
/* ------------------------------------------------------------------ */

test('OCS: circle extruded 45 degrees becomes a flattened ellipse', () => {
  const s = Math.SQRT1_2
  const warnings = new Set()
  const r = g.entityToPrimitives({
    type: 'CIRCLE',
    center: { x: 0, y: 0 },
    radius: 1,
    extrusionDirectionX: 0,
    extrusionDirectionY: s,
    extrusionDirectionZ: s,
  }, ctx({ warnings }))

  const pts = r.primitives[0].points
  finitePoints(pts)
  // Ax = (-1, 0, 0), Ay = (0, -cos45, sin45) -> XY radii 1 and cos45.
  close(r.bbox.minX, -1, 1e-9)
  close(r.bbox.maxX, 1, 1e-9)
  close(r.bbox.minY, -s, 1e-9)
  close(r.bbox.maxY, s, 1e-9)
  assert.ok(warnings.has('arc:non-uniform-scale'))
})

test('OCS: 45 degree extruded ARC maps start/end through the axis algorithm', () => {
  const s = Math.SQRT1_2
  const r = g.entityToPrimitives({
    type: 'ARC',
    center: { x: 0, y: 0 },
    radius: 1,
    startAngle: 0,
    endAngle: 90,
    extrusionDirectionX: 0,
    extrusionDirectionY: s,
    extrusionDirectionZ: s,
  }, ctx())
  const pts = r.primitives[0].points
  // OCS (1,0) -> (-1, 0); OCS (0,1) -> (0, -cos45).
  close(pts[0][0], -1)
  close(pts[0][1], 0)
  close(pts[pts.length - 1][0], 0)
  close(pts[pts.length - 1][1], -s)
})

test('OCS: default extrusion (0,0,1) is the identity', () => {
  const plain = g.entityToPrimitives({ type: 'CIRCLE', center: { x: 2, y: 3 }, radius: 1 }, ctx())
  const explicit = g.entityToPrimitives({
    type: 'CIRCLE', center: { x: 2, y: 3 }, radius: 1,
    extrusionDirectionX: 0, extrusionDirectionY: 0, extrusionDirectionZ: 1,
  }, ctx())
  assert.deepEqual(plain.primitives[0].points, explicit.primitives[0].points)
})

/* ------------------------------------------------------------------ */
/* ELLIPSE / SPLINE / DIMENSION / HATCH / unknown                      */
/* ------------------------------------------------------------------ */

test('ELLIPSE flattens parametrically', () => {
  const r = g.entityToPrimitives({
    type: 'ELLIPSE',
    center: { x: 0, y: 0 },
    majorAxisEndPoint: { x: 2, y: 0 },
    axisRatio: 0.5,
    startAngle: 0,
    endAngle: TAU,
  }, ctx())
  const prim = r.primitives[0]
  assert.equal(prim.closed, true)
  assert.equal(prim.points.length, 60)
  close(r.bbox.minX, -2)
  close(r.bbox.maxX, 2)
  close(r.bbox.minY, -1)
  close(r.bbox.maxY, 1)
})

test('ELLIPSE half sweep is open', () => {
  const r = g.entityToPrimitives({
    type: 'ELLIPSE',
    center: { x: 0, y: 0 },
    majorAxisEndPoint: { x: 2, y: 0 },
    axisRatio: 0.5,
    startAngle: 0,
    endAngle: PI,
  }, ctx())
  assert.equal(r.primitives[0].closed, false)
  close(r.bbox.minY, 0)
  close(r.bbox.maxY, 1)
})

test('SPLINE uses de Boor when knots+degree are usable', () => {
  const r = g.entityToPrimitives({
    type: 'SPLINE',
    degreeOfSplineCurve: 3,
    controlPoints: [
      { x: 0, y: 0 },
      { x: 1, y: 2 },
      { x: 2, y: -2 },
      { x: 3, y: 0 },
    ],
    knotValues: [0, 0, 0, 0, 1, 1, 1, 1],
  }, ctx())
  const pts = r.primitives[0].points
  finitePoints(pts)
  close(pts[0][0], 0)
  close(pts[0][1], 0)
  close(pts[pts.length - 1][0], 3)
  close(pts[pts.length - 1][1], 0)
  assert.ok(pts.length >= 17)
})

test('SPLINE without usable knots falls back to control points + warning', () => {
  const warnings = new Set()
  const r = g.entityToPrimitives({
    type: 'SPLINE',
    controlPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }],
  }, ctx({ warnings }))
  assert.equal(r.primitives[0].points.length, 3)
  assert.ok(warnings.has('spline:approximated'))
})

test('DIMENSION recurses into its anonymous block or reports notCompared', () => {
  const blocks = {
    '*D1': { entities: [{ type: 'LINE', start: { x: 0, y: 0 }, end: { x: 2, y: 0 } }] },
  }
  const ok = g.entityToPrimitives({ type: 'DIMENSION', block: '*D1' }, ctx({ blocks }))
  assert.equal(ok.primitives.length, 1)

  const warnings = new Set()
  const missing = g.entityToPrimitives({ type: 'DIMENSION', block: '*D9' }, ctx({ warnings }))
  assert.equal(missing.primitives.length, 0)
  assert.equal(missing.notCompared, 'dimension:no-block')
  assert.ok(warnings.has('dimension:no-block'))
})

test('HATCH honours includeHatch', () => {
  const hatch = {
    type: 'HATCH',
    boundaryPaths: [{ vertices: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 0 }] }],
  }
  const off = g.entityToPrimitives(hatch, ctx())
  assert.equal(off.primitives.length, 0)
  assert.equal(off.notCompared, 'hatch')

  const on = g.entityToPrimitives(hatch, ctx({ includeHatch: true }))
  assert.equal(on.primitives.length, 1)
  assert.equal(on.primitives[0].closed, true)
  assert.deepEqual(on.bbox, { minX: 0, minY: 0, maxX: 1, maxY: 1 })
})

test('unknown entity types warn instead of throwing', () => {
  const warnings = new Set()
  const r = g.entityToPrimitives({ type: 'ACAD_PROXY_ENTITY' }, ctx({ warnings }))
  assert.equal(r.primitives.length, 0)
  assert.equal(r.notCompared, 'unsupported')
  assert.ok(warnings.has('unsupported:ACAD_PROXY_ENTITY'))
})

test('a throwing entity is contained by try/catch', () => {
  const warnings = new Set()
  const bad = { type: 'LINE' }
  Object.defineProperty(bad, 'start', {
    get() { throw new Error('boom') },
  })
  const r = g.entityToPrimitives(bad, ctx({ warnings }))
  assert.equal(r.primitives.length, 0)
  assert.ok(warnings.has('entity:LINE'))

  // null / non-object input must not throw either
  assert.equal(g.entityToPrimitives(null, ctx()).primitives.length, 0)
})

/* ------------------------------------------------------------------ */
/* fingerprints                                                        */
/* ------------------------------------------------------------------ */

test('LINE fingerprint ignores endpoint order, handle, layer and colour', () => {
  const a = g.entityFingerprint({
    type: 'LINE', start: { x: 0, y: 0 }, end: { x: 10, y: 5 }, handle: 'A1', layer: 'L1', colorIndex: 1,
  }, ctx())
  const b = g.entityFingerprint({
    type: 'LINE', start: { x: 10, y: 5 }, end: { x: 0, y: 0 }, handle: 'FF', layer: 'L2', colorIndex: 7,
  }, ctx())
  assert.equal(a, b)
  assert.notEqual(a, g.entityFingerprint({
    type: 'LINE', start: { x: 0, y: 0 }, end: { x: 10, y: 6 },
  }, ctx()))
})

test('fingerprints are quantised and stable strings', () => {
  const base = g.entityFingerprint({ type: 'LINE', start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }, ctx())
  const near = g.entityFingerprint({
    type: 'LINE', start: { x: 0, y: 0 }, end: { x: 1.0000004, y: 0 },
  }, ctx())
  const far = g.entityFingerprint({
    type: 'LINE', start: { x: 0, y: 0 }, end: { x: 1.000002, y: 0 },
  }, ctx())
  assert.equal(typeof base, 'string')
  assert.equal(base, near)
  assert.notEqual(base, far)
})

test('SOLID / 3DFACE fingerprints ignore point order', () => {
  const solidA = g.entityFingerprint({
    type: 'SOLID',
    points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
  }, ctx())
  const solidB = g.entityFingerprint({
    type: 'SOLID',
    points: [{ x: 0, y: 1 }, { x: 1, y: 1 }, { x: 0, y: 0 }, { x: 1, y: 0 }],
  }, ctx())
  assert.equal(solidA, solidB)

  const faceA = g.entityFingerprint({ type: '3DFACE', vertices: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }] }, ctx())
  const faceB = g.entityFingerprint({ type: '3DFACE', vertices: [{ x: 0, y: 1 }, { x: 0, y: 0 }, { x: 1, y: 0 }] }, ctx())
  assert.equal(faceA, faceB)
})

test('closed polyline fingerprint is start-vertex and direction invariant', () => {
  const square = [
    { x: 0, y: 0, bulge: 0 },
    { x: 1, y: 0, bulge: 0.5 },
    { x: 1, y: 1, bulge: 0 },
    { x: 0, y: 1, bulge: 0 },
  ]
  const fp = (vertices) => g.entityFingerprint({ type: 'LWPOLYLINE', vertices, shape: true }, ctx())

  const rotated = [square[2], square[3], square[0], square[1]]
  assert.equal(fp(square), fp(rotated))

  // Reverse traversal: reverse the vertex list and negate the outgoing bulge
  // of every vertex (edge v[i-1] -> v[i] becomes v[i] -> v[i-1]).
  const reversed = [
    { x: square[0].x, y: square[0].y, bulge: -square[3].bulge },
    { x: square[3].x, y: square[3].y, bulge: -square[2].bulge },
    { x: square[2].x, y: square[2].y, bulge: -square[1].bulge },
    { x: square[1].x, y: square[1].y, bulge: -square[0].bulge },
  ]
  assert.equal(fp(square), fp(reversed))

  // Geometry-affecting fields still participate.
  const withBulge = square.map((v) => ({ ...v }))
  withBulge[0].bulge = 0.7
  assert.notEqual(fp(square), fp(withBulge))
  assert.notEqual(fp(square), g.entityFingerprint({ type: 'LWPOLYLINE', vertices: square, shape: false }, ctx()))
})

test('text fingerprints: whitespace + MTEXT codes are normalised', () => {
  const t1 = g.entityFingerprint({
    type: 'TEXT', startPoint: { x: 0, y: 0 }, textHeight: 1, rotation: 0, text: '  Hello   World ',
  }, ctx())
  const t2 = g.entityFingerprint({
    type: 'TEXT', startPoint: { x: 0, y: 0 }, textHeight: 1, rotation: 0, text: 'Hello World', handle: '99',
  }, ctx())
  assert.equal(t1, t2)

  const m1 = g.entityFingerprint({
    type: 'MTEXT', position: { x: 0, y: 0 }, height: 1, text: '{\\fArial|b0;Hello} \\PWorld',
  }, ctx())
  const m2 = g.entityFingerprint({
    type: 'MTEXT', position: { x: 0, y: 0 }, height: 1, text: 'Hello World',
  }, ctx())
  assert.equal(m1, m2)

  // Height and rotation matter.
  assert.notEqual(t1, g.entityFingerprint({
    type: 'TEXT', startPoint: { x: 0, y: 0 }, textHeight: 2, rotation: 0, text: 'Hello World',
  }, ctx()))
  assert.notEqual(t1, g.entityFingerprint({
    type: 'TEXT', startPoint: { x: 0, y: 0 }, textHeight: 1, rotation: 45, text: 'Hello World',
  }, ctx()))
})

test('INSERT fingerprint includes name, transform and array grid', () => {
  const base = { type: 'INSERT', name: 'B', position: { x: 1, y: 2 }, xScale: 1, yScale: 1, rotation: 0 }
  const fp = (e) => g.entityFingerprint(e, ctx())
  assert.equal(fp(base), fp({ ...base, handle: 'AB', layer: 'X', colorIndex: 3 }))
  assert.notEqual(fp(base), fp({ ...base, position: { x: 1, y: 3 } }))
  assert.notEqual(fp(base), fp({ ...base, xScale: 2 }))
  assert.notEqual(fp(base), fp({ ...base, rotation: 90 }))
  assert.notEqual(fp(base), fp({ ...base, columnCount: 2, columnSpacing: 5 }))
  assert.notEqual(fp(base), fp({ ...base, name: 'C' }))
})

test('entityPropertyKey only includes enabled compareProps', () => {
  const entity = {
    type: 'LINE', layer: 'WALLS', colorIndex: 2, lineType: 'DASHED',
    lineweight: 25, transparency: 40, thickness: 1.5,
  }
  const all = g.entityPropertyKey(entity)
  assert.equal(all, 'color=2|layer=WALLS|linetype=DASHED|lineweight=25|transparency=40|thickness=1.5')

  const some = g.entityPropertyKey(entity, { compareProps: ['color', 'linetype'] })
  assert.equal(some, 'color=2|linetype=DASHED')

  const noLayer = g.entityPropertyKey(entity, { compareProps: ['color'] })
  assert.equal(noLayer, 'color=2')

  assert.equal(g.entityPropertyKey(entity, { compareProps: [] }), '')

  // Fingerprint excludes all of the above.
  const fpA = g.entityFingerprint({
    type: 'LINE', start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, layer: 'WALLS', colorIndex: 2,
  }, ctx())
  const fpB = g.entityFingerprint({
    type: 'LINE', start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, layer: 'OTHER', colorIndex: 5,
  }, ctx())
  assert.equal(fpA, fpB)
  assert.notEqual(g.entityPropertyKey(entity), g.entityPropertyKey({ ...entity, layer: 'OTHER' }))
})

/* ------------------------------------------------------------------ */
/* bulk sanity (performance guard, not a benchmark)                    */
/* ------------------------------------------------------------------ */

test('converts thousands of entities without errors', () => {
  const context = ctx()
  for (let i = 0; i < 5000; i++) {
    const r = g.entityToPrimitives({
      type: 'LINE',
      start: { x: i, y: 0 },
      end: { x: i, y: 1 },
    }, context)
    assert.equal(r.primitives.length, 1)
  }
})
