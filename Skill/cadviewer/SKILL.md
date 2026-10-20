---
name: cadviewer
description: Read, inspect, question and convert local CAD drawings (DWG/DXF) using CADViewer, the viewer in this repository. Use when the user mentions DWG, DXF, CAD, 图纸, 看图, 打开图纸, 图层, 图块/块统计, 实体统计, 文字/标注, 图纸范围/尺寸, 天正/T3/TCH, or asks to export/convert/渲染 a drawing (导出 PNG/PDF/DXF/SVG/JSON, 转格式, 出图预览), or asks any factual question about the contents of a CAD file — how many blocks/layers/entities, what a block's reference count is, what text is inside, whether the drawing is complete, etc.
---

# CADViewer — read, question and convert DWG/DXF

This repository **is** a CAD viewer (`CADViewer`): a local Node server + WebGL front-end that reads
DWG/DXF, plus a headless pipeline (cadcraft-cli + our own streaming DXF scanner) that answers
questions about a drawing without opening any UI.

**Golden rule: never hand-roll DXF/DWG parsing, and never eyeball a drawing by screenshot alone.**
Every factual answer must come from `scripts/cad.mjs`, which reuses the product's own scanner — so the
numbers you report are the *same numbers the UI shows*.

**示例数据**：本文档与参考文档里的图纸名、图层名、图块名及统计数字均为虚构示例，不代表任何真实图纸。

**平台支持**：Windows 为完整功能且**已实测**（DWG 转换、四类导出、`serve` 起界面）。macOS / Linux 下可用的是 DXF 只读命令（`summary` `layers` `blocks` `text` `stats` `tch`）与 `export --to json|dxf`；DWG 转换与 `svg|pdf|png` 导出依赖 cadcraft（上游有 Windows 与 macOS 构建，本项目仅在 Windows 实测），`serve` 依赖 `start.bat`，在非 Windows 上不可用。

## Setup (once)

```bash
# 1. the converter binary is not in the repo (~127MB unpacked).
#    download `cadcraft-<ver>-windows-x64-portable.zip` from
#    https://github.com/storytold/cadcraft/releases
#    unzip so that this exists: <repo>/bin/cadcraft/**/cadcraft-cli.exe
#    (verified with 0.7.0 and 0.8.0; DXF-only commands need no cadcraft)

# 2. sanity check (tells you if root/cadcraft/fonts are found)
node Skill/cadviewer/scripts/cad.mjs doctor

# 3. 需要界面/浏览器时，一条命令确保服务在跑（没起会用 start.bat 拉起并等就绪）
node Skill/cadviewer/scripts/cad.mjs serve          # → {"ok":true,"url":"http://127.0.0.1:3717", ...}
node Skill/cadviewer/scripts/cad.mjs serve --status # 只查不启动
```

The CLI finds the project root in this order: `--root <dir>` → env `CADVIEWER_ROOT` → walk up from
the current directory. If it cannot find it, it errors out with the exact flag to pass — it never guesses.

## Answering questions about a drawing

Start with `summary` — it is a single digest that answers most questions on its own:

```bash
node Skill/cadviewer/scripts/cad.mjs summary "<图纸目录>\示例图纸.dwg"
```

| The user asks | Run | Then read |
|---|---|---|
| 这张图里有什么 / 多大 / 多少实体 | `summary <file>` | `entities.byType`, `extents`, `header` |
| 有多少图块 / 哪个用得最多 | `blocks <file>` | `refCount` 降序；**别忘匿名块已并入原块**（见下） |
| 有哪些图层 / 每层多少实体 | `layers <file>` | 默认只列**有实体**的层（与界面一致）；`--all` 看全部 |
| 图上有没有某段文字 / 在哪一层 | `text <file> --find "TAG"` | `samples` 给了图层/坐标/字高 |
| 这条编号/设备名出现了几次 | `text <file> --find "TAG-01"` | `matched` + `byLayer` |
| 是不是天正图 / 内容会不会缺 | `tch <file>` | `level`（见下） |
| 完整元数据（给程序用） | `stats <file>` | 原始 `scanDxf` 输出 |

### 三条必须记住的口径（否则你会给错答案）

1. **匿名块不单独显示，已并入原块。** 动态块实例（`*U1`…）在统计里被合并回**原块名**，
   `refCount` 已累加，`anonymousRefCount` 说明其中多少来自实例、`aggregatedFrom` 列出被并入的匿名块名。
   例：`BLOCK_C` 显示 `refCount: 4`，`aggregatedFrom: ["*U1","*U2",…]` —— 意思是"BLOCK_C 有 4 个实例，
   它们以 4 个动态块表示块的形式存在"。**不要**再去找 `*U1` 这样的行，它不存在。
   无法溯源的匿名块（`A$C…` 这类）被隐藏，只有计数 `anonymousHiddenCount`。
2. **`entityCount` 是"块定义内部的实体数"，不是"图上出现了多少个"。** 出现次数看 `refCount`。
3. **天正（Tianzheng）图纸**：本版**不解析** `TCH_*` 自定义对象。
   `tch.level` = `objects`（DXF 类名里确证有 `TCH_*`，几何/文字**可能确实缺失**）／`provenance`
   （只能证明"这张图是天正画的"，**不能断言内容有缺失**）／`none`。
   只有 `objects` 才建议用户"在天正中导出 T3 后再打开"；`provenance` 不要写成"内容缺失"。
4. **未使用的块定义默认不显示。** `refCount` 只数**顶层 INSERT**；一个块 `refCount=0` 仍可能被
   **别的块内部**引用（`nestedRefCount>0`）。实测规律：`refCount=0` 的块里多数属于这种
   （例：40 个中有 35 个；如 `$equip$00000000` ref=0 / nested=8）。
   判据是 **`refCount>0` 或 `nestedRefCount>0`**；两者都为 0 才是 `PURGE` 残留，列表不显示。
   所以"列表里没有某个块" **≠** "文件里没有这个定义"——`blocks --all` 可看全部，
   `summary.blocks.unused` 给未使用数量。

## Exporting / converting

```bash
node Skill/cadviewer/scripts/cad.mjs export <file> --to dxf  --out out.dxf
node Skill/cadviewer/scripts/cad.mjs export <file> --to svg  --out out.svg
node Skill/cadviewer/scripts/cad.mjs export <file> --to pdf  --out out.pdf
node Skill/cadviewer/scripts/cad.mjs export <file> --to json --out stats.json
node Skill/cadviewer/scripts/cad.mjs export <file> --to png  --out preview.png   # 见下
```

| 格式 | 是什么 | 什么时候给用户 |
|---|---|---|
| `dxf` | **原始** DXF（DWG 走 cadcraft 转换产物；DXF 输入就是源文件），交给 CAD 软件打开不会缺东西 | "要能继续编辑/给别人用 CAD 打开" |
| `svg` | cadcraft 导出的矢量图，**文字是描边路径** | "给 Illustrator / 印刷 / 网页用" |
| `pdf` | **矢量 PDF**（cadcraft SVG → 本项目的 SVG→PDF），单页 A3，文字同样已转轮廓，**不嵌字体** | "打印 / 审图 / 放大不糊" |
| `json` | 结构化统计（等同 `stats`） | "给程序读 / 存档" |
| `png` | 预览位图。**headless 走 cadcraft**；想要"和界面一模一样（含当前聚焦灰显、2×）"要用界面里的导出按钮 | "发人看" |

**导出与字体授权**：项目随包只带 **SIL OFL** 的 `Noto Serif SC`（`web/public/fonts/`），
**绝不**使用或分发 Windows 系统字体（`simfang` 等）。PDF/SVG 里文字是轮廓，不嵌字体，因此导出文件可自由分发。

## 可视化：用你自己的内置浏览器打开（推荐）

Agent 通常自带浏览器（playwright / browser MCP）。CADViewer 是**本机 HTTP 应用**，所以可以直接在
浏览器里打开一张图 —— 这是"看到图纸"最完整的方式：真实 WebGL 渲染、随包字体、右侧
「概览 / 图层 / 图块」面板、左下状态条全都在。

### 步骤

1. **确保服务在跑**（只监听 127.0.0.1，不上云）：
   ```bash
   node Skill/cadviewer/scripts/cad.mjs serve
   # 没起会自动用 start.bat 拉起并等就绪 → {"ok":true,"running":true,"url":"http://127.0.0.1:3717", ...}
   ```
   `serve --status` 只查不启动。手动方式：`<repo>\start.bat`；端口被占用时 `set PORT=3727`。
   返回 `{"ok":true, ...}` 才算就绪，否则不要继续截图。

2. **用绝对路径直接打开**（`?open=` 接受本机**任意绝对路径**，不需要先把文件放进项目）：
   ```
   http://127.0.0.1:3717/?open=<URL 编码后的绝对路径>
   ```
   PowerShell 编码：`[uri]::EscapeDataString("<图纸目录>\示例图纸.dwg")`
   实测项目外的临时路径（`<任意本地路径>\test7.dxf`）可直接打开 —— 用户"上传"给你的文件，
   落到本机临时目录后照此打开即可。

3. **等加载完成再截图**：左下状态条带 `data-dxf-status` 属性，等它变成 `done`。
   大图首次要转换（十几秒），之后走缓存秒开。**不要用固定延时硬等**，也不要截到 `fetch/parse` 中间态。

4. **按需截图**：
   - 截整页：能看到右侧面板（实体类型分布、图层列表、图块统计、天正提示）+ 状态条；
   - 只截画布（`canvas` 元素）：看图形本身。
   喂给用户的"这是你的图"用整页；"这一层/这个块长什么样"用画布。

### 在浏览器里还能做（都等价于用户手动操作）
- 切「概览 / 图层 / 图块」页签；点图层开关；
- **双击图层/图块行 = 聚焦（该项亮显、其余灰显），单击还原** —— 回答"这 350 个 BLOCK_A 在哪一层"这类问题很快；
- 左侧竖排工具条：放大 / 缩小 / 适应窗口 / 全图（`title="放大"` 等）；
- 顶栏「导出」下拉：**PNG（当前视图、白底、2×）/ JSON / DXF / PDF**。
  想要"和界面一模一样"的图（含当前灰显状态）就走这里的 PNG，而不是 headless 渲染。

### 限制（必须知道）
- **浏览器只能访问本机**：`127.0.0.1` 的服务 + 本机路径。文件在远端/沙箱里时，先把字节落到本机临时目录。
- `?open=` 读的是**服务进程可访问的路径**，不是浏览器上传；浏览器里选文件走的是
  `POST /api/open` 的 multipart（agent 一般用不到）。
- 服务没起 → 页面打不开；`/api/health` 不通就是没起。
- **截图用来看形状/布局，事实数字仍以 `scripts/cad.mjs` 为准**（别从截图里数数）。

### 什么时候不该开浏览器
只想回答"多少块/多少层/有没有某段文字/是不是天正图"这类问题时，`summary` / `blocks` / `text` 更快、
更准（而且是界面同源数据）；浏览器留给"看起来对不对""排版有没有问题""这层/这块是哪些"。

## 打开给用户看的界面

```bat
<repo>\start.bat
```
然后 <http://127.0.0.1:3717>（只有本机监听，不上云）。端口可用 `set PORT=3727` 覆盖。
界面上：滚轮缩放、图层显隐、**双击图层/图块行亮显（单击还原）**、右侧概览/图层/图块面板、
顶栏「导出」下拉（PNG / JSON / DXF / PDF）。

## 需要 HTTP API 时

运行中的服务暴露：`POST /api/open`、`GET /api/file/:id/dxf[?focus=layer:..|block:..]`、
`/api/file/:id/pdf`、`/api/health`。详见 `references/api.md`。

## 其它参考

- `references/answering.md` — 常见问题的问法/答法（含容易答错的坑）
- `references/troubleshooting.md` — cadcraft 未部署 / 缓存 / 端口占用 / 字体格式

## 边界

- 只读本地文件；除非用户要求，不要把这些文件上传到任何外部服务。
- `bin/cadcraft/`、`server/cache/`、`data/` 都不在仓库里：第一个需自行下载；`server/cache/` 是纯派生缓存（可随时删）；`data/` 才是用户原图（**不要提交**，也不要在排障时删）。
- 回答"图上有没有 X"这类问题时，先 `summary`/`text --find` 拿证据，不要凭文件名或扩展名猜。
