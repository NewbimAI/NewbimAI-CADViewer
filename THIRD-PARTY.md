# 第三方组件与许可（渲染引擎）

> **本项目自身的许可证：AGPL-3.0-only**（见 [`LICENSE`](./LICENSE)），另提供商业许可（联系 **nbimgpt@163.com**）。
> 本文件列出**随包分发**的第三方组件及其义务。分发时请勿删除其中的许可声明与版权行。

## dxf-viewer — MPL 2.0

- 包名：`dxf-viewer`，版本 `1.0.50`（`web/package.json`），**已 fork 到 `web/vendor/dxf-viewer/`**
- 上游：https://github.com/vagran/dxf-viewer
- **许可证：Mozilla Public License 2.0（MPL-2.0），不是 MIT。**
  完整文本随包发布：`web/vendor/dxf-viewer/LICENSE`

### MPL 2.0 对我们（闭源/商业产品）意味着什么

MPL 是**文件级** copyleft，不是 GPL 那种传染式。可以做的事：

1. **可以**把 dxf-viewer 作为依赖打进闭源产品、商业分发、收费，不要求开源我们自己写的
   `server/*`、`web/src/*`（这些是独立作品，通过 import 使用它）。
2. **必须**保留其许可证与版权声明，并在分发时告知用户该组件采用 MPL-2.0、可获取其源码。
   建议在"关于/开源许可"页面列出本条信息。

限制（不能做的事）：

3. **不能**修改 dxf-viewer 自身的源文件后闭源分发。若修改了其源文件（哪怕是打个补丁），
   该**文件**必须以 MPL-2.0 公开。文件级：只公开被改的那几个文件，不必公开整个产品。
4. **不能**移除文件里的许可证头。

### 我们的当前做法（合规）

- **已 fork**：`web/vendor/dxf-viewer/src/**` 是本项目维护的修改版，Vite 通过 alias
  把 `dxf-viewer` 指向它（见 `web/vite.config.ts`）。这样源码随仓库公开，满足 MPL-2.0
  的文件级义务；修改清单与原因见 `web/vendor/README.md`。
- 其余适配仍在外部完成：
  - 服务端预处理（`server/dxf-web.js`）：解码 `\U+XXXX`、把 ACAD_TABLE 注回成
    LWPOLYLINE / TEXT —— 产出的是**数据**（DXF 文件），不是它的代码；
  - 前端封装（`web/src/components/DxfCanvas.tsx`）：只用公开 API
    （`Load / FitView / SetView / GetLayers / ShowLayer / SetClearColor / Subscribe`）。
- 分发时仍需履行第 2 条（保留声明、提供源码获取途径）。

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

1. **原样分发上游便携包中实际使用的文件，未修改任何文件内容**；包内的 `LICENSE-APACHE`、`LICENSE-MIT`
   以及字体许可（`OFL-*.txt`）都原封保留。
   - 安装脚本会删除包内的 `cadcraft.exe`（EGUI 桌面主程序，约 75MB）：本项目只调用
     `cadcraft-cli.exe`，该文件从不被执行。删除不改变任何被分发文件的字节内容，
     也不影响许可声明与署名。
2. Apache-2.0 要求保留版权与许可声明、附带许可副本 —— 由包内文件满足；
   我们未改动其文件，因此不存在"需声明修改"的情形。
3. 不暗示上游对本项目的背书；本项目自身许可是 **AGPL-3.0-only**，与 cadcraft 的许可相互独立。
4. **Windows 免安装包**（GitHub Releases）内含该目录；源码仓库不含（`.gitignore` 排除）。

## 字体

**随包分发**（源文件在 `web/public/fonts/`，构建时进入 `web/dist/`，由静态服务提供）：

| 文件 | 字体 | 许可证 |
|---|---|---|
| `NotoSansSC-Regular.ttf` | Noto Sans SC（思源黑体，**派生产物**） | **SIL OFL 1.1**，原文见 `OFL-notosanssc.txt` |
| `NotoSansSymbols2-Regular.ttf` | Noto Sans Symbols 2（符号补充，**派生产物**） | **SIL OFL 1.1**，原文见 `OFL-notosanssymbols2.txt` |
| `NotoSerifSC-Regular.ttf` | Noto Serif SC（思源宋体，**派生产物**） | **SIL OFL 1.1**，原文见 `OFL.txt` |
| （构建产物中的 `geist-*.woff2`） | Geist（界面字体） | **SIL OFL 1.1**，原文见 `Geist-OFL.txt` |

- 图纸文字按 `web/src/lib/fonts.ts` 的 `FONT_URLS` **顺序查找**：Sans SC 优先（最接近
  `txt.shx`/`simplex.shx` 的单线观感），Symbols 2 补符号，Serif SC 仅作最后兜底；
  dxf-viewer 只在缺字时才去加载下一个字体，所以后两个平时不产生开销。
- OFL 允许随软件分发，但**必须保留许可原文**，且不得单独售卖字体本身。
- ⚠️ **三个自托管字体都是派生产物**（OFL 允许修改；均未声明 Reserved Font Name，故可保留原名），
  处理脚本见 `scripts/normalize-font.py`：
  1. `fonttools varLib.instancer wght=400` —— 可变字体实例化成**静态 Regular**
     （dxf-viewer 打包的 opentype.js **不支持可变轴**，只渲染默认实例，而 Noto 的默认是 ExtraLight，太细）；
  2. `skia-pathops` 并集**去重叠** —— 消除**自交轮廓**
     （dxf-viewer 用 earcut 三角化，自交字形会被填成**实心块**；实测 `7` 就是因此变成实心块）。
  换字体时必须重跑该脚本，且必须是 **TrueType(glyf)**：CFF/`.otf` 实测会算出 NaN 顶点，
  导致该图**所有 TEXT 被 worker 跳过**、文字图层变成"空层"（开关也会被禁用）。

## 本地字体（运行时读取，**不随包分发**）

SHX 文字由服务端在**本机**读取字体后转成笔画几何（`server/fonts.js` + `server/shx-text.js`）：

- 字体来源是用户机器上**已安装**的设计软件自带字体目录，或系统字体目录，
  或用户在 `data/fonts.json` 里指定的目录；应用只读、不复制、不上传、不再分发。
- ⚠️ **绝不把商业设计软件自带的 SHX/TTF 放进 `web/public/fonts/` 或安装包**：
  `txt.shx`、`simplex.shx`、`gbcbig.shx`、`chineset.shx` 等是受版权保护的商业字体文件。
  本地读取属于用户自己使用自己的授权字体，与再分发是两件事。
- `server` 里的 `/api/font/:name` 是**开发期遗留**的系统字体白名单兜底，产品运行不依赖它；
  正式路径是 `/api/fonts`（列目录）与 `/api/fonts/raw`（按白名单读文件）。

## 服务端用到的第三方库（npm，不随安装包二次分发源码）

| 包 | 版本 | 许可证 | 用途 |
|---|---|---|---|
| `express` / `cors` / `multer` | 4.x / 2.x | MIT | HTTP 服务、跨域、上传 |
| `dxf-parser` | 1.1.x | **MIT** | 服务端解析 DXF 实体（比对引擎；`server/dxf-entities.js`） |
| `@mlightcad/shx-parser` | 1.4.x | **MIT** | 解析 SHX 笔画字体（`server/shx-text.js`） |
| `iconv-lite` | 0.7.x | **MIT** | Unicode → GBK/Big5/Shift-JIS，用做大字体码位映射 |

- 以上均为 MIT：保留版权与许可声明即可，无开源义务。
  它们的源码随 `server/node_modules` 一起打进安装包（npm 分发形态），许可声明位于各自包内，
  **请勿删除**。
- `@mlightcad/shx-parser` 只负责"字符码 → 折线"，不包含任何字体数据；字体本身由用户本机提供。

## 自定义对象（`TCH_*` / `AEC_*`）

- **服务端不依赖**任何 DXF/DWG 原生解析库；含自定义对象的图纸即使不先展开，也会尽量解析这些对象。
- **v52 起**，服务端会**可选地**调用仓库内的 `udo-cli`（Rust，见下）读取 DWG 原生对象，
  把**已验证**的三类几何转成标准 DXF 实体注入 Web DXF：
  - `TCH_OPENING`（门窗洞口）→ LWPOLYLINE / SOLID：AC1018 样张 **525/525**，端点误差中位 0.000000 mm；
  - `TCH_WALL`（墙体）→ 双面墙线：**1959/1959**，面线落点 ≤1e-6 mm 占 99.05%；
  - `TCH_TEXT`（文字）→ TEXT：**665/680**，单行插入点 ≤1e-6 mm 占 97.0%（GBK 内容）。
  - 只渲染 `status=decoded` 的实体：`candidate` 是未验证编码，在 CLI 侧就被安全门丢弃；
  - 没有二进制、探测不到自定义对象、超时、dump 损坏 → 什么都不做，产出与不含该功能时
    **逐字节相同**。
- 仓库内的 `crates/` 是**独立的原生读取工具链**（见
  [`docs/tch-reader-report.md`](./docs/tch-reader-report.md)），Node 侧通过
  `udo-cli` 以 JSON 调用。它不参与 `server/`、`web/` 的构建。
- **能力边界（重要）**：目前只在 **AC1018** 的含自定义对象样张上验证过；
  - 弧形墙（约 0.6% 面线）仍未解出（代理把弧离散成折线，弧参数未找到）；
  - 15 条 `TCH_TEXT`（`raw_len=138`）未解出；
  - 其它 DWG 版本（AC1021/1024/1027）尚未回归，key 探测与框架偏移可能不同。
  超出以上范围的部分仍建议先在设计软件里导出展开后的 DXF（不含自定义对象）。

### crate 划分与许可证

| crate | 许可证 | 说明 |
|---|---|---|
| `crates/dwg-io` | MIT OR Apache-2.0 | 唯一链接 `acadrust` 的薄 DWG 读取层 |
| `crates/udo-core` | MIT OR Apache-2.0 | clean-room 自定义对象解析，仅 `std` + `serde` |
| `crates/udo-cli` | MIT OR Apache-2.0 | JSON CLI（`schema_version: 1`） |

三者与项目自身 AGPL-3.0-only 相互独立。

### 二进制分发（`bin/udo-cli/`）

- 构建：`cargo build --release`，再把 `target/release/udo-cli[.exe]` 复制到 `bin/udo-cli/`
  （见 README「环境要求」）。`bin/udo-cli/` 已被 `.gitignore` 排除，**源码仓库不含二进制**。
- 分发闭源安装包（GitHub Releases / 免安装版）时**必须随附**：
  1. `crates/udo-cli/LICENSE-MIT` 与 `LICENSE-APACHE`（自有代码的双许可，选其一即可满足）；
  2. `crates/NOTICE.md` / `crates/dwg-io/NOTICE`（acadrust 的 MPL-2.0 声明、源码地址、未修改声明）；
  3. `crates/licenses/acadrust-MPL-2.0.txt`（MPL 全文）与 `crates/licenses/acadrust-SOURCE.txt`。
- 本项目自身许可是 AGPL-3.0-only；`udo-cli` 作为**独立可执行程序**以 MIT OR Apache-2.0 分发，
  不与 AGPL 代码混合链接（进程边界 + JSON 契约）。

## acadrust — MPL 2.0（仅 `crates/dwg-io` 使用）

- 包名：`acadrust`，版本 `0.6.8`（`crates/dwg-io/Cargo.toml`）
- 上游：https://github.com/hakanaktt/acadrust ；发布：https://crates.io/crates/acadrust
- **许可证：Mozilla Public License 2.0（MPL-2.0）。**
- 用途：读取原生 DWG 容器（文件头、section map、object map、merged object stream、
  CLASSES 解析）。**只有 `dwg-io` 链接它**；`udo-core` 完全不含第三方 DWG 代码。

### 我们的当前做法（合规）

1. **未修改 acadrust 的任何源文件**：以 crates.io 发布版本作为普通依赖链接，
   没有 vendor、没有 patch、没有 `[patch]` 覆盖。MPL-2.0 是文件级 copyleft，
   未修改即不产生「公开被改文件」的义务。
2. `crates/NOTICE.md` 与 `crates/dwg-io/NOTICE` 保留了 acadrust 的 MPL-2.0 声明、
   源码获取地址与「未修改」声明；acadrust 自身的 `LICENSE` 随其 crate 包分发。
3. `dwg-io` 是独立作品（只调用 acadrust 的公开 API），因此可以按
   `MIT OR Apache-2.0` 分发；若将来需要修改 acadrust 源码，必须把被改文件以
   MPL-2.0 公开。
4. **分发二进制（`udo-cli`）时必须随附**：MPL-2.0 全文、源码获取地址
   （<https://crates.io/crates/acadrust/0.6.8>）、acadrust 未修改的声明，以及
   acadrust 自带的 `THIRD_PARTY_NOTICES.md`。推荐目录结构见 `crates/NOTICE.md`。
5. 若将来把自定义对象解析并入产品（AGPL-3.0-only），仍需保留 acadrust 的 MPL 声明；
   AGPL 与 MPL 在「文件级」上兼容，但**不要**把 acadrust 代码内联进 AGPL 文件。
