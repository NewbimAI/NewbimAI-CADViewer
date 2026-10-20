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

> **只需要 Node.js 20+。** 仓库里已带**构建好的前端 `web/dist`**——不要 `npm install`、
> 不要 `vite build`（那是几分钟的浪费），clone 下来直接能用。

这个 Skill 本身只是**薄壳**，运行时依赖原仓库里的两样东西：

1. **`server/**` 模块**（只读复用）：`cadcraft.js`、`scanner.js`、`tch-detect.js`、`svg-pdf.js` 等。
   CLI 通过动态 `import()` 从项目根加载它们，**不会**把服务端代码复制进 Skill。
2. **`bin/cadcraft/**` 转换器**（DWG 必需；`install.ps1` / `install.sh` 会**自动下载并解压**）：
   上游 **https://github.com/storytold/cadcraft/releases** →
   `cadcraft-<版本>-windows-x64-portable.zip`（约 57MB，解压后约 127MB），解压到
   `<项目根>/bin/cadcraft/`，使 `<项目根>/bin/cadcraft/**/cadcraft-cli.exe` 存在。
   实测 **0.7.0 / 0.8.0** 均兼容（开发时用 0.7.0）；`.gitignore` 已排除该目录。
   装好放着不占资源——只有打开 DWG / 导出 `svg|pdf|png` 时才会被调用。

没有 cadcraft（项目根仍满足“存在 `server/scanner.js`”判据——**不要求** `bin/`）时：DXF 的统计/文字/图层/图块仍可用；DWG 转换与 SVG/PDF/PNG 导出不可用（`doctor` 会指出）。

---

## 前置条件与平台支持

**必须与整个 CADViewer 仓库一起使用。** 这个 Skill 只是薄壳，扫描器、DXF 解析、SVG/PDF 导出全部复用仓库里的 `server/**`（见上节）。单独拿走 `Skill/` 文件夹无法运行——连 `doctor` 都会失败，因为它找不到 `server/scanner.js`。

- **`bin/cadcraft/`（Windows 便携版转换器）需单独下载**
  （https://github.com/storytold/cadcraft/releases ），仓库不含。缺它时 DWG 转换与 `svg|pdf|png` 导出不可用；DXF 的只读命令仍可用。
- **Windows**：完整功能——DWG 转换、`dxf|svg|pdf|png|json` 导出、`serve` 起界面。
- **macOS / Linux**：仅 DXF 只读——`summary` `layers` `blocks` `text` `stats` `tch`，以及 `export --to json|dxf`。DWG 与图片/PDF 导出**本项目未验证**：cadcraft 上游提供 Windows 与 macOS 构建（无 Linux CLI），但我们只在 Windows 上实测过。

---

## 如何注册

> 下文用 `<repo>` 指仓库根、`%USERPROFILE%` 指当前用户目录（cmd 里可直接用）；请按你的实际路径替换。

### 一键注册（推荐）

在**解压后的目录**里执行（轻量包和完整仓库都适用）：

```bat
:: Windows
powershell -ExecutionPolicy Bypass -File Skill\install.ps1
```

```bash
# macOS / Linux
bash Skill/install.sh
```

它会：

- 把 `Skill/cadviewer` 以**目录联接 / 软链接**注册到 agent 的 skills 目录（不复制，文档一改立刻同步）
- 自动识别本机**已存在**的 agent：OpenCode（`~/.config/opencode/skills`，总是装）、
  Claude Code（`~/.claude/skills`）、Cursor（`~/.cursor/skills`）
- 结束时打印 doctor 命令；**装完后不需要设置任何环境变量**

可选项：

- **幂等**：已注册且指向同一目录时直接成功（退出码 0），可反复运行。
- 目标已存在但不是链接（旧副本）→ 默认跳过；加 `-Force`（bash 用 `--force`）会删掉它再建链接。
- 已注册但指向别处 → 同样用 `-Force` 重新指向。
- 只想装到指定目录：`-SkillsDir <目录>`（bash 用 `--skills-dir <目录>`）。

下面是手动方式，效果相同，按需取用。

OpenCode 会从 `<skills>/cadviewer/SKILL.md` 读取 Skill。默认 skill 根目录是：

```text
%USERPROFILE%\.config\opencode\skills\
```

> **其他 agent**（Claude Code 的 `~/.claude/skills/`、Cursor 等各自的 skills 目录）同理：
> 把 `Skill/cadviewer/` 软链接或复制到那个目录即可，目录名保持 `cadviewer`。

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

### `CADVIEWER_ROOT`：现在**不再需要**（老版本才要）

CLI 找项目根的顺序：

1. `--root <目录>`
2. 环境变量 `CADVIEWER_ROOT`
3. **从脚本自身位置向上找** ← 这就是安装后免配置的原因：
   轻量包布局是 `<包>/Skill/cadviewer/scripts/cad.mjs`，从脚本往上两级就能找到 `<包>/server/scanner.js`；
   用 junction / 软链接注册时，Node 解析到的是**包内真实路径**，所以照样命中。
4. 从当前工作目录向上找

所以：**用 `install.ps1` / `install.sh` 装完就能直接跑，不需要设任何变量。**
只有当你想把 CLI 复制到包外单独调用、或想让它指向**另一个**安装目录时，才需要 `--root` 或 `CADVIEWER_ROOT`：

```bat
set CADVIEWER_ROOT=<解压目录>
```

```bash
export CADVIEWER_ROOT=/path/to/cadviewer
# 想长期生效，写进 ~/.bashrc 或 ~/.zshrc
```

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

# 【主流程】收到图纸：转 DXF + 起服务 + 返回可直接打开的链接与概要
node cad.mjs open "<图纸目录>\示例图纸.dwg"
# → {"ok":true,"url":"http://127.0.0.1:3717/?open=...","digest":{...},"next":[...]}

# 用完关掉（后台静默启动，空闲 30 分钟也会自动退出）
node cad.mjs close

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

## 轻量包（59 KB，给别的 agent / 容器用）

```bash
node scripts/build-skill.mjs      # → release/cadviewer-skill-<version>.zip
```

GitHub Release 里也有同名资产，可以直接下。

包里只有 `Skill/` + CLI 实际 `import` 的 4 个模块（`cadcraft.js` `scanner.js` `tch-detect.js` `svg-pdf.js`），
解压 **137 KB**、压缩 **59 KB**——不含 `web/`、字体、前端产物。

- ✅ 能用：`summary` `stats` `layers` `blocks` `text` `tch`、`export --to json|dxf`
- ❌ 不能用：`serve`（起界面需要完整项目的 `start.bat` + `web/dist`）
- DWG 仍需自己放 `bin/cadcraft/`；`doctor` 会把缺 cadcraft / 缺字体列进 `degraded`，不影响 DXF
- 用法：`node <包>/Skill/cadviewer/scripts/cad.mjs --root <包> summary 图纸.dxf`

> 为什么四个模块就够：它们只依赖 Node 内置库，彼此不 import；`block-text.js` 只有
> `dxf-web.js`（服务端渲染预处理）用，CLI 不需要。

---

## 边界

- 只读本地文件；除非用户明确要求，不要把图纸上传到任何外部服务。
- **服务按需起、用完关**：只有 `open` / `serve` 会启动服务，而且是**后台静默启动**
  （不弹控制台窗口、不打开系统浏览器）；`close` 立即关，空闲 30 分钟也会自动退出。
  其余命令（`summary` `blocks` `export` …）完全不起服务。
- **安装不交互**：`install.ps1` / `install.sh` 不读任何输入（无 `Read-Host`/`pause`），
  可直接在 agent 的命令里调用。
- 本 Skill **不修改** `server/**`、`web/**`、`start.bat`；`server/**` 只作为只读模块 import。
- 不引入任何新的 npm 依赖（只用 Node 内置 + 仓库现有模块）。
- `Skill/cadviewer/SKILL.md` 是给 agent 的指令，改 CLI 行为时要同步检查它。
- 缓存与 `bin/cadcraft/` 都不进仓库；`server/cache/` 是纯派生缓存（**可随时整目录删**），用户上传的原图在 `data/`（同样不入库，不要提交）。

更多：见 `cadviewer/references/answering.md`（口径与答法）和 `troubleshooting.md`（排障）。
