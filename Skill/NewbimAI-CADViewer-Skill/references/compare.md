# 图纸对比（`compare`）

对比两张图纸的**实体级差异**：新增 / 删除 / 修改，按邻近关系聚成“变更集”，并给出未参与对比的告警。
引擎与界面「图纸对比」是同一套（字段契约见 `docs/compare-contract.md`）。

## 命令

```bash
node <skill>/scripts/cad.mjs compare "<基准图>" "<对比图>"
node <skill>/scripts/cad.mjs compare "<基准图>" "<对比图>" --tolerance 0.01
node <skill>/scripts/cad.mjs compare "<基准图>" "<对比图>" --props color,layer --include-hatch
node <skill>/scripts/cad.mjs compare "<基准图>" "<对比图>" --max-changes 20000 --limit 500
```

| 参数 | 默认 | 含义 |
|---|---|---|
| `--tolerance` | `0.001` | 位置容差（图纸单位）：两实体距离 ≤ 它才可能判为“同一实体被修改” |
| `--quantize` | `1e-6` | 指纹量化步长：坐标先量化再算哈希，避免“看起来一样、差一点点”被误判 |
| `--props` | `color,layer,linetype,lineweight` | 参与判定的属性；不列出的属性变化不算 `modified` |
| `--include-hatch` | 关 | 填充是否参与对比（默认不参与，计入 `notCompared`） |
| `--max-changes` | `5000` | 单次返回上限；超出时 `summary.truncated=true` |
| `--limit` | `200` | 本 CLI 输出里 `changes[]` 的条数（不影响 `summary` 与变更集统计） |
| `--port` | `3717`/`PORT` | 使用的本机服务端口 |

## 输出（节选）

```json
{
  "ok": true,
  "base":   { "id": "…", "name": "旧图.dwg", "entities": 9459 },
  "target": { "id": "…", "name": "新图.dwg", "entities": 9462 },
  "options": { "tolerance": 0.001, "quantize": 0.000001, "compareProps": ["color", "layer"], "includeHatch": false, "maxChanges": 5000 },
  "summary": { "added": 3, "removed": 1, "modified": 2, "unchanged": 9453,
               "notCompared": 12, "changeSets": 2, "elapsedMs": 812, "truncated": false },
  "changeSets": [ { "id": 0, "bbox": [0, 0, 1000, 1000], "count": 5, "kinds": { "added": 3, "removed": 1, "modified": 1 } } ],
  "changesTotal": 6,
  "changes": [ { "kind": "added", "type": "LINE", "layer": "0", "handleBase": null,
                 "handleTarget": "2F", "bbox": [0, 0, 100, 0], "setId": 0 } ],
  "warnings": [ { "code": "unsupported", "type": "HATCH", "count": 12 } ]
}
```

口径：

- `added` = 只在**对比图**；`removed` = 只在**基准图**；`modified` = 两侧都有，但指纹或属性不同。
- `unchanged` 是匹配成功的实体数；`notCompared` 是不支持/不参与的类型计数。
- `warnings` 里 `block-redefined` 表示块定义整体变了（引擎不递归块内部，逐条差异不可用）。

## 报告（`.docx`）

- 报告**只在界面生成**：顶栏「图纸对比」→ 选两张图比对 → 导出报告。生成的是可编辑 Word（封面统计 + 变更集分节 + 逐条变更截图 + 云线）。
- 服务端 `/api/compare/report` 要求**每条变更都带一张 PNG 截图**；命令行没有 WebGL 渲染能力，
  因此 CLI **不提供** `--report`，也不会用占位图冒充截图（那样等于交付假证据）。
- 需要报告时：`serve`/`open` 起界面 → 在内置浏览器里走「图纸对比」流程（界面操作要点见 `references/measure.md`）。

## 边界（必须如实转述）

1. 只比**模型空间顶层实体**；块定义内部差异整体给 `block-redefined` 告警。
2. 不支持的实体（无块定义的 DIMENSION、ACAD_TABLE、代理对象、默认情况下的 HATCH）计入 `notCompared`，**绝不会默认判为 unchanged**。
3. 单次最多 5,000 条变更；超大差异先调 `--max-changes`，仍不够就按区域/图层分批比。
4. 对比结果是“同一引擎口径”，但**不等于审图结论**：判定是否要改，仍由用户决定。

## 需要哪些组件

- `server/index.js`（对比接口）与 `web/dist`（界面）；轻量包由 `install.ps1` / `install.sh` 补回，完整包已内置。
- `doctor` 的 `ui` 为 `degraded` 时，`compare` 会直接报错并提示重跑安装脚本。
