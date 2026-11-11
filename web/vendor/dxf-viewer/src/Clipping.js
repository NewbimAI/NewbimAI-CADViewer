/* Polygon clipping helpers for XCLIP / viewport clipping.
 *
 * The clip boundary in DXF SPATIAL_FILTER can be an arbitrary polygon (and may be
 * concave), so a rectangle-only Liang–Barsky test is not enough. Everything here
 * works on plain `[x, y]` arrays to stay independent of three.js.
 */

import earcut from "earcut";

const EPS = 1e-9;

function Cross(ax, ay, bx, by) {
    return ax * by - ay * bx;
}

/** Signed area; positive for counter-clockwise rings in a Y-up coordinate system. */
export function PolygonArea(polygon) {
    let area = 0;
    const n = polygon.length;
    for (let i = 0; i < n; i++) {
        const a = polygon[i];
        const b = polygon[(i + 1) % n];
        area += a[0] * b[1] - b[0] * a[1];
    }
    return area / 2;
}

function EnsureCcw(polygon) {
    return PolygonArea(polygon) < 0 ? polygon.slice().reverse() : polygon;
}

/** True when every vertex turns the same way (collinear vertices are allowed). */
export function IsPolygonConvex(polygon) {
    const n = polygon.length;
    if (n < 4) {
        return true;
    }
    let sign = 0;
    for (let i = 0; i < n; i++) {
        const a = polygon[i];
        const b = polygon[(i + 1) % n];
        const c = polygon[(i + 2) % n];
        const cross = Cross(b[0] - a[0], b[1] - a[1], c[0] - b[0], c[1] - b[1]);
        if (Math.abs(cross) <= EPS) {
            continue;
        }
        const s = cross > 0 ? 1 : -1;
        if (sign === 0) {
            sign = s;
        } else if (sign !== s) {
            return false;
        }
    }
    return true;
}

function PointOnSegment(x, y, a, b) {
    const cross = Cross(b[0] - a[0], b[1] - a[1], x - a[0], y - a[1]);
    if (Math.abs(cross) > EPS * (1 + Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]))) {
        return false;
    }
    return x >= Math.min(a[0], b[0]) - EPS && x <= Math.max(a[0], b[0]) + EPS &&
           y >= Math.min(a[1], b[1]) - EPS && y <= Math.max(a[1], b[1]) + EPS;
}

/**
 * Even-odd point-in-polygon test. Points exactly on the boundary count as inside,
 * so a line drawn on the XCLIP boundary is kept.
 */
export function IsPointInPolygon(x, y, polygon) {
    const n = polygon.length;
    if (n < 3) {
        return false;
    }
    let inside = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
        const a = polygon[j];
        const b = polygon[i];
        if (PointOnSegment(x, y, a, b)) {
            return true;
        }
        if ((b[1] > y) !== (a[1] > y)) {
            const t = (y - b[1]) / (a[1] - b[1]);
            if (x < b[0] + t * (a[0] - b[0])) {
                inside = !inside;
            }
        }
    }
    return inside;
}

export function IsPointInPolygons(x, y, polygons) {
    if (!polygons || polygons.length === 0) {
        return true;
    }
    for (const polygon of polygons) {
        if (!IsPointInPolygon(x, y, polygon)) {
            return false;
        }
    }
    return true;
}

/**
 * Parameter intervals of the segment that lie inside the polygon.
 * A concave polygon can split one segment into several intervals.
 *
 * @returns {Array<[number, number]>}
 */
export function ClipSegmentToPolygon(x0, y0, x1, y1, polygon) {
    if (!polygon || polygon.length < 3) {
        return [];
    }
    const dx = x1 - x0;
    const dy = y1 - y0;
    const cuts = [0, 1];
    const n = polygon.length;
    for (let i = 0; i < n; i++) {
        const a = polygon[i];
        const b = polygon[(i + 1) % n];
        const sx = b[0] - a[0];
        const sy = b[1] - a[1];
        const denom = Cross(dx, dy, sx, sy);
        if (Math.abs(denom) <= EPS) {
            continue;
        }
        const t = Cross(a[0] - x0, a[1] - y0, sx, sy) / denom;
        const u = Cross(a[0] - x0, a[1] - y0, dx, dy) / denom;
        if (t > EPS && t < 1 - EPS && u >= -EPS && u <= 1 + EPS) {
            cuts.push(t);
        }
    }
    cuts.sort((a, b) => a - b);
    const unique = [];
    for (const t of cuts) {
        if (!unique.length || Math.abs(unique[unique.length - 1] - t) > EPS) {
            unique.push(t);
        }
    }
    const result = [];
    for (let i = 0; i + 1 < unique.length; i++) {
        const t0 = unique[i];
        const t1 = unique[i + 1];
        if (t1 - t0 <= EPS) {
            continue;
        }
        const tm = (t0 + t1) / 2;
        if (IsPointInPolygon(x0 + dx * tm, y0 + dy * tm, polygon)) {
            result.push([t0, t1]);
        }
    }
    return result;
}

/** Clip a segment against a stack of polygons, returning visible pieces. */
export function ClipSegmentToPolygons(x0, y0, x1, y1, polygons) {
    let pieces = [[x0, y0, x1, y1]];
    for (const polygon of polygons || []) {
        const next = [];
        for (const [ax, ay, bx, by] of pieces) {
            const dx = bx - ax;
            const dy = by - ay;
            for (const [t0, t1] of ClipSegmentToPolygon(ax, ay, bx, by, polygon)) {
                next.push([ax + dx * t0, ay + dy * t0, ax + dx * t1, ay + dy * t1]);
            }
        }
        pieces = next;
        if (!pieces.length) {
            break;
        }
    }
    return pieces;
}

/** Sutherland–Hodgman against a convex, counter-clockwise clip polygon. */
export function ClipPolygonByConvexPolygon(subject, clip) {
    if (!subject || subject.length < 3 || !clip || clip.length < 3) {
        return [];
    }
    let output = subject.slice();
    const n = clip.length;
    for (let i = 0; i < n && output.length; i++) {
        const a = clip[i];
        const b = clip[(i + 1) % n];
        const input = output;
        output = [];
        const inside = (p) =>
            Cross(b[0] - a[0], b[1] - a[1], p[0] - a[0], p[1] - a[1]) >= -EPS;
        let prev = input[input.length - 1];
        let prevIn = inside(prev);
        for (const cur of input) {
            const curIn = inside(cur);
            if (curIn !== prevIn) {
                const dx = cur[0] - prev[0];
                const dy = cur[1] - prev[1];
                const ex = b[0] - a[0];
                const ey = b[1] - a[1];
                const denom = Cross(dx, dy, ex, ey);
                if (Math.abs(denom) > EPS) {
                    const t = Cross(a[0] - prev[0], a[1] - prev[1], ex, ey) / denom;
                    output.push([prev[0] + dx * t, prev[1] + dy * t]);
                }
            }
            if (curIn) {
                output.push(cur);
            }
            prev = cur;
            prevIn = curIn;
        }
    }
    return output;
}

function CleanPolygon(points) {
    const out = [];
    for (const p of points) {
        if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
            continue;
        }
        const prev = out[out.length - 1];
        if (prev && Math.abs(prev[0] - p[0]) <= EPS && Math.abs(prev[1] - p[1]) <= EPS) {
            continue;
        }
        out.push([p[0], p[1]]);
    }
    while (out.length > 2) {
        const a = out[0];
        const b = out[out.length - 1];
        if (Math.abs(a[0] - b[0]) <= EPS && Math.abs(a[1] - b[1]) <= EPS) {
            out.pop();
        } else {
            break;
        }
    }
    return out;
}

/** Fan-triangulate a convex polygon; degenerate triangles are dropped. */
function ConvexPolygonToTriangles(polygon) {
    const pts = CleanPolygon(polygon);
    if (pts.length < 3) {
        return [];
    }
    const result = [];
    for (let i = 1; i + 1 < pts.length; i++) {
        const a = pts[0];
        const b = pts[i];
        const c = pts[i + 1];
        if (Math.abs(Cross(b[0] - a[0], b[1] - a[1], c[0] - a[0], c[1] - a[1])) > EPS) {
            result.push([a, b, c]);
        }
    }
    return result;
}

/** Triangulate an arbitrary simple polygon (earcut) and return triangles. */
function TriangulatePolygon(polygon) {
    const pts = CleanPolygon(polygon);
    if (pts.length < 3) {
        return [];
    }
    const flat = [];
    for (const p of pts) {
        flat.push(p[0], p[1]);
    }
    let indices;
    try {
        indices = earcut(flat);
    } catch {
        indices = [];
    }
    if (!indices || indices.length < 3) {
        return [];
    }
    const result = [];
    for (let i = 0; i + 2 < indices.length; i += 3) {
        result.push([pts[indices[i]], pts[indices[i + 1]], pts[indices[i + 2]]]);
    }
    return result;
}

/**
 * Clip a triangle by an arbitrary simple polygon. The result is a list of triangles
 * that exactly tile the visible part (concave boundaries are split into ear-cut
 * triangles first, because Sutherland–Hodgman only works with a convex clip).
 *
 * @param {Array<[number, number]>} triangle
 * @param {Array<[number, number]>} polygon
 * @returns {Array<Array<[number, number]>>}
 */
export function ClipTriangleByPolygon(triangle, polygon) {
    if (!triangle || triangle.length < 3 || !polygon || polygon.length < 3) {
        return [];
    }
    const clip = EnsureCcw(CleanPolygon(polygon));
    if (clip.length < 3) {
        return [];
    }
    if (IsPolygonConvex(clip)) {
        return ConvexPolygonToTriangles(ClipPolygonByConvexPolygon(triangle, clip));
    }
    const pieces = [];
    for (const clipTriangle of TriangulatePolygon(clip)) {
        const clipped = ClipPolygonByConvexPolygon(triangle, EnsureCcw(clipTriangle));
        pieces.push(...ConvexPolygonToTriangles(clipped));
    }
    return pieces;
}

/** Clip a triangle against a stack of polygons (nested XCLIP / viewport clipping). */
export function ClipTriangleByPolygons(triangle, polygons) {
    let pieces = [triangle];
    for (const polygon of polygons || []) {
        const next = [];
        for (const piece of pieces) {
            next.push(...ClipTriangleByPolygon(piece, polygon));
        }
        pieces = next;
        if (!pieces.length) {
            break;
        }
    }
    return pieces;
}
