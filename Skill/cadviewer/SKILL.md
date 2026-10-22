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

## 标准流程（收到用户图纸后照这个走）

用户发来图纸时，**不要只回一段统计文字**。一条命令起头，然后按 5 步走：

```bash
node Skill/cadviewer/scripts/cad.mjs open "<图纸.dwg|dxf>"
```

返回（节选）：

```json
{
  "ok": true,
  "url": "http://127.0.0.1:3717/?open=%3C...%3E",
  "localUrl": "http://127.0.0.1:3717/?open=%3C...%3E",
  "host": "127.0.0.1",
  "lanUrls": [],
  "dxf": { "path": "...converted.dxf", "converted": true, "fromCache": false },
  "digest": {
    "entities": 9459,
    "layers": { "total": 142, "nonEmpty": 57 },
    "blocks": { "named": 162, "unused": 28 },
    "tch": { "level": "provenance" }
  },
  "next": ["用你的内置浏览器打开 url ...", "把 digest 讲给用户 ...", "..."]
}
```

1. **解析成 DXF**：`open` 内部完成。DWG 走 cadcraft，产物缓存在
   `server/cache/skill/<hash>/converted.dxf`，同一张图不会重复转换。
2. **拿到链接**：用返回的 `url`（`localUrl` 是本机地址，`lanUrls` 是局域网地址）。
3. **读数据用 `readout`（一次 JSON，不要靠截图）**：
   ```bash
   node Skill/cadviewer/scripts/cad.mjs readout "<图纸.dwg|dxf>" > readout.json
   ```
   一次拿到：实体总数与类型分布、图层清单（名字 + 实体数）、本图真用到的块（名字 + 引用次数）、
   **去重后的全部文字**（内容 + 出现次数 + 所在层 + 位置）、图纸范围、天正判定、告警。
   读这份 JSON 就能把图讲清楚。
   ❌ **不要**为了读数据去截图、放大、在画布上翻找文字——那些数据 JSON 里都有，而且又慢又容易看错。
   （`readout` 不起服务、不开浏览器；DWG 会复用已转换好的 DXF 缓存。）
4. **把链接做成超链接给用户**（用返回的 `urlMarkdown`）：
   - **同时在回复里把链接做成 Markdown 超链接给用户**（用返回的 `urlMarkdown`，
     例如 `[打开 CADViewer 界面](http://127.0.0.1:3717/?open=...)`）—— 这样在 agent
     界面里**点一下就能打开**，不要只贴一串裸 URL。
     ⚠️ **链接必须写在一行**：URL 里换行会把它从链接降级成普通文字，点了没反应。
     两种写法都行：行内链接 `[打开 CADViewer 界面](url)`，或自动链接 `<url>`。
     这是本机链接：**只有服务在跑的时候能打开**；端口默认固定 `3717`，
     下次 `serve` / `open` 起来后同一个链接又能用。
   - **浏览器默认不用开**。只有这两种情况才打开**一次**：
     ① 用户想自己看图；② 你要判断"看起来对不对"（排版错位、文字重叠、图框缺失这类**外观**问题）。
     打开后等左下状态条 `data-dxf-status` 变成 `done` 再看；**看完就停**——
     不要反复缩放、翻页、连拍多张图。
5. **总结给用户**：数字**一律以 `readout` 的 JSON 为准**，不要从截图里数。
   讲清楚：这是什么图（看文字/图名）、规模、图层构成、主要块、标注与尺寸数量、图纸范围、
   是不是天正图、需要注意什么。
6. **把下一步做成选项让用户选，不要擅自导出**：
   - ❌ **不要默认**跑 `export --to png` / `--to pdf`，也别为了"预览"顺手导一张；
   - ✅ 把下面的清单抛给用户（直接列选项，或弹窗让用户点），他选完再执行：
     - 打印 / 审图 → `export --to pdf`（A3 矢量）
     - 发人看 / 嵌文档 → `export --to png`（白色 2×）——**只导这一张**，
       不要导多张、不要放大截图再导、不要把同一张图拆成好几张发
     - 给别人用 CAD 编辑 → `export --to dxf`（原始 DXF）
     - 存档 / 给程序读 → `export --to json`（或直接用 `readout` 的 JSON）
     - 看某层 / 某块 → 界面里双击该行聚焦（比重新导出快得多）

**服务生命周期（不用你操心）**：`open` / `serve` 会**在后台静默启动**服务 ——
不弹控制台窗口、不打开系统浏览器、不占你的终端；命令返回后服务继续活着，
看完让 agent 跑一句就关：

```bash
node Skill/cadviewer/scripts/cad.mjs close
```

兜底还有**空闲 30 分钟自动退出**（`CADVIEWER_IDLE_EXIT_MIN` 可调，`0` = 不退出）。

- 只有 `open` / `serve` 会启动服务；`summary` `stats` `layers` `blocks` `text` `tch`
  `export` 全是**纯本地只读**，不会起服务、不留后台进程。
- 服务只监听 `127.0.0.1`（除非你显式设 `CADVIEWER_HOST`）。

**前提：先判断你的浏览器能不能访问那个地址。** 链接里的 `127.0.0.1` 指的是
**浏览器所在那台机器**：

| 你的位置 | 怎么做 |
|---|---|
| 和 CADViewer 同一台机器 | 直接用 `url` |
| 同一局域网、能路由到宿主机 | 启动前 `set CADVIEWER_HOST=0.0.0.0`，用返回的 `url`（优先 `lanUrls`） |
| 云端 / 沙箱，够不到那台机器 | 只能 `export --to png\|svg\|pdf` 把文件给用户看（这是网络边界，不是失败） |

## Setup (once)

**一条命令装完，装完就结束——不需要再做任何验证。**

```bash
# Windows
powershell -ExecutionPolicy Bypass -File Skill\install.ps1
# macOS / Linux
bash Skill/install.sh
```

脚本一次做完（幂等，可反复跑）：

1. 把 `Skill/cadviewer` 链接到 agent 的 skills 目录（OpenCode 总是；Claude Code / Cursor 存在则一并装）
2. 下载并解压 cadcraft（DWG 转换器，约 57MB；已存在则跳过）
3. 跑一次 `doctor` 并打印结果（`doctor: ok` / `doctor: NOT ok`）

**装完不要再做下面这些**（全是多余动作，会拖慢安装）：

- ❌ 找 / 下载图纸来“验证”——`doctor` 已经自检过；**不要**为验证去搜本机 DWG
- ❌ `npm install` / `vite build`——仓库自带 `web/dist`
- ❌ 手动起服务——`open` / `serve` 按需静默启动

`doctor: ok` 且 `degraded: ["fonts"]` 属正常（字体只给界面渲染用，CLI 不读）。

### 转换器 cadcraft（安装时一次装好）

DWG → DXF 靠它。**装好放着不占资源**——只有真的打开 DWG、或导出 `svg|pdf|png` 时才会被调用。

`install.ps1` / `install.sh` 会自动做下面两步（下载约 57MB）；离线或下载失败时会给出提示，
不阻塞 Skill 的 DXF 功能：

1. https://github.com/storytold/cadcraft/releases 下载 `cadcraft-<版本>-windows-x64-portable.zip`
2. 解压到 `<root>/bin/cadcraft/`，使 `<root>/bin/cadcraft/**/cadcraft-cli.exe` 存在

手动补装后重跑 `doctor`，`degraded` 里不再出现 `cadcraft` 即可。

### 起界面

```bash
node Skill/cadviewer/scripts/cad.mjs open "<图纸>"   # 转 DXF + 起服务 + 给链接（推荐）
node Skill/cadviewer/scripts/cad.mjs serve           # 只确保服务在跑
node Skill/cadviewer/scripts/cad.mjs close           # 用完关掉（空闲 30 分钟也会自动退出）
```

⚠️ 如果所在运行环境会**回收 detached 后台进程**（部分沙箱 / 托管环境），改用：

```bash
node Skill/cadviewer/scripts/cad.mjs serve --foreground
```

它把服务跑在**当前进程**里（前台、stdout 直通），交给 agent 的任务管理器保活；
输出里会给出 `url`，结束这个任务就停掉服务。

项目根查找顺序：`--root` → 环境变量 `CADVIEWER_ROOT` → **脚本自身位置** → 当前目录。

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

### 在别的 agent / 别的机器里打开（先判断属于哪种情况）

| 情况 | 能交互看图 | 做法 |
|---|---|---|
| **A. 同一台机器**（本机 CLI、本机桌面 agent） | ✅ | `serve` → `http://127.0.0.1:<port>/?open=<URL 编码的绝对路径>` |
| **B. 同一局域网、能路由到运行服务的那台机** | ✅ | 启动服务前 `set CADVIEWER_HOST=0.0.0.0`，再用 `health.lanUrls` 里的地址（如 `http://192.168.1.42:3717`） |
| **C. 云端 / 沙箱，网络到不了那台机** | ❌ | 只能导出给它看：`export --to png\|svg\|pdf\|json`，把产物交给它 |

判断方法：让那个 agent 访问 `http://127.0.0.1:<port>/api/health`。
- 通了 → 情况 A；
- 不通，但它有自己的 `127.0.0.1` → 它在自己的容器里（B 或 C，看能否路由到宿主机）。

`serve` 的返回里带 `host` 与 `lanUrls`：这份服务实际绑在哪个地址、有哪些局域网地址可用。

⚠️ `CADVIEWER_HOST=0.0.0.0` 会让**同网段任何人都能打开你的图纸**；只在需要时开，用完关掉。

### 限制（必须知道）
- **浏览器只能访问它所在的那台机器**：`127.0.0.1` 指的是"浏览器自己那台"，不是"你电脑那台"。
  远端/沙箱 agent 的内置浏览器打不开你本机的 3717 —— 这是网络位置问题，不是配置问题。
- `?open=` 读的是**服务进程可访问的路径**，不是浏览器上传；浏览器里选文件走的是
  `POST /api/open` 的 multipart（agent 一般用不到）。
- 服务没起 → 页面打不开；`/api/health` 不通就是没起。
- 远程浏览器（无 GPU / 软件渲染）里 WebGL 可能退化；画不出来就改用 `export --to png|svg`。
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
