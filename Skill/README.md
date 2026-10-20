# CADViewer Skill

给 agent 用的**纯命令行**图纸工具：读 DWG/DXF、统计图元/图层/图块/文字、判断天正图纸、导出 DXF/SVG/PDF/PNG/JSON。不启动服务、不打开浏览器、不占端口。

所有数字都来自 CADViewer 产品自己的扫描器（`server/scanner.js`），因此与界面看到的口径一致。唯一入口：

```bash
node Skill/cadviewer/scripts/cad.mjs <命令> <图纸> [选项]
```

---

## 目录

```text
Skill/
├── README.md                     ← 本文件：用途与注册方式
├── install.ps1                   ← 一键注册到 OpenCode skills 目录（Windows）
└── cadviewer/
    ├── SKILL.md                  ← agent 读的 Skill 说明（给模型看）
    ├── scripts/
    │   └── cad.mjs               ← 唯一 CLI 入口
    └── references/
        ├── api.md                ← 运行中服务的 HTTP API
        ├── answering.md          ← 常见问答的问法/答法/易错口径
        └── troubleshooting.md    ← 排障
```

---

## 依赖（重要）

这个 Skill 本身只是**薄壳**，运行时依赖原仓库里的两样东西：

1. **`server/**` 模块**（只读复用）：`cadcraft.js`、`scanner.js`、`tch-detect.js`、`svg-pdf.js` 等。
   CLI 通过动态 `import()` 从项目根加载它们，**不会**把服务端代码复制进 Skill。
2. **`bin/cadcraft/**` 转换器**（不在仓库内，需自行下载）：解压后应存在
   `<项目根>/bin/cadcraft/**/cadcraft-cli.exe`，约 127MB，`.gitignore` 已排除。

没有 cadcraft（项目根仍满足“存在 `server/scanner.js`”判据——**不要求** `bin/`）时：DXF 的统计/文字/图层/图块仍可用；DWG 转换与 SVG/PDF/PNG 导出不可用（`doctor` 会指出）。

---

## 前置条件与平台支持

**必须与整个 CADViewer 仓库一起使用。** 这个 Skill 只是薄壳，扫描器、DXF 解析、SVG/PDF 导出全部复用仓库里的 `server/**`（见上节）。单独拿走 `Skill/` 文件夹无法运行——连 `doctor` 都会失败，因为它找不到 `server/scanner.js`。

- **`bin/cadcraft/`（Windows 便携版转换器）需单独下载**，仓库不含。缺它时 DWG 转换与 `svg|pdf|png` 导出不可用；DXF 的只读命令仍可用。
- **Windows**：完整功能——DWG 转换、`dxf|svg|pdf|png|json` 导出、`serve` 起界面。
- **macOS / Linux**：仅 DXF 只读——`summary` `layers` `blocks` `text` `stats` `tch`，以及 `export --to json|dxf`。DWG 与图片/PDF 导出不支持（cadcraft 只提供 Windows 构建）。

---

## 如何注册

> 下文用 `<repo>` 指仓库根、`%USERPROFILE%` 指当前用户目录（cmd 里可直接用）；请按你的实际路径替换。

### 一键注册（Windows，推荐）

在仓库根目录执行：

```bat
powershell -ExecutionPolicy Bypass -File Skill\install.ps1
```

脚本会把 `Skill\cadviewer` 以**目录联接**（junction）注册到 `%USERPROFILE%\.config\opencode\skills\cadviewer`，仓库里的文档一改，Skill 立刻同步。

- **幂等**：已注册且指向同一仓库时，直接返回成功（退出码 0），可反复运行。
- 目标已存在、但不是链接（旧副本）时，默认跳过并提示；加 `-Force` 会删掉它再建联接。
- 已注册但指向别的仓库时，同样加 `-Force` 重新指向。
- 换个 skill 根目录：`-SkillsDir <目录>`。

下面是手动方式，效果相同，按需取用。

OpenCode 会从 `<skills>/cadviewer/SKILL.md` 读取 Skill。默认 skill 根目录是：

```text
%USERPROFILE%\.config\opencode\skills\
```

目标结构必须是：

```text
%USERPROFILE%\.config\opencode\skills\cadviewer\SKILL.md
%USERPROFILE%\.config\opencode\skills\cadviewer\scripts\cad.mjs
%USERPROFILE%\.config\opencode\skills\cadviewer\references\...
```

把 **`Skill/cadviewer/` 整个目录**复制（或软链接）过去即可，不要只复制 `SKILL.md`。

### 方式 A：复制（备选，简单）

```bat
robocopy "<repo>\Skill\cadviewer" ^
         "%USERPROFILE%\.config\opencode\skills\cadviewer" ^
         /MIR
```

> robocopy 成功时退出码是 0–7，不是 1，别把它当失败。
> 以后更新仓库里的 Skill，重跑一次 `/MIR` 即可。

### 方式 B：目录联接 / 软链接（改动实时同步）

Windows 目录联接（junction，通常不需要管理员）：

```bat
mklink /J "%USERPROFILE%\.config\opencode\skills\cadviewer" ^
          "<repo>\Skill\cadviewer"
```

Linux/macOS：

```bash
ln -s "/path/to/CADViewer/Skill/cadviewer" "$HOME/.config/opencode/skills/cadviewer"
```

### 注册后必须设置 `CADVIEWER_ROOT`（除非项目就在原路径且 cwd 在项目内）

复制出去的 `scripts/cad.mjs` 已经不在仓库里，它靠根目录去找 `server/**` 与 `bin/cadcraft/`。**当项目不在原路径、或 agent 的工作目录不固定时**，必须告诉它仓库在哪：

```bat
:: 临时
set CADVIEWER_ROOT=<repo>

:: 永久（新开终端生效）
setx CADVIEWER_ROOT "<repo>"
```

macOS / Linux：

```bash
export CADVIEWER_ROOT=/path/to/CADViewer
# 想长期生效，把上面这行写进 ~/.bashrc 或 ~/.zshrc
```

CLI 的根目录查找顺序：

1. 命令行 `--root <目录>`
2. 环境变量 `CADVIEWER_ROOT`
3. 从当前工作目录逐级向上（判据：存在 `server/scanner.js`；**不要求** `bin/`，因为它被 gitignore、新克隆里没有）
4. 都没有 → 明确报错，并告诉你怎么设；**不会**瞎猜路径

验证：

```bash
node "%USERPROFILE%\.config\opencode\skills\cadviewer\scripts\cad.mjs" doctor
```

应看到 `"ok": true`，且 `project-root` 指向真实仓库、`cadcraft` 指向 `bin/cadcraft/**/cadcraft-cli.exe`。

---

## 快速上手

```bash
# 环境自检
node cad.mjs doctor

# 一张图的全貌（实体/图层/图块/文字/天正/告警）
node cad.mjs summary "<图纸目录>\示例图纸.dwg"

# 图层（默认只列有实体的层；--all 全列）
node cad.mjs layers "<图纸目录>\示例图纸.dwg"
node cad.mjs layers "<图纸目录>\示例图纸.dwg" --all

# 图块（refCount 降序；匿名块已并回原块）
node cad.mjs blocks "<图纸目录>\示例图纸.dwg"
node cad.mjs blocks "<图纸目录>\示例图纸.dwg" --min-ref 1 --limit 20

# 找文字（不区分大小写子串，支持中文）
node cad.mjs text "<图纸目录>\示例图纸.dwg" --find "TAG"

# 天正判定
node cad.mjs tch "<图纸目录>\天正图.dwg"

# 完整原始统计
node cad.mjs stats "<图纸目录>\示例图纸.dwg"

# 导出
node cad.mjs export "<图纸目录>\a.dwg" --to dxf  --out out.dxf
node cad.mjs export "<图纸目录>\a.dwg" --to svg  --out out.svg
node cad.mjs export "<图纸目录>\a.dwg" --to pdf  --out out.pdf
node cad.mjs export "<图纸目录>\a.dwg" --to png  --out preview.png
node cad.mjs export "<图纸目录>\a.dwg" --to json --out stats.json
```

所有命令输出 **JSON 到 stdout**（2 空格缩进）。成功退出码 0；失败时 stderr 输出 `{"error":"..."}` 并退出 1。

`--out` 省略时，产物写到：

```text
<项目根>/server/cache/skill/<sha1(源文件绝对路径) 前 12 位>/
```

并在 JSON 的 `out` 字段返回绝对路径。DWG 只转换一次，后续命中 `converted.dxf`。

---

## 边界

- 只读本地文件；除非用户明确要求，不要把图纸上传到任何外部服务。
- 本 Skill **不修改** `server/**`、`web/**`、`start.bat`；`server/**` 只作为只读模块 import。
- 不引入任何新的 npm 依赖（只用 Node 内置 + 仓库现有模块）。
- `Skill/cadviewer/SKILL.md` 是给 agent 的指令，改 CLI 行为时要同步检查它。
- 缓存与 `bin/cadcraft/` 都不进仓库；`server/cache/` 是纯派生缓存（**可随时整目录删**），用户上传的原图在 `data/`（同样不入库，不要提交）。

更多：见 `cadviewer/references/answering.md`（口径与答法）和 `troubleshooting.md`（排障）。
