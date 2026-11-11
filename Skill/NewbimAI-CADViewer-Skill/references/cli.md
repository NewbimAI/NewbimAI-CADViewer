# CLI 契约（`scripts/cad.mjs`）

唯一入口。stdout 永远是 **一个 JSON**；失败时 stderr 是 `{"error":"…"}` 且退出码 1。
机器可读的能力/命令清单见同目录上层 `skill.json`（本文件是给人读的对照表）。

## 公共约定

- 命令：`node <skill>/scripts/cad.mjs <command> [args] [--options]`
- 项目根查找：`--root <dir>` → `CADVIEWER_ROOT` → 脚本自身位置向上 → 当前目录向上；判据是存在 `server/scanner.js`。
- 缓存：`<root>/server/cache/skill/<sha1(源文件绝对路径) 前 12 位>/`（`converted.dxf`、默认导出产物）。
- 版本：`skillVersion` 与 `appVersion` 都来自 `server/package.json#version`（打包时注入到 `skill.json`）。

## 命令表

| 命令 | 用法 | 起服务 | 主要输出 |
|---|---|---|---|
| `doctor` | `doctor` | 否 | `ok`、`degraded[]`、`versions`、`checks[]` |
| `open` | `open <file> [--port N]` | 是 | `url`、`urlMarkdown`、`dxf`、`digest`、`next[]` |
| `serve` | `serve [--status] [--foreground] [--port N]` | 是 | `ok`、`running`、`url`、`host`、`lanUrls` |
| `close` | `close [--port N]` | 否 | `ok`、`stopped` |
| `summary` | `summary <file>` | 否 | 实体/图层/块/文字/范围/`udo`/`warnings` |
| `readout` | `readout <file> [--limit N]` | 否 | 全量可读 JSON（文字去重、块/图层清单、范围） |
| `stats` | `stats <file>` | 否 | 扫描器完整原始输出 + `udo` + `header` |
| `layers` | `layers <file> [--all]` | 否 | `[{name,colorHex,entityCount,frozen,off,locked}]` |
| `blocks` | `blocks <file> [--min-ref N] [--limit N] [--all]` | 否 | `[{name,refCount,nestedRefCount,entityCount,…}]` |
| `text` | `text <file> [--find <子串>] [--layer <名>] [--limit N]` | 否 | `total`、`matched`、`byLayer`、`samples[]` |
| `udo` | `udo <file> [--coverage]` | 否 | `judgement`、`decoder`、`customObjects` |
| `compare` | `compare <base> <target> [opts]` | 是 | `summary`、`changeSets`、`changes`、`warnings` |
| `measure` | `measure <kind> --points "x,y;…"` | 否 | 见 `references/measure.md` |
| `export` | `export <file> --to dxf\|svg\|pdf\|json\|png [--out <path>]` | 否 | `out`、`bytes`、格式相关字段 |

`--port` 也支持环境变量 `PORT`；`--foreground` 给会回收 detached 后台进程的沙箱。

## `doctor` 输出

```json
{
  "ok": true,
  "degraded": ["fonts"],
  "versions": { "appVersion": "0.3.0", "skillVersion": "0.3.0",
                "versionSource": "server/package.json#version",
                "minAppVersion": "0.3.0", "sameVersion": true, "satisfiesMin": true },
  "checks": [ { "check": "node", "required": true, "ok": true, "detail": "v20.x" } ]
}
```

| check | required | 失败影响 |
|---|---|---|
| `node` | 是 | 版本低于 20 |
| `project-root` | 是 | 找不到 `server/scanner.js` |
| `cache` | 是 | 无法写缓存 |
| `skill-manifest` | 是 | `skill.json` 读不到或 `name` 不对 |
| `cadcraft` | 否 | DWG 转换、`svg\|pdf\|png` 导出 |
| `ui` | 否 | `open` / `serve` / `compare` |
| `fonts` | 否 | 界面文字渲染（CLI 不读字体） |
| `udo` | 否 | 自定义对象解析（`udo --coverage`） |
| `skill-version` | 否 | Skill 与 App 版本不一致（提示重跑安装） |

## 退出码

| 场景 | 退出码 |
|---|---|
| 成功 | `0` |
| 参数/文件/解析错误 | `1`（stderr `{"error":…}`） |
| 安装脚本：全部注册目标都被跳过 | `2`（仅 `install.ps1` / `install.sh`） |

## 不做的事

- 不修改 `server/**`、`web/**`、`start.bat`；只读 import 服务端模块。
- 不引入新的 npm 依赖（只用 Node 内置 + 仓库现有模块）。
- 不擅自导出：`open` 只给链接与概要，导出由用户选。
