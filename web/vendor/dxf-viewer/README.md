# dxf-viewer fork (MPL-2.0)

This directory is a **modified copy** of `dxf-viewer@1.0.50`
(<https://github.com/vagran/dxf-viewer>), vendored so the fixes below ship with the
repository and are used identically by `vite dev` and `vite build` (alias in
`web/vite.config.ts`).

Upstream license: **Mozilla Public License 2.0**. The full text is in
[`LICENSE`](./LICENSE). MPL-2.0 is file-level copyleft: the modified files below
remain under MPL-2.0 and are published here in source form. They may be
redistributed and modified under the same license; the rest of CADViewer is a
separate work under AGPL-3.0-only.

## Modified files

| File | Change |
| --- | --- |
| `src/DxfScene.js` | Layer-0 inheritance for block entities; threaded effective colour/layer through `BlockContext` for nested INSERTs; flatten path no longer overwrites non-zero layers; frozen layers kept and reported initially invisible instead of being dropped at load. Dimension pre-rendered `*D` blocks are validated against the dimension's defining points and only trusted when they agree; a stale/mismatched block (DWG conversions can carry anonymous blocks generated in another coordinate system) falls back to synthesizing the linear dimension from its definition points instead of drawing geometry elsewhere and inflating the scene bounds. |
| `src/DxfViewer.js` | Instanced-block BYLAYER resolution uses the INSERT layer only for layer-0 entities; object layer assignment keeps a block entity's own non-zero layer. |
| `src/SceneReader.js` | Same colour/layer resolution rules as the renderer, so the flat primitive reader agrees with it. |

Everything else is unmodified upstream 1.0.50 source.

## Why

AutoCAD block semantics:

1. An entity on layer `0` inside a block inherits the **INSERT's** layer (walking
   up through nested INSERTs to the outermost instance). An entity with its own
   non-zero layer keeps that layer's colour.
2. `BYBLOCK` resolves to the colour of the INSERT that owns the entity, including
   through nested blocks.
3. Frozen layers are a view setting: the geometry must stay available so the
   layer panel can switch it back on. It starts hidden so the default view is
   unchanged.

The previous code resolved layer-0 block entities against layer `0` itself
(ACI 7 / white) and let the INSERT layer overwrite every block entity in the
flattened path.

## Updating

Re-copy `src/` from a newer upstream release, then re-apply the changes above.
`web/package.json` still lists `dxf-viewer` so its transitive dependencies
(`three`, `earcut`, `loglevel`, `opentype.js`) are installed; the Vite alias
guarantees this fork is what both dev and build compile.
