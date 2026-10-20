# 常见问答：问法 → 命令 → 口径

先跑 `summary`，它一次给全大部分答案。只有需要完整列表/原文时才下钻到 `blocks`、`layers`、`text`、`stats`。

```bash
node Skill/cadviewer/scripts/cad.mjs summary "<图纸目录>\某图纸.dwg"
```

> 回答里引用数字时，注明它来自 CLI（与界面同一套 `server/scanner.js`），不要凭截图或文件名猜。

> 本文档中的图纸名、图层名、图块名与统计数字均为**虚构示例数据**，不代表任何真实图纸。

---

## 1. 这张图里有什么？多少实体？多大？

**命令**：`summary <file>`

看这些字段：

| 字段 | 含义 |
|---|---|
| `entities.total` | 模型空间 + 图纸空间的顶层实体数（INSERT 只算 1 个，不含块内实体；`ATTRIB/SEQEND/VERTEX` 是附属记录，不计） |
| `entities.byType` | 前 15 种实体类型（完整表用 `stats`） |
| `extents` | 图纸范围（来自 `$EXTMIN/$EXTMAX`，可能含飞点） |
| `contentBox` | 主体内容盒（密集区）；`null` 表示图太小/太散，退回 `extents` |
| `header.version` | DXF 版本（如 `AC1032`） |
| `header.insunits` | 插入单位：`4` = 毫米，`0` = 未指定/单位无关 |

**答法示例**：

> 这张图有 1200 个顶层实体（800 个 TEXT、350 个 INSERT、50 个 LWPOLYLINE），
> 范围约 24000 × 12000 图纸单位，`$INSUNITS=4`（毫米）。

**易错**：

- `entities.total` **不是**“所有图元总数”：块内实体不展开，所以 350 个 `BLOCK_A` 只算 350 个 INSERT，不是 350×(块内实体数)。
- `extents` 可能被远处飞点撑大；想知道“主要内容占多大”看 `contentBox`；`contentBox` 为 `null` 不代表图是空的。

---

## 2. 有几个图层？每层多少实体？

**命令**：

```bash
node Skill/cadviewer/scripts/cad.mjs layers <file>        # 默认：只列有实体的层（与界面一致）
node Skill/cadviewer/scripts/cad.mjs layers <file> --all  # 含空层
```

**口径**：

- `entityCount` 是**模型空间/图纸空间顶层实体**在该层的数量。
- 默认过滤 `entityCount > 0`；`--all` 才包含“图层表里有、但图上没用”的层。
- `frozen` / `off` / `locked` 来自图层表标志；`off` 也覆盖负颜色（图层关闭）。
- `summary.layers.total` 是图层表总数，`summary.layers.nonEmpty` 是有实体的层数。

**答法示例**：

> 图层表共 20 层，其中 12 层有实体；实体最多的是「LAYER_A」和「LAYER_B」，各 350 个。

**易错**：用户问“多少图层”时，先确认他要的是“图层表总数”还是“有内容的层”。界面默认只显示非空层，直接答非空数更贴近他的观感。

---

## 3. 有多少图块？哪个用得最多？某个块出现了几次？

**命令**：

```bash
node Skill/cadviewer/scripts/cad.mjs blocks <file>
node Skill/cadviewer/scripts/cad.mjs blocks <file> --min-ref 1
node Skill/cadviewer/scripts/cad.mjs blocks <file> --limit 20
```

**两个计数，别混**：

| 字段 | 含义 |
|---|---|
| `refCount` | 这张图里**顶层** INSERT 引用了该块多少次（“图上出现了几个”） |
| `nestedRefCount` | 被**别的块定义内部**的 INSERT 引用了多少次（“它嵌在别的块里用”） |
| `entityCount` | **块定义内部**有多少实体（“这个块本身由几个图元画成”） |
| `anonymousRefCount` | `refCount` 中来自动态块匿名表示（`*U…`）的部分 |
| `aggregatedFrom` | 被并入的匿名块名（如 `*U1…*U4`） |
| `defined` | 本图是否存在该块的 BLOCK 定义；`false` 表示只被引用、定义不在本图 |
| `used` | 本图是否真的用到：`refCount>0` **或** `nestedRefCount>0`。两者都为 0 才是 `PURGE` 残留，**列表默认不显示** |
| `isLayout` | 布局块（模型/图纸空间），正常不会出现在列表 |

**匿名块口径（最容易答错）**：

动态块实例在 DXF 里是 `*U1`、`*U2` 这样的匿名块。扫描器**已经把它们并回原块名**：

```json
{
  "name": "BLOCK_C",
  "refCount": 4,
  "anonymousRefCount": 4,
  "aggregatedFrom": ["*U1", "*U2", "*U3", "*U4"]
}
```

意思是：**「BLOCK_C」在图上出现 4 次，这 4 次都以动态块匿名表示的形式存在。**
正确说法：“BLOCK_C 有 4 个实例（由 4 个动态块表示）”。
错误说法：“图里没有 BLOCK_C，只有 *U1…”或“BLOCK_C 缺失”。

- 不要再去找 `*U1` 这样的**行**——`blocks` 结果里不会有以 `*` 或 `A$` 开头的 `name`。
- `aggregatedFrom` 里出现 `*U1` 是正常的溯源信息，不是“匿名块没处理”。
- 无法溯源的匿名块（`*D` 标注、`*T` 表格、`A$C…` 复制块、孤儿 `*X` 填充）被隐藏，只汇总为 `blocks.hiddenAnonymous`（summary）或 `anonymousHiddenCount`（stats）。**隐藏 ≠ 内容缺失**，只是无法确定原始块名。

**未使用的块定义也不显示（第二个容易答错的地方）**：

`refCount=0` **不等于**“这张图没有这个块”——它只说明没有**顶层** INSERT，块定义仍可能被别的块内部引用：

```json
{ "name": "$equip$00000000", "refCount": 0, "nestedRefCount": 8 }
```

实测规律：`refCount=0` 的块里多数属于这种（例：40 个中有 35 个）；只按 `refCount` 过滤会**凭空隐藏这些正在用的块**。

- 显示判据：**`refCount>0` 或 `nestedRefCount>0`**；两者都为 0 才是 `PURGE` 残留。
- 想知道文件里到底有多少块定义：`summary.blocks.named`（含未使用），或 `blocks --all` 看全部。
- 所以“列表里没有某个块” **≠** “文件里没有这个定义”——回答时要区分“没被使用”和“定义不存在”。

**答法示例**：

> 图块共 6 个具名块；引用最多的是「BLOCK_A」350 次、其次「BLOCK_B」20 次、「BLOCK_C」4 次（后者 4 次都是动态块表示，已并入统计）。

---

## 4. 图上有没有某段文字？在哪一层？出现几次？

**命令**：

```bash
node Skill/cadviewer/scripts/cad.mjs text <file> --find "TAG"
node Skill/cadviewer/scripts/cad.mjs text <file> --find "TAG-01" --layer "LAYER_B"
node Skill/cadviewer/scripts/cad.mjs text <file> --find "TAG" --limit 200
```

**返回**：

| 字段 | 含义 |
|---|---|
| `total` | 全图 TEXT/MTEXT 实体总数（未过滤） |
| `matched` | 满足 `--find` / `--layer` 的条数 |
| `byLayer` | 命中文字按图层计数 |
| `samples[]` | 前 `limit` 条命中（默认 50），含 `layer/text/x/y/h/style/rotation` |

`--find` 是**不区分大小写的子串**匹配，支持中文；`%%C/%%D/%%P` 与 MTEXT 格式码会被清理成可读文本。

**答法示例**：

> 图上有 4 处含“TAG”的文字，全部在「LAYER_C」层，例如“TAG 总数: 350 台”（x=1234.56, y=789.01，字高 2.5）。

**易错 / 边界**：

1. `text` 只扫 **ENTITIES 段**的顶层 `TEXT/MTEXT`。**块定义内部的文字不计**（它们要按每个 INSERT 的变换展开，不能直接按定义坐标统计）。因此 `matched=0` 只能说明“顶层没有这段文字”，不能 100% 证明图面上看不到——块内文字要用界面/`block-text` 链路才能确认。
2. 过滤前先看 `total`。如果 `total=0`，说明这张图的文字不在 ENTITIES（可能全在块里，或压根没有文字实体）。
3. `--layer` 是整层名精确匹配（不区分大小写），不是子串。
4. 坐标是 DXF 图纸坐标，不是屏幕像素；字高也按图纸单位。

---

## 5. 是不是天正图纸？内容会不会缺？

**命令**：

```bash
node Skill/cadviewer/scripts/cad.mjs tch <file>
```

`level` 只有三档，**口径必须严格对应**：

| `level` | 证据 | 能说什么 | 不能说什么 |
|---|---|---|---|
| `objects` | 扫描用 DXF 的 CLASSES 段**确证**有 `TCH_*` 类名 | 本版不解析天正自定义对象，几何/文字**可能确实缺失**；建议在天正中导出 T3 后再打开 | —— |
| `provenance` | 未确证对象，但在样式/图层/块名里发现天正痕迹（`_TCH_*`、`$TCH*`、`$TwtSys$*`） | “这张图由天正绘制 / 带天正制作痕迹” | **不能说“内容缺失”**（cadcraft 已把能转的都转了，痕迹不等于缺对象） |
| `none` | 两者都没有 | “未检出天正特征” | 不能断言“绝对不是天正画的”（证据不足只代表没发现） |

**答法示例**：

- `objects`：
  > 这是天正图，DXF 里确证到 TCH_* 对象；当前版本不解析这些自定义对象，图面/文字可能缺失。建议用天正导出 T3 格式后再看。
- `provenance`：
  > 这张图带天正绘制痕迹（如 `_TCH_DIM`、`_TCH_LABEL`），说明它由天正制作；但没有确证到 TCH_* 对象，**不能据此说内容缺失**。

**易错**：不要因为 `classes` 为空就否定天正；cadcraft 常常在转换时丢掉 `TCH_*` 类，`provenance` 就是为这种情况准备的。

---

## 6. 要能继续编辑 / 给别人用 CAD 打开 → 导出 DXF

```bash
node Skill/cadviewer/scripts/cad.mjs export <file> --to dxf --out out.dxf
```

- DWG：导出 cadcraft 的 `converted.dxf`；DXF：直接复制源文件。
- 这是**原始** DXF，不删 ATTRIB、不展平块文字、不重画表格。
- 不要拿服务端 `/api/file/:id/dxf`（不带 `raw=1`）的产物给别人——那是 WebGL 派生文件。
- 返回值含 `sha256`、`bytes`、`source`（`original-dxf` / `converted-from-dwg`）。

---

## 7. 要打印 / 放大不糊 → 导出 PDF / SVG

```bash
node Skill/cadviewer/scripts/cad.mjs export <file> --to pdf --out out.pdf
node Skill/cadviewer/scripts/cad.mjs export <file> --to svg --out out.svg
```

- PDF 是矢量单页（A3 横向），链路与界面「导出 → PDF」一致：cadcraft SVG → `server/svg-pdf.js`。
- SVG/PDF 里的文字是**轮廓路径**，不可再编辑，也不嵌字体（因此可自由分发）。
- 取景用 `contentBox`（缺失时 `coreExtents`），会裁掉远处飞点，和界面导出一致。

---

## 8. “发人看” / 我要先看看图 → PNG

```bash
node Skill/cadviewer/scripts/cad.mjs export <file> --to png --out preview.png
```

- headless 走 cadcraft 渲染（2400×1600），适合快速预览。
- **与界面截图不完全一致**：界面导出是 WebGL 截图，包含当前图层显隐、聚焦灰显、2× 分辨率。
- 如果 cadcraft 版本不支持，CLI 会明确报错，并提示改用界面「导出 → PNG」，不会伪造成功。

---

## 9. 需要完整元数据 / 给程序读

```bash
node Skill/cadviewer/scripts/cad.mjs stats <file>
node Skill/cadviewer/scripts/cad.mjs export <file> --to json --out stats.json
```

`stats` = `scanDxf` 的完整原始输出 + `tch` + `header`。`summary` 里的 `top` 只截前 10/15，完整列表以 `stats` 为准。

---

## 10. 结果里出现 warnings 时怎么转述

| warning 关键词 | 含义 | 建议说法 |
|---|---|---|
| `TCH_* 对象` / `天正自定义对象` | `tch.level=objects`，可能真缺几何 | 建议 T3 重导 |
| `缺少可用的 $EXTMIN/$EXTMAX` | 没有图纸范围 | 只报实体/图层，别编尺寸 |
| `模型空间未扫描到实体` | 空白图或转换失败 | 先 `doctor`，再确认文件 |
| `只被引用但本图没有块定义` | 例如 `BLOCK_X` 只被 INSERT 引用 | 说“块定义不在本图（可能来自外部参照）”，别说“图块不存在” |
| `cadcraft 跳过 N 个实体` | 代理对象等未转换 | 统计可能少于图面，明确告知 |

---

## 快速对照表

| 用户问 | 跑 | 关键字段 |
|---|---|---|
| 这张图有什么/多少实体 | `summary` | `entities.total`, `entities.byType` |
| 有多大 | `summary` | `extents`, `contentBox`, `header.insunits` |
| 多少图层/哪层最多 | `layers` | `entityCount`（默认非空） |
| 多少图块/哪个最多 | `blocks` | `refCount`（不是 `entityCount`） |
| 某块出现几次 | `blocks --min-ref 1` | `refCount`, `anonymousRefCount` |
| 有没有某段文字 | `text --find` | `matched`, `byLayer`, `samples` |
| 是不是天正/会不会缺 | `tch` | `level`, `classes`, `evidence` |
| 导出可编辑 DXF | `export --to dxf` | `source`, `sha256` |
| 打印 | `export --to pdf` | `bytes`, `pageWidth/Height` |
| 快速预览 | `export --to png` | `width`, `height` |
| 完整数据 | `stats` / `export --to json` | 全部 |
