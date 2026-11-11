# NewbimAI-CADViewer-Skill

给 agent 用的 CAD 工具：读 DWG/DXF、统计图元、**图纸对比**、**测量**、**自定义对象解析（user-defined object）**、导出 DXF/SVG/PDF/PNG/JSON。
所有数字都来自产品自己的解析链路（`server/scanner.js`、对比引擎），因此与界面看到的口径一致。

唯一入口：

```bash
node Skill/NewbimAI-CADViewer-Skill/scripts/cad.mjs <命令> [参数]
```

- 模型读的说明：`NewbimAI-CADViewer-Skill/SKILL.md`（薄，≤130 行）
- 机器可读清单：`NewbimAI-CADViewer-Skill/skill.json`（名称/版本/命令/依赖/最低 App 版本）
- 人读的细节：`NewbimAI-CADViewer-Skill/references/`（`cli` `compare` `measure` `udo` `answering` `api` `troubleshooting`）

---

## 目录

```text
Skill/
├── README.md                          ← 本文件：安装、打包、体积、边界
├── install.ps1                        ← Windows 一键安装（目录联接 + 补组件 + doctor）
├── install.sh                         ← macOS/Linux 对应脚本
└── NewbimAI-CADViewer-Skill/          ← 注册到 agent 的就是这个目录
    ├── SKILL.md                       ← 给模型：能力、入口、边界
    ├── skill.json                     ← 机器可读清单（版本由构建脚本注入）
    ├── scripts/
    │   ├── cad.mjs                    ← 唯一 CLI 入口（参数解析 + 分发）
    │   ├── manifest.mjs               ← 读 skill.json、解析版本（唯一事实源 server/package.json）
    │   └── commands/
    │       ├── compare.mjs            ← 图纸对比（调用本机服务，与界面同引擎）
    │       ├── measure.mjs            ← 坐标测量（纯算式，可单测）
    │       └── udo.mjs                ← 自定义对象判定 + 解析覆盖摘要
    └── references/                    ← cli / compare / measure / udo / answering / api / troubleshooting
```

---

## 依赖

> **只需要 Node.js 20+。** 仓库里已带构建好的前端 `web/dist`——不要 `npm install`、不要 `vite build`。

| 组件 | 谁需要 | 从哪来 |
|---|---|---|
| `server/*.js` | CLI 全部命令 | 仓库自带；轻量包只带 CLI 用到的模块，安装时补全 |
| `bin/cadcraft/**/cadcraft-cli.exe` | DWG 转换、`svg\|pdf\|png` 导出 | 安装脚本自动下载（约 57MB） |
| `server/index.js` + `web/dist` | `open` / `serve` / `compare` | 仓库自带；轻量包安装时下载补全（约 18MB） |
| `bin/udo-cli/udo-cli.exe` | `udo --coverage`（自定义对象解析） | **只在完整包里**；轻量包不含 |

没有 cadcraft：DXF 的统计/文字/图层/图块/对比照常，DWG 与图片/PDF 导出不可用（`doctor` 会点名）。
没有 udo-cli：其余能力照常，只是不注入自定义对象几何、`doctor` 的 `degraded` 里有 `udo`。

平台：**Windows 完整功能且已实测**；macOS/Linux 只保证 DXF 只读命令与 `json|dxf` 导出。

---

## 安装

```bat
:: Windows（在解压后的目录里）
powershell -ExecutionPolicy Bypass -File Skill\install.ps1
```

```bash
# macOS / Linux
bash Skill/install.sh
```

脚本做四件事（幂等，可反复跑）：

1. 把 `Skill/NewbimAI-CADViewer-Skill` 以**目录联接/软链接**注册到 agent 的 skills 目录
   （OpenCode `~/.config/opencode/skills` 总是装；检测到 Claude Code / Cursor 也一并装）；
2. 缺 cadcraft 时下载并解压（删除上游 GUI 主程序，只留 CLI）；
3. 缺界面/服务端时按 **`skill.json` 的版本**（源码树回退 `server/package.json`）取 `v<version>` 归档补全；
   标签不可用时退回 `main`，并**明确打印警告**（可能与本包 CLI 版本错配）；
4. 跑一次 `doctor`，打印 `versions`（skill/app）与 `degraded`。

常用开关：`-Force` / `--force`（重指向）、`-SkillsDir` / `--skills-dir`、
`-SkipComponents` / `--skip-components`（只留 CLI）、`-ComponentsUrl <zip>` / `COMPONENTS_URL=<zip>`（离线补组件）。

装完**不需要**任何环境变量。手动方式：把 `Skill/NewbimAI-CADViewer-Skill` 整个目录复制或软链接到
`<skills>/NewbimAI-CADViewer-Skill`（不要只复制 `SKILL.md`）。

`CADVIEWER_ROOT` 只在“把 Skill 复制到仓库外、且没有 `server/` 同级目录”时才需要：
CLI 找根顺序是 `--root` → `CADVIEWER_ROOT` → 脚本自身位置 → 当前目录。

---

## 命令速查

```bash
node cad.mjs doctor                          # 自检（versions / degraded）
node cad.mjs open "图.dwg"                    # 转 DXF + 起服务 + 链接 + 概要
node cad.mjs readout "图.dwg" > readout.json # 一次拿全量数据
node cad.mjs compare "旧图.dwg" "新图.dwg"    # 图纸对比（JSON 差异摘要）
node cad.mjs measure distance --points "0,0;3000,4000"
node cad.mjs udo "天正图.dwg" --coverage      # 自定义对象：解出/未解出
node cad.mjs export "图.dwg" --to pdf --out out.pdf
node cad.mjs close                           # 用完关服务
```

所有命令输出 **JSON 到 stdout**；失败时 stderr 是 `{"error":"..."}`，退出码 1。
字段与参数详见 `NewbimAI-CADViewer-Skill/references/cli.md`。

---

## 打包（两种包，共用一套逻辑）

```bash
node scripts/build-skill.mjs            # 轻量包
node scripts/build-skill-full.mjs       # 完整包
node scripts/check-skill.mjs --self-test                 # 校验源码树 + 命令层单测
node scripts/check-skill.mjs --package <stage 目录>      # 校验打包产物（含闭源边界/许可附件）
```

输出默认在 `release/`；用环境变量 `CADVIEWER_RELEASE_DIR=<临时目录>` 可完全不污染仓库。
两个包都由 `scripts/skill-build-lib.mjs` 生成：版本注入、模块清单（读 `skill.json`）、
闭源边界断言、许可附件校验、压缩与体积报告都是同一套。

### 体积构成（0.3.0 实测，未压缩 / 压缩）

**轻量包** `NewbimAI-CADViewer-Skill-0.3.0.zip`

| 组成 | 大小 |
|---|---:|
| `Skill/`（安装脚本 + README + SKILL.md + skill.json + scripts + references） | 171 KB |
| `server/`（5 个模块 + package.json/lock） | 219 KB |
| `使用说明.txt` | 2 KB |
| **解压合计** | **约 392 KB** |
| **zip** | **153 KB** |

**完整包** `NewbimAI-CADViewer-Skill-full-0.3.0.zip`

| 组成 | 大小 |
|---|---:|
| `Skill/`（安装脚本 + README + Skill） | 171 KB |
| `server/`（全量） | 758 KB |
| `web/dist`（其中字体 25.7 MB） | 28.9 MB |
| `bin/cadcraft`（仅 CLI） | 50.9 MB |
| `bin/udo-cli`（解析组件） | 7.4 MB |
| `licenses/`（MPL-2.0 等附件） | 37 KB |
| `LICENSE` + `THIRD-PARTY.md` | 45 KB |
| **解压合计** | **约 88.1 MB** |
| **zip** | **43.3 MB** |

轻量包装完还要联网两次：cadcraft（~57MB）+ 组件（~18MB）；完整包离线可用，且自带自定义对象解析。

### 版本

Skill 与 App **同版本**，唯一事实源是 `server/package.json` 的 `version`：

1. 源码树里的 `skill.json` **不写** `version`（`doctor` 回退读 `server/package.json`）；
2. 构建时由 `scripts/build-skill.mjs` 把 `version` 注入包内 `skill.json`，并写上 `versionSource`；
3. `doctor` 同时输出 `appVersion` 与 `skillVersion`；不一致时进 `degraded`（`skill-version`），提示重跑安装。

`minAppVersion` 是**能力最低要求**（对比/测量/自定义对象从 0.3.0 起提供），不是第二份版本号。

---

## 闭源边界与许可

- Skill 包内**不含**自定义对象解析组件的源码目录、Cargo 清单、`target/`、`*.rlib`；
  构建脚本会遍历产物，命中即**构建失败**（`assertNoForbiddenSources`）。
- 完整包含闭源二进制 `bin/udo-cli/udo-cli.exe`，因此**必须**随附：
  `licenses/acadrust-MPL-2.0.txt`、`acadrust-SOURCE.txt`、`acadrust-NOTICE.txt`、
  `udo-cli-NOTICE.md`、`udo-cli-LICENSE-MIT.txt`、`udo-cli-LICENSE-APACHE.txt`。
  少一个文件，构建直接失败（合规优先）。
- 本项目自身 AGPL-3.0-only（`LICENSE`）；第三方组件见 `THIRD-PARTY.md`。
  商业许可联系 nbimgpt@163.com。

---

## 边界

- 只读本地文件；除非用户明确要求，不要把图纸上传到任何外部服务。
- 服务按需起、用完关：`open` / `serve` / `compare` 会在后台静默启动（不弹窗、不开系统浏览器）；
  `close` 立即关，空闲 30 分钟也会自动退出。其余命令完全不起服务。
- 安装脚本不交互（无 `Read-Host` / `pause`），可直接在 agent 命令里调用。
- Skill 不修改 `server/**`、`web/**`、`start.bat`；只作为只读模块 import。
- 不引入新的 npm 依赖（Node 内置 + 仓库现有模块）。
- `server/cache/` 是纯派生缓存（可随时删）；用户原图在 `data/`（**不要删、不要提交**）。

排障见 `NewbimAI-CADViewer-Skill/references/troubleshooting.md`。
