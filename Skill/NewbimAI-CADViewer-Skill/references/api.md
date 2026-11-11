# CADViewer HTTP API（仅在服务已启动时可用）

本 CLI 的统计/导出**不需要**服务；`open` / `serve` / `compare` 会用本机服务（自动拉起）。
需要“正在运行的 CADViewer”（界面同款 WebGL 画面、聚焦灰显、界面导出、对比引擎）时才直接用这些接口。

- 地址：`http://127.0.0.1:3717`（只监听本机，不上云）
- 端口：环境变量 `PORT` 可覆盖，例如 `set PORT=3727`
- 启动：`node <skill>/scripts/cad.mjs serve`，或项目根 `start.bat`
- 响应：JSON（PDF/DXF/DOCX 下载除外）；错误为 `{ "error": "..." }` + 4xx/5xx

> 所有接口都可能长时间构建（首次打开大图、首次导出 PDF）。带 `?status=1` 的接口可以先轮询状态。

> 本文档中的图纸名、图层名、图块名与数字均为**虚构示例数据**，不代表任何真实图纸。

---

## GET /api/health

服务与 cadcraft 状态。

```json
{
  "ok": true,
  "cli": {
    "path": "<repo>\\bin\\cadcraft\\<portable>\\cadcraft-cli.exe",
    "version": "cadcraft-cli 0.7.0"
  }
}
```

`cli` 为 `null` 表示 cadcraft 未部署（此时 DWG 打不开）。

---

## POST /api/open

打开本地图纸，返回 `id` 与统计。两种请求方式二选一：

### 1) 本地路径（推荐给 agent）

```bash
curl.exe -s -X POST http://127.0.0.1:3717/api/open ^
  -H "Content-Type: application/json" ^
  -d "{\"path\":\"<图纸目录>\\\\示例图纸.dwg\"}"
```

### 2) 上传文件

```bash
curl.exe -s -X POST http://127.0.0.1:3717/api/open ^
  -F "file=@<图纸目录>\示例图纸.dwg"
```

只接受 `.dwg` / `.dxf`。上传按**内容 sha1 前 12 位**落盘，同一份文件重复上传会命中同一缓存与同一个 `id`。

### 响应（节选）

```json
{
  "id": "0123456789ab",
  "name": "示例图纸.dwg",
  "format": "DWG",
  "sizeBytes": 524288,
  "statsOk": true,
  "statsError": null,
  "stats": {
    "layers": [],
    "blocks": [],
    "entities": { "total": 1200, "byType": {}, "inserts": 350 },
    "extents": {},
    "coreExtents": {},
    "contentBox": null,
    "header": { "version": "AC1032", "insunits": 4 }
  },
  "skippedEntities": 0,
  "udo": { "level": "none", "classes": [], "evidence": [] },
  "cadcraftInfo": {},
  "dxfVersion": 12
}
```

- `stats` 与 CLI `stats` 的结构一致；其中的块统计**已把匿名块并回原块**。
- `udo.level`：`objects` / `provenance` / `none`，含义见 `answering.md`。
- `skippedEntities > 0` 表示 cadcraft 打开源图时跳过了代理对象，统计可能少于图面。
- `id` 是打开记录的标识，后续 `/api/file/:id/...` 都用它。

---

## POST /api/compare

对比两张已打开的图纸（`base=基准图`、`target=对比图`）。字段语义见 `docs/compare-contract.md`。

```bash
curl.exe -s -X POST http://127.0.0.1:3717/api/compare ^
  -H "Content-Type: application/json" ^
  -d "{\"base\":\"<baseId>\",\"target\":\"<targetId>\",\"options\":{\"tolerance\":0.001,\"quantize\":0.000001,\"compareProps\":[\"color\",\"layer\",\"linetype\",\"lineweight\"],\"includeHatch\":false,\"maxChanges\":5000}}"
```

响应：`base`/`target`（id/name）、`summary`（`added`/`removed`/`modified`/`unchanged`/`notCompared`/`changeSets`/`elapsedMs`/`truncated`）、
`changes[]`、`changeSets[]`、`warnings[]`。结果按 `(idA|idB|options)` 缓存一小段时间，重复请求会命中。
两张图都必须先经 `/api/open` 打开；否则 404。

---

## POST /api/compare/report

生成可编辑 `.docx` 对比报告（`Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document`）。

请求体是**报告模型**，不是 `/api/compare` 的原始响应：

```json
{
  "baseName": "旧图.dwg",
  "targetName": "新图.dwg",
  "createdAt": "2026-11-11T00:00:00Z",
  "options": { "tolerance": 0.001, "compareProps": ["color", "layer"], "includeHatch": false },
  "summary": { "added": 3, "removed": 1, "modified": 2, "unchanged": 9453, "notCompared": 12, "changeSets": 2 },
  "sets": [
    { "name": "变更集 1", "bbox": [0, 0, 1000, 1000],
      "changes": [ { "kind": "added", "type": "LINE", "layer": "0", "handle": "2F",
                     "bbox": [0, 0, 100, 0], "image": null, "note": "可选说明" } ] }
  ]
}
```

- `sets` 不能为空；`changes[].kind` 只能是 `added`/`removed`/`modified`。
- `changes[].image` **必填**：变更位置截图，base64 PNG 或 `data:image/png;base64,...`（≤8MB/张）。
  这也是 CLI 不生成报告的原因——命令行没有 WebGL 渲染，不能伪造截图。
- 请求体上限 200MB（含截图）；超出 413。变更条数上限 20,000。

---

## GET /api/update/status · POST /api/update/check · /download · /apply

自动更新相关（只在界面或运维脚本里用）：查询状态、检查更新、下载更新包、应用更新。
清单格式与行为见 `docs/auto-update.md`。`/api/update/apply` 会重启应用，**agent 不要主动调用**。

---

## GET /api/file/:id/dxf

### `?raw=1` —— 原始 DXF（要交给 CAD 软件时只用这个）

- DWG：cadcraft 的 `converted.dxf`
- DXF：源文件本身
- `Content-Type: application/dxf`，带下载文件名

```bash
curl.exe -s -o out.dxf "http://127.0.0.1:3717/api/file/0123456789ab/dxf?raw=1"
```

### 不带 `raw` —— WebGL 用的派生 DXF（**不要**当原始文件分发）

为了浏览器渲染，服务端会：删掉 `ATTRIB`、展平块内文字、重画 `ACAD_TABLE`。因此它**不是**原始图纸。

可选查询参数：

| 参数 | 含义 |
|---|---|
| `focus=layer:<图层名>` | 非目标图层涂灰（URL 编码中文） |
| `focus=block:<图块名>` | 非目标块及其内部涂灰 |
| `v=<dxfVersion>` | 前端缓存失效键，建议带上 `/api/open` 返回的 `dxfVersion` |
| `status=1` | 只返回构建状态，不返回文件 |

`status=1` 响应（节选）：

```json
{
  "status": "ready",
  "focus": "layer:LAYER_A",
  "focusMuted": 850,
  "focusKept": 350,
  "bytes": 125000,
  "tables": 0,
  "cells": 0,
  "decoded": 2000,
  "error": null
}
```

`status` 为 `building` / `ready` / `error`。非法 `focus` 按“无聚焦”处理。

---

## GET /api/file/:id/pdf

矢量 PDF 下载（单页，A3 横向；文字已转轮廓，不嵌字体）。服务端链路：
`cadcraft convert DXF→SVG → server/svg-pdf.js → PDF`，取景使用 `contentBox`（缺失时 `coreExtents`），与界面「导出 → PDF」一致。

```bash
curl.exe -s -o out.pdf "http://127.0.0.1:3717/api/file/0123456789ab/pdf"
```

首次请求会同步等构建完成。先看状态：

```bash
curl.exe -s "http://127.0.0.1:3717/api/file/0123456789ab/pdf?status=1"
```

```json
{
  "status": "ready",
  "bytes": 480000,
  "svgBytes": 2400000,
  "error": null
}
```

- `status`：`building` / `ready` / `error`
- 超限图纸返回 413（`PDF_MAX_SRC_MB` / `PDF_MAX_SVG_MB` 可调）
- 产物缓存在图纸缓存目录的 `export-v<N>.pdf`，版本变化后自动重建

---

## GET /api/recent

最近打开列表（最多 20 条）：

```json
[
  {
    "id": "0123456789ab",
    "name": "示例图纸.dwg",
    "format": "DWG",
    "sizeBytes": 524288,
    "statsOk": true,
    "openedAt": 1760000000000
  }
]
```

---

## 没有 HTTP 接口的能力

- **测量**（距离/长度/面积/角度/半径/坐标）在浏览器里本地计算，没有 HTTP 接口；
  需要脚本算坐标时用 `cad.mjs measure`。贴合图元的量请用界面底部工具条。
- **自定义对象解析覆盖**（`udo --coverage`）走 CLI 的进程调用，没有 HTTP 接口。
- 界面顶栏「导出 → PNG」是 **WebGL 截图**（含当前图层显隐、聚焦灰显、2×），没有对应 HTTP 接口。
  CLI 的 `export --to png` 走 cadcraft 渲染，画面与界面**不完全一致**。
- 图层显隐、双击亮显等交互状态只存在于浏览器会话，API 不持久化。
