# 第三方组件与许可（渲染引擎）

> **本项目自身的许可证：AGPL-3.0-only**（见 [`LICENSE`](./LICENSE)），另提供商业许可（联系 **nbimgpt@163.com**）。
> 本文件列出**随包分发**的第三方组件及其义务。分发时请勿删除其中的许可声明与版权行。

## dxf-viewer — MPL 2.0

- 包名：`dxf-viewer`，版本 `1.0.50`（`web/package.json`）
- 上游：https://github.com/vagran/dxf-viewer
- **许可证：Mozilla Public License 2.0（MPL-2.0），不是 MIT。**
  完整文本随包发布：`web/node_modules/dxf-viewer/LICENSE`

### MPL 2.0 对我们（闭源/商业产品）意味着什么

MPL 是**文件级** copyleft，不是 GPL 那种传染式。可以做的事：

1. **可以**把 dxf-viewer 作为依赖打进闭源产品、商业分发、收费，不要求开源我们自己写的
   `server/*`、`web/src/*`（这些是独立作品，通过 import 使用它）。
2. **必须**保留其许可证与版权声明，并在分发时告知用户该组件采用 MPL-2.0、可获取其源码。
   建议在"关于/开源许可"页面列出本条信息。

限制（不能做的事）：

3. **不能**修改 dxf-viewer 自身的源文件后闭源分发。若修改了
   `web/node_modules/dxf-viewer/src/**` 里的文件（哪怕是打个补丁），该**文件**必须以
   MPL-2.0 公开。文件级：只公开被改的那几个文件，不必公开整个产品。
4. **不能**移除文件里的许可证头。

### 我们的当前做法（合规）

- **不修改 dxf-viewer 的任何源文件**。所有适配都在外部完成：
  - 服务端预处理（`server/dxf-web.js`）：解码 `\U+XXXX`、把 ACAD_TABLE 注回成
    LWPOLYLINE / TEXT —— 产出的是**数据**（DXF 文件），不是它的代码；
  - 前端封装（`web/src/components/DxfCanvas.tsx`）：只用公开 API
    （`Load / FitView / SetView / GetLayers / ShowLayer / SetClearColor / Subscribe`）。
- 因此只需履行第 2 条（保留声明、提供源码获取途径）。
- ⚠️ 如果将来必须改它的源码（比如自己实现虚线/线宽），**改完必须把该文件以 MPL-2.0 公开**，
  并在仓库里单列 `patches/` 目录说明改了哪个文件、为什么改。现在的实现刻意避开了这条路。

## three.js — MIT

- 版本 `0.186.0`，dxf-viewer 的依赖，我方也直接 import。
- MIT 要求：保留版权与许可声明即可，无开源义务。

## CADCraft（cadcraft-cli）— Apache-2.0 或 MIT

- 包名：`cadcraft-cli`，**内置版本 `0.7.0`**（`bin/cadcraft/cadcraft-0.7.0-windows-x64-portable/`）
- 上游：https://github.com/storytold/cadcraft （下载：https://github.com/storytold/cadcraft/releases）
- **许可证：Apache-2.0 或 MIT 双许可**（上游同时提供 `LICENSE-APACHE` 与 `LICENSE-MIT`）。
  这两份文本随转换器包一起分发，位于
  `bin/cadcraft/cadcraft-<版本>-windows-x64-portable/` 目录内，**请勿删除**。
- 用途：DWG → DXF 转换，以及 SVG / PDF / PNG 导出（`server/cadcraft.js` 调用）。
  缺它时 DXF 只读功能仍可用。

### 我们的分发方式（合规）

1. **原样分发上游便携包，未修改任何文件**；包内的 `LICENSE-APACHE`、`LICENSE-MIT`
   以及字体许可（`OFL-*.txt`）都原封保留。
2. Apache-2.0 要求保留版权与许可声明、附带许可副本 —— 由包内文件满足；
   我们未改动其文件，因此不存在"需声明修改"的情形。
3. 不暗示上游对本项目的背书；本项目自身许可是 **AGPL-3.0-only**，与 cadcraft 的许可相互独立。
4. **Windows 免安装包**（GitHub Releases）内含该目录；源码仓库不含（`.gitignore` 排除）。

## 字体

**随包分发**（源文件在 `web/public/fonts/`，构建时进入 `web/dist/`，由静态服务提供）：

| 文件 | 字体 | 许可证 |
|---|---|---|
| `NotoSerifSC-Regular.ttf` | Noto Serif SC（思源宋体，**派生产物**，见下） | **SIL OFL 1.1**，原文见同目录 `OFL.txt` |
| （构建产物中的 `geist-*.woff2`） | Geist（界面字体） | **SIL OFL 1.1**，原文见 `Geist-OFL.txt` |

- 图纸文字由 dxf-viewer 通过 `FONT_URLS` 加载 `NotoSerifSC-Regular.ttf` 渲染。
  OFL 允许随软件分发，但**必须保留许可原文**，且不得单独售卖字体本身。
- ⚠️ **该字体是派生产物**（OFL 允许修改；本字体未声明 Reserved Font Name，故可保留原名）：
  1. `fonttools varLib.instancer wght=400` —— 可变字体实例化成**静态 Regular**
     （dxf-viewer 打包的 opentype.js **不支持可变轴**，只渲染默认实例，而 Noto 的默认是 ExtraLight，太细）；
  2. `skia-pathops` 并集**去重叠** —— 消除**自交轮廓**
     （dxf-viewer 用 earcut 三角化，自交字形会被填成**实心块**；实测 `7` 就是因此变成实心块）。
  换字体时必须重复这两步，且必须是 **TrueType(glyf)**：CFF/`.otf` 实测会算出 NaN 顶点，
  导致该图**所有 TEXT 被 worker 跳过**、文字图层变成"空层"（开关也会被禁用）。
- ⚠️ **不再使用 Windows 系统字体**（`simfang.ttf` 仿宋 / `S_Changfangsong.ttf` 长仿宋 /
  `isocp___.ttf` ISOCP）：它们**不可随产品分发**。
  `server` 里的 `/api/font/:name` 只是本机开发期的兜底白名单，**产品运行不依赖它**。

## 天正（TCH_*）自定义对象

- 本版本（CADViewer）**不含任何天正（TCH_*）自定义对象解析能力**：无 C# 桥接工程、无第三方
  DWG/DXF 解析库依赖、无 dotnet 构建步骤。
- 天正图纸请先在天正软件内导出为 T3 格式后再打开；服务端只对 DXF 的 CLASSES 段做一次轻量扫描，
  识别 `TCH_*` 类名用于界面提示。
