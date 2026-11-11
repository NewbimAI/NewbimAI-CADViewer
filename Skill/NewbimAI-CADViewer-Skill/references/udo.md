# 自定义对象解析（user-defined object）

天正图纸里的墙、门窗洞口、文字、尺寸标注是**自定义对象**，普通 DXF 转换器会把它们静默丢掉（表现为“墙线/门窗成片消失”）。
本版按对象类型识别并还原成标准可渲染几何，不装天正、不装插件即可看图。

## 命令

```bash
node <skill>/scripts/cad.mjs udo "<图纸.dwg>"              # 快速判定
node <skill>/scripts/cad.mjs udo "<图纸.dwg>" --coverage   # 解出/未解出数量与按类分布
```

## 判定：`level`

| `level` | 证据 | 能说什么 | 不能说什么 |
|---|---|---|---|
| `objects` | 扫描用 DXF 的 CLASSES 段确证有 `TCH_*` / `AEC_*` 类名 | “这是天正图，按自定义对象解析” | —— |
| `provenance` | 只在样式/图层/块名里发现痕迹（`_TCH_*`、`$TCH*`、`$TwtSys$*`） | “这张图由天正绘制 / 带天正制作痕迹” | **不能说“内容缺失”** |
| `none` | 两者都没有 | “未检出天正特征” | 不能断言“绝对不是天正画的”（证据不足只代表没发现） |

## 覆盖：`--coverage`

```json
{
  "ok": true,
  "format": "DWG",
  "judgement": { "level": "provenance", "classes": [], "evidence": ["_TCH_DIM", "_TCH_WINDOW"] },
  "decoder": { "available": true, "component": "bin/udo-cli/udo-cli.exe", "used": true, "error": null },
  "customObjects": {
    "total": 2820,
    "decoded": 1051,
    "undecoded": 1769,
    "coveragePct": 37.3,
    "byKind": {
      "wall": { "label": "墙体", "decoded": 732 },
      "opening": { "label": "门窗洞口", "decoded": 319 },
      "text": { "label": "文字", "decoded": 0 },
      "dimension": { "label": "尺寸标注", "decoded": 0 }
    },
    "classes": ["AEC_WALL", "AEC_OPENING", "AEC_TEXT"],
    "classCount": 24,
    "detected": true
  },
  "notes": ["未解出的对象不会被绘制，也不会用占位几何冒充；这是能力边界，不是“文件损坏”。"]
}
```

| 字段 | 含义 |
|---|---|
| `customObjects.total` | 该 DWG 的自定义对象总数（按对象统计，不是按图元） |
| `decoded` / `undecoded` | 已还原 / 未还原数量；`coveragePct` 是占比 |
| `byKind` | 只有列出的类有解码器：`wall`（墙体）、`opening`（门窗洞口）、`text`（文字）、`dimension`（尺寸标注） |
| `decoder.*` | 解析组件是否可用、是否真的跑过、失败原因 |
| `judgement.*` | DXF 侧判定（快速、不依赖组件） |

## 能画什么、画到什么程度

- **墙体**：双面墙线（不只轴线）、墙端封口、转角接缝；洞口处按实际位置裁剪。
- **门窗洞口**：洞口矩形边线；门扇与 90° 开启弧（半径按洞宽推算）。
- **文字**：单行/多行按插入点还原（GBK 内容按文件编码解码）。
- **尺寸标注**：尺寸线/界线/箭头；有样式记录时连数值文字一起还原，缺样式时**只画几何、不猜文字**。
- **块内对象**：按“所属块 + 插入点”还原；同一个平面被插入两次就给两份完整几何。

## 边界（转述给用户时必须保留）

1. **解不出的对象不绘制、不猜几何**：不显示，也不用占位文字/占位线冒充。
2. 弧形墙在没有弧参数时按直墙两面线绘制（可能显示为弦线）；镜像/旋转块引用按规则降级。
3. `--coverage` 只对 **DWG** 有效：DXF 侧的自定义对象已被转换器丢掉，只能判定类名。
4. 没有解析组件（`bin/udo-cli/`）时：不注入自定义对象几何，其余看图/统计/对比/导出照常；`doctor` 的 `udo` 会进 `degraded`。
5. 解析组件是随**完整包**分发的闭源二进制，只做进程调用；Skill 包内不含其源码、构建清单或构建产物目录。

## 组件从哪来

| 安装方式 | 是否含解析组件 | 怎么补 |
|---|---|---|
| 完整包（`*-full-<ver>.zip`） | 含 `bin/udo-cli/udo-cli.exe` 与 `licenses/` 许可附件 | 解压即用 |
| 轻量包 / 源码仓库 | 不含（仓库也不提交二进制） | 取完整包，或把 `udo-cli.exe` 放到 `<项目根>/bin/udo-cli/` |

`doctor` 输出里的 `udo` 检查项就是这件事；`degraded` 里有 `udo` 表示“统计/对比照常，自定义对象不会画出来”。
