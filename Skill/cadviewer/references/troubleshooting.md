# 排障

## 0. 先跑自检

```bash
node Skill/cadviewer/scripts/cad.mjs doctor
```

输出 6 项 `{check, ok, detail}` 与总 `ok`：

| check | 失败时看什么 |
|---|---|
| `node` | Node 版本（项目要求 20+） |
| `project-root` | 项目根是否找对 |
| `cadcraft` | `bin/cadcraft/**/cadcraft-cli.exe` 是否存在、能否 `--version` |
| `fonts` | `web/public/fonts/` 或 `web/dist/fonts/` 是否至少有一个字体 |
| `ui` | `server/index.js` 与 `web/dist/index.html`（`open` / `serve` 用；安装脚本会自动补） |
| `cache` | `server/cache/skill/` 是否可写 |

---

## 1. 找不到 CADViewer 项目根

```
{"error":"找不到 CADViewer 项目根。请用以下任一方式指定…"}
```

CLI 的判据是：某目录下**同时**有 `server/scanner.js` 和 `bin/`。查找顺序：

1. `--root <dir>`
2. 环境变量 `CADVIEWER_ROOT`
3. 从 `process.cwd()` 逐级向上
4. 都没有 → 报错（不会猜路径）

**解决**：

```bat
:: 临时（当前终端）
set CADVIEWER_ROOT=<repo>

:: 永久（新开终端生效）
setx CADVIEWER_ROOT "<repo>"
```

或每条命令都带：

```bash
node cad.mjs summary "<图纸目录>\a.dwg" --root "<repo>"
```

> Skill 被复制到 `<skills>/cadviewer/` 后，`scripts/cad.mjs` 不再位于仓库内，因此**必须**用 `CADVIEWER_ROOT`（或 `--root`）指向原仓库，CLI 才能 import `server/**` 并找到 `bin/cadcraft/`。

**不要**把 `--root` 指到 `Skill/cadviewer` 或 `Skill`，那里没有 `server/` 与 `bin/`。

---

## 2. cadcraft 未部署 / version 为 null

现象：`doctor` 的 `cadcraft.ok=false`，或转换 DWG 时报：

```
cadcraft-cli 未部署：未在 <root>\bin 下找到 cadcraft-cli.exe。
```

**解决**：把 cadcraft 便携版压缩包解压到项目的 `bin/cadcraft/`，使下面这个路径存在：

```text
<项目根>/bin/cadcraft/**/cadcraft-cli.exe
```

（cadcraft 约 127MB，不在仓库里：到 https://github.com/storytold/cadcraft/releases 下载
`cadcraft-<版本>-windows-x64-portable.zip` 解压即可；`.gitignore` 已排除 `bin/cadcraft/`。）

- 便携包有时只有 `cadcraft.exe`，`server/cadcraft.js` 也会回退使用它。
- 装好后重跑 `doctor`，应看到 `version: cadcraft-cli 0.7.0` 之类的字符串。
- 没有 cadcraft 时（前提是项目根仍满足“`server/scanner.js` + `bin/` 目录”判据），**DXF 的 summary/layers/blocks/text/stats/tch 仍可用**；DWG 转换与 svg/pdf/png 导出不可用。

---

## 3. DWG 转换失败

现象：

```
{"error":"DWG→DXF 转换失败: …"}
```

排查顺序：

1. `doctor` 的 `cadcraft` 是否 ok；
2. 文件本身是否损坏/加密/不是真正的 DWG（改后缀不算）；
3. 手动跑一次看 stderr：

   ```bat
   bin\cadcraft\<portable>\cadcraft-cli.exe convert "<图纸目录>\a.dwg" "%TEMP%\a.dxf"
   ```

4. 若之前转换到一半被中断，删掉**该图自己的**缓存目录再试（见下一节）。

CLI 失败时会删掉半成品 `converted.dxf`，正常不会反复命中坏缓存。

---

## 4. 缓存：在哪、什么时候失效、能不能清

**位置**：

```text
<项目根>/server/cache/skill/<sha1(源文件绝对路径) 前 12 位>/
  converted.dxf        DWG 转换产物
  export-<key>.pdf/svg/png/json/dxf   --out 缺省时的导出产物
  pdf-src-<key>.svg                   PDF 的中间 SVG
```

- `.dxf` 输入**直接用源文件**，不复制、不缓存。
- 命中条件：`converted.dxf` 存在、非空，且 mtime 不早于源 DWG。源图被替换后会自动重转。
- 同一进程内用内存 Map 记住转换结果，不会重复转换。
- `server/cache/` 与 `data/`（用户原图）都已被 `.gitignore` 覆盖，**不要**提交；也不要为了“清缓存”去删 `data/`。

**清理**：只删出问题的那张图对应的缓存目录。`rm -rf server/cache` 现在是**安全的**——用户原图在 `data/`，不在缓存里，删了只会让下次打开重转一遍：

```bat
rmdir /s /q "server\cache\skill\0123456789ab"
```

清掉后第一次调用会重新转换；第二次开始 `summary.cache.hit=true`。

---

## 5. PNG 导出

cadcraft 0.7.0 的 `convert` 明确支持 `OUT.(dxf|dwg|svg|png|pdf)`，CLI 的 PNG 路径是：

1. `cadcraft-cli convert <dxf> <out.png> --window …`
2. 失败则退到 `cadcraft-cli run <dxf> --export <out.png> --window …`

两路都失败时会报：

```
PNG 导出失败：cadcraft 在当前环境未能产出 PNG（…）。
PNG 预览需要打开界面（start.bat）用顶栏「导出 → PNG」，那才是与界面一致的截图。
```

这时**不要**把别的文件改后缀冒充 PNG。需要与界面完全一致的画面（图层显隐、聚焦灰显、2×）时，只能：

```bat
start.bat
```

然后在 `http://127.0.0.1:3717` 打开图，用顶栏「导出 → PNG」。

---

## 6. PDF / SVG 导出失败或太大

- PDF 链路：`cadcraft convert DXF→SVG` → `server/svg-pdf.js`。失败先看 stderr 里 cadcraft 的报错。
- 项目对超大图有保护（服务端：`PDF_MAX_SRC_MB`、`PDF_MAX_SVG_MB`）；CLI 直接调用时没有这两个上限，但 SVG 可能非常大、耗时很长。
- `server/cadcraft.js` 的 `convertToSvg` 默认超时 120 秒。超大图若卡在转换，CLI 会抛超时；此时建议用界面导出（服务端用子进程 + 更大堆）。
- PDF 正常特征：以 `%PDF-1.4` 开头、以 `%%EOF` 结尾，内容流 `FlateDecode` 可 inflate。
- PDF/SVG 里文字是轮廓路径，**不可选中/不可编辑**，这是预期行为（不嵌字体，可自由分发）。

---

## 7. 3717 端口被占用

CLI **完全不用端口**，不要为了跑 CLI 去杀 3717。只有启动界面服务时才会遇到：

```
[cadviewer] 端口 3717 仍被占用…
```

- 通常是上一个实例刚退出、Windows 的 TIME_WAIT 还没回收，等几秒再启动。
- 或换端口：

  ```bat
  set PORT=3727
  start.bat
  ```

  然后访问 `http://127.0.0.1:3727`。
- 不要 `taskkill` 掉不明进程；先确认它是不是你刚启动的 CADViewer。

---

## 8. Windows 控制台里中文像乱码

CLI 输出的是 **UTF-8**，没有 BOM。PowerShell 5 的管道/重定向可能按控制台代码页（GBK）解码，导致你看到 `鍋囨満` 之类。文件本身的 JSON 是好的。

解决（任选）：

```powershell
chcp 65001
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()
node Skill/cadviewer/scripts/cad.mjs summary "<图纸目录>\a.dwg"
```

```bat
:: cmd 里直接重定向，保留原始字节
node Skill\cadviewer\scripts\cad.mjs summary "<图纸目录>\a.dwg" > out.json
```

程序里读输出时请显式按 UTF-8 解码（Node `execFile(..., {encoding:"utf8"})`）。

---

## 9. `text --find` 返回 0

先看 `total`：

- `total=0`：这张图 ENTITIES 段里没有 TEXT/MTEXT（可能文字全在块定义里，或用了天正自定义对象）。
- `total>0` 但 `matched=0`：
  - `--find` 是**不区分大小写的子串**，不是正则；`H17` 能匹配 `h17-01`，但不能匹配 `H 17`。
  - 中文可能被存成 `\U+XXXX` 或 GBK；CLI 会解 `\U+` 并按 UTF-8/GBK 解码文件，但极老的非标准编码仍可能漏。
  - `--layer` 是整层名精确匹配，不是子串；先不加 `--layer`。
- `text` 只统计**顶层** ENTITIES 的 TEXT/MTEXT，**不统计块定义内部文字**。`matched=0` 不等于图面上绝对没有（块内文字要按 INSERT 展开，CLI 不展开）。

---

## 10. 天正判定看起来“矛盾”

- `classes=[]` 但 `level=provenance`：正常。cadcraft 常把 `TCH_*` 类丢掉，只能靠 `_TCH_*` 样式/图层/块名判定来源。
- `level=provenance` **不能**说“内容缺失”；只有 `level=objects` 才能提示“可能确实缺失，建议 T3 重导”。
- `level=none` 只代表“没检出特征”，不要据此断言“绝对不是天正图”。

---

## 11. `contentBox` 为 null

不是错误。`contentBox` 需要足够的坐标点做密度区域增长；小图/点太少/图太散时扫描器会返回 `null`。此时：

- `extents` 仍然可用；
- 导出 SVG/PDF/PNG 会自动回退到 `coreExtents`，再不行用 `extents`；
- 不要因此说“图纸没有内容”。

---

## 12. 其它检查

```bash
node --check Skill/cadviewer/scripts/cad.mjs
```

- 退出码：成功 `0`；失败 `1`，stderr 是 `{"error":"..."}`。
- 支持格式只有 `.dwg` / `.dxf`；其它扩展名直接报错。
- `export --out` 不允许指向源图纸本身（防止覆盖原文件）；父目录会自动创建。
- 没有引入任何新的 npm 依赖，只用 Node 内置模块 + 仓库现有的 `server/**`。

---

## 13. `doctor` 报 `ok:true` 但 `degraded` 里有东西

**这是正常的，不是故障。** `ok` 只由**必需项**决定：`node`、`project-root`、`cache`。

| degraded 里有 | 含义 | 影响 |
|---|---|---|
| `cadcraft` | 没放 `bin/cadcraft/`（安装时下载失败） | DWG 转换与 `svg\|pdf\|png` 导出不可用；DXF 统计/导出照常 |
| `ui` | 缺 `server/index.js` 或 `web/dist/index.html`（安装时下载失败） | `open` / `serve` 不可用；统计与 JSON/DXF 导出照常 |
| `fonts` | `web/public/fonts/` 与 `web/dist/fonts/` 都没有字体 | 只影响界面文字渲染；**CLI 完全不读字体** |

所以 `ok:true` + `degraded:["cadcraft","ui"]` = "DXF 全能用，DWG 与界面相关能力缺"。
两种情况都是那一次下载没成功，**重跑 `install.ps1` / `install.sh`** 即可（已装好的部分会跳过）；
离线时可把仓库源码 zip 下到本地，用 `-ComponentsUrl <zip>` 补。

## 14. 别的机器 / 别的 agent 打不开 `127.0.0.1:3717`

`127.0.0.1` 指的是**浏览器所在那台机器**。远端或沙箱里的 agent，它的 `127.0.0.1`
是它自己的容器，不是你的电脑——这种情况下页面打不开是网络位置决定的，改配置没用。

三种情况的判断与做法见 `SKILL.md` 的「在别的 agent / 别的机器里打开」。要点：

- 同一台机器 → 直接 `serve` + `127.0.0.1`。
- 同一局域网且能路由到宿主机 → 启动前 `set CADVIEWER_HOST=0.0.0.0`，
  用 `GET /api/health` 返回的 `lanUrls` 里的地址；**用完记得关**（同网段可见你的图纸）。
- 云端 / 沙箱 → 只能 `export --to png|svg|pdf` 把文件交给它看。
