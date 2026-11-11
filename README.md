# CADViewer

本地 DWG / DXF 看图与统计工具。**只监听 127.0.0.1，不上云**：图纸在本机转换、渲染，不出机器。

- **服务端**：Node.js + Express + `cadcraft-cli`（DWG→DXF 转换）+ 自研流式 DXF 统计
- **前端**：Vite + React + TypeScript + Tailwind CSS + shadcn/ui
- **渲染**：`dxf-viewer`（MPL-2.0）+ three.js，WebGL 直读 DXF
- **字体**：随包 Noto Sans SC / Symbols 2 / Serif SC（SIL OFL 1.1）；**SHX 文字**按图纸 STYLE 表在本机取字体，服务端转成笔画几何

## 功能

- 打开 DWG / DXF；滚轮缩放、拖拽平移、适应窗口 / 全图
- 图层显隐开关；**没有实体的图层自动从列表隐藏**（统计口径与引擎口径双重判定，避免误隐藏"只在块里用到"的图层）
- **双击图层 / 图块行**：该层 / 该块保留原色、其余灰显；单击还原；切换时不改变视口
- 图块面板支持**匿名块溯源**：
  - `*U`（动态块实例）→ 原始块名（可定位；若原块不在本图会标注出来）
  - `*T` → 表格、`*D` → 标注、`*X` → 填充及其父块
  - `A$...` 这类无来源信息的块，如实显示「来源未知」，不伪造
- 导出：**PNG**（当前视图、白底、2×）、**统计 JSON**、**原始 DXF**、**矢量 PDF**
- **测量工具**：距离、连续长度、面积、角度、半径、坐标；吸附端点 / 中点 / 圆心 / 象限点 / 交点 / 线上最近点，缩放时数值与标注不漂移
- **图纸比对**：两份已打开的图纸做实体级差异（新增 / 删除 / 修改），画布上叠加显示并列出变更集，支持定位与筛选
- **自动更新**：顶部按钮检查新版本 → 下载校验 → 重启替换（只替换应用文件，`data/`、`node/`、`bin/` 不动）
- **含自定义对象的图纸**：本版能解析其中一部分（墙、门窗洞口、文字、尺寸标注），其余部分暂不解析

### 兼容性：含自定义对象的图纸

现阶段对含自定义对象的图纸兼容性较差：部分自定义对象无法解析，图上可能缺少墙体、门窗、文字或标注。遇到这种情况，可先用设计软件把这些对象转换为 T3 档位（或导出为已展开的 DXF），再用本工具打开即可完整查看。

## Agent Skill（读图 / 统计 / 导出）

仓库里带一个给 agent 用的命令行 Skill（`Skill/`）：读 DWG / DXF，回答图块、图层统计，导出 PNG / JSON / DXF / PDF。它复用本仓库 `server/**` 的扫描器，所以数字口径与界面一致；不启动服务、不占端口。

- **必须与整个仓库一起使用**：`Skill/` 只是薄壳，单独拷走无法运行。
- **Windows**：完整功能——DWG 转换、`dxf|svg|pdf|png|json` 导出、`serve` 起界面。
- **macOS / Linux**：仅 DXF 只读——`summary` `layers` `blocks` `text` `stats` `udo` 与 `export --to json|dxf`；不支持 DWG 与图片 / PDF 导出。
- `bin/cadcraft/`（见下节）缺失时，DWG 转换与 `svg|pdf|png` 导出不可用，DXF 只读命令仍可用。

注册方式与全部命令见 [`Skill/README.md`](./Skill/README.md)。一行示例：

```bash
node Skill/NewbimAI-CADViewer-Skill/scripts/cad.mjs summary "<图纸目录>\示例图纸.dwg"
```

## 环境要求

- **Node.js 20+**
- **cadcraft-cli 便携版**：本仓库**不含**转换器二进制（解压前约 57MB、解压后约 127MB，不适合进仓库）。
  从 https://github.com/storytold/cadcraft/releases 下载
  `cadcraft-<版本>-windows-x64-portable.zip`，解压后使下面这个路径存在：
  ```
  bin/cadcraft/**/cadcraft-cli.exe
  ```
  同包的 `cadcraft.exe` 是 EGUI 桌面主程序（约 75MB），本项目**从不调用**它；
  删掉它、只留 `cadcraft-cli.exe` 即可，占用从约 127MB 降到约 53MB。
  实测 **0.7.0** 与 **0.8.0** 均可正常工作。只想看 DXF 的话可以不装它（DXF 统计不依赖 cadcraft）。
- **udo-cli（可选）**：解析 DWG 里的自定义对象（`TCH_*` 一类），目前只上线**门窗洞口**。
  仓库**不含**该二进制（`.gitignore` 排除 `bin/udo-cli/`），需要本地构建：

  ```bash
  cargo build --release            # 需要 Rust 1.75+；配置见 .cargo/config.toml
  mkdir -p bin/udo-cli
  cp target/release/udo-cli.exe bin/udo-cli/    # Windows；Linux/macOS 去掉 .exe
  ```

  也可以用环境变量 `CADVIEWER_UDO_CLI=/abs/path/udo-cli` 直接指定（旧名 `UDO_CLI` 仍兼容）。缺它时一切照旧：
  洞口不注入，Web DXF 与没有该功能时**逐字节相同**。
  兼容性与能力边界见下文「兼容性」一节；第三方组件与许可说明见 `THIRD-PARTY.md`。

## 启动

```bat
start.bat
```

或手动：

```bash
cd server && npm install && node index.js
cd web && npm install && npm run build
```

然后打开 <http://127.0.0.1:3717>。

端口可覆盖（例如避免与已运行实例冲突）：

```bat
set PORT=3727
node server/index.js
```

## 目录

```
server/        Express 服务、DXF 统计、Web DXF 预处理、SVG→PDF 导出
web/           React 前端（源码在 web/src，构建产物在 web/dist）
Skill/         agent 用的命令行 Skill（见 Skill/README.md）
data/          用户上传的原始图纸（不入库；缓存可以删，这里不要删）
bin/cadcraft/  转换器（需自行下载，已被 .gitignore 排除）
bin/udo-cli/   自定义对象（门窗洞口）解析器（cargo build --release 后复制，已被 .gitignore 排除）
test/          本机开发脚本（不入库）
```

## 许可

**AGPL-3.0-only** —— 见 [`LICENSE`](./LICENSE)。

Copyright © 2026 **NewbimAI**。

- **免费使用**：个人使用、学习、研究、以及企业内部使用，按 AGPL 遵守即可（若你分发修改版，需以 AGPL 公开相应源码）。
- **商业许可**：如果你的公司**无法遵守 AGPL 的开源义务**（例如需要闭源集成、嵌入商业产品、或不愿公开修改），可购买商业许可。
  **联系：nbimgpt@163.com**

## 第三方组件

第三方组件及其许可证（dxf-viewer/MPL-2.0、three.js/MIT、cadcraft/MIT OR Apache-2.0、Noto Serif SC 与 Geist/OFL-1.1 等）见 [`THIRD-PARTY.md`](./THIRD-PARTY.md)。
分发时请保留 `web/public/fonts/OFL.txt` 等许可声明，不要删除。

## 贡献

提交前请阅读 [`CONTRIBUTING.md`](./CONTRIBUTING.md) 并签署 [`CLA.md`](./CLA.md)。
签署 CLA 是**必需的**——它让我们能同时维持 AGPL 与商业许可两种授权。
