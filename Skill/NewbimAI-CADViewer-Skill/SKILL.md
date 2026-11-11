---
name: NewbimAI-CADViewer-Skill
description: 用 CADViewer 读取、提问、对比、测量并转换本地 CAD 图纸（DWG/DXF）。当用户提到 DWG、DXF、CAD、图纸、看图、打开图纸、图层、图块/块统计、实体统计、文字/标注、图纸范围/尺寸、图纸对比/比对/差异、测量/距离/面积/角度、天正/T3/自定义对象（user-defined object），或要求导出转换渲染图纸（导出 PNG/PDF/DXF/SVG/JSON、转格式、出图预览）时使用；也用于回答“这张图里有什么/多少个/在哪一层/缺不缺内容”这类事实问题。
---

# NewbimAI CADViewer Skill

本机命令行 + 本机服务的 CAD 工具：读 DWG/DXF、统计图元、**图纸对比**、**测量**、**自定义对象解析（user-defined object）**、导出 PDF/PNG/DXF/JSON。
所有数字来自产品自己的解析链路（`server/scanner.js`、对比引擎），与界面同源。

**铁律：不要手写 DXF/DWG 解析，不要靠截图数数。** 事实一律取自本 CLI 的 JSON。

下面用 `<skill>` 表示本 Skill 目录（安装后通常是 `~/.config/opencode/skills/NewbimAI-CADViewer-Skill`，源码树里是 `Skill/NewbimAI-CADViewer-Skill`）。

```bash
node <skill>/scripts/cad.mjs <命令> [参数]     # 输出 JSON；失败时 stderr 是 {"error":"..."} + 退出码 1
node <skill>/scripts/cad.mjs doctor           # 先自检：ok / degraded / versions
```

## 能力地图

| 能力 | 入口 | 文档 |
|---|---|---|
| 读图与统计 | `open` `readout` `summary` `layers` `blocks` `text` `stats` | `references/answering.md` |
| **图纸对比** | `compare` | `references/compare.md` |
| **测量** | `measure` | `references/measure.md` |
| **自定义对象解析（天正）** | `udo`（`--coverage` 看解出/未解） | `references/udo.md` |
| 导出/转换 | `export --to dxf\|svg\|pdf\|json\|png` | `references/cli.md` |
| 运行中的 HTTP API | `serve` 后的 `/api/*` | `references/api.md` |
| 排障 | `doctor` + 日志 | `references/troubleshooting.md` |

机器可读清单（名称/版本/命令/依赖/最低 App 版本）在同目录 `skill.json`；版本号唯一事实源是 `server/package.json`。

## 1. 图纸对比

```bash
node <skill>/scripts/cad.mjs compare "旧图.dwg" "新图.dwg"
node <skill>/scripts/cad.mjs compare "旧图.dwg" "新图.dwg" --tolerance 0.01 --props color,layer
node <skill>/scripts/cad.mjs compare "旧图.dwg" "新图.dwg" --max-changes 20000
```

- 返回 `summary`（`added`/`removed`/`modified`/`unchanged`/`notCompared`/`truncated`）、`changeSets`、`changes`、`warnings`。
- `added` = 只在对比图；`removed` = 只在基准图；`modified` = 两侧都有但几何或属性不同。
- 对比走本机服务（会自动拉起）：需要 `server/index.js` + `web/dist`。轻量包没补全时报错，重跑 `install.ps1` / `install.sh`。
- 可编辑 `.docx` 报告**只在界面生成**（每条变更要 WebGL 截图）：顶栏「图纸对比」→ 比对 → 导出报告；命令行不伪造截图。
- 边界：只比**模型空间顶层实体**；块定义内部变化给 `block-redefined` 告警；不支持的实体计入 `notCompared`，**不会默认当成“没变”**；单次最多 5,000 条变更（`--max-changes` 可调）。
- 字段与语义以 `references/compare.md` 为准（与仓库 `docs/compare-contract.md` 一致）。

## 2. 测量

```bash
node <skill>/scripts/cad.mjs measure distance --points "0,0;3000,4000"     # 距离/Δx/Δy/方位角
node <skill>/scripts/cad.mjs measure length   --points "0,0;1000,0;1000,500"
node <skill>/scripts/cad.mjs measure area     --points "0,0;4000,0;4000,3000;0,3000"
node <skill>/scripts/cad.mjs measure angle    --points "1000,0;0,0;0,1000"  # a → 顶点 → c
```

- 单位是**图纸单位**（`$INSUNITS=4` 时为毫米）；与 `readout`/`text` 里的坐标同一坐标系，可直接对照。
- 坐标从 `readout` 的文字位置、`summary.extents`、或用户给的图纸坐标来；**不要**用屏幕像素换算。
- 贴合图元的量（墙厚、门窗洞宽、房间净面积）要用界面底部工具条：距离 / 连续长度 / 面积 / 角度 / 半径 / 坐标，带端点、中点、圆心、象限点、交点、线上最近点吸附。agent 可用内置浏览器按 `references/measure.md` 操作。

## 3. 自定义对象解析（user-defined object）

```bash
node <skill>/scripts/cad.mjs udo "天正图.dwg"              # 快速判定：level / classes / evidence
node <skill>/scripts/cad.mjs udo "天正图.dwg" --coverage   # 解出多少、未解多少、按类分布
```

- 本版能还原的自定义对象：**墙体**（双面墙线、墙端封口、转角接缝）、**门窗洞口**（含门扇与开启弧）、**文字**、**尺寸标注**；不装天正即可渲染。
- `level`：`objects`（确证有 `TCH_*` 类）/ `provenance`（只有天正制作痕迹，**不能说内容缺失**）/ `none`（未检出）。
- `--coverage` 只对 DWG 有效（需要原始文件）；DXF 只能判定类名。输出 `customObjects.total/decoded/undecoded/coveragePct/byKind`。
- **解不出的对象不绘制、不猜几何**；没装解析组件时功能整体降级，其余看图/统计/对比/导出照常。
- 解析组件是随完整包分发的闭源二进制（`bin/udo-cli/`，进程调用）；源码与构建清单不随 Skill 包分发。轻量包不含它，`doctor` 会把 `udo` 列进 `degraded`。
- 能否画、缺什么，一律以 `udo --coverage` 的数字回答，不要凭图层名或对象名前缀猜。

## 4. 标准流程（收到一张图纸）

```bash
node <skill>/scripts/cad.mjs open "图纸.dwg"        # 转 DXF → 起本机服务 → 返回可点链接 + 概要
node <skill>/scripts/cad.mjs readout "图纸.dwg" > readout.json   # 一次拿全量数据（不用截图）
node <skill>/scripts/cad.mjs close                  # 用完关；空闲 30 分钟也会自动退出
```

1. `open` 返回的 `urlMarkdown` 以**超链接**发给用户（必须一行，别贴裸 URL）。
2. 数字以 `readout` 的 JSON 为准：实体/图层/块/文字/范围/自定义对象判定。
3. 浏览器只在“用户要自己看”或“判断外观（排版/重叠/缺失）”时开一次；等左下状态条 `data-dxf-status=done` 再看，看完就停。
4. **不要擅自导出**：把 PDF / PNG / DXF / JSON 列成选项让用户选（PNG 只导一张）。
5. 服务只监听 `127.0.0.1`（除非显式设 `CADVIEWER_HOST=0.0.0.0`）；远端 agent 够不到就改走导出。

## 边界

- 只读本地文件；除非用户要求，不要把图纸上传到任何外部服务。
- 平台：Windows 完整功能且已实测；macOS/Linux 只保证 DXF 只读命令与 `json|dxf` 导出。
- 项目根查找：`--root` → `CADVIEWER_ROOT` → 脚本自身位置 → 当前目录；用安装脚本注册后无需任何变量。
- 缓存写在 `server/cache/skill/<sha1>/`（纯派生，可删）；用户原图在 `data/`，**不要删、不要提交**。
- 安装/打包/体积说明见包内 `README`（仓库 `Skill/README.md`）；接口字段见 `references/cli.md` 与 `references/api.md`。
