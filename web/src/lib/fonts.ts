/**
 * 字体链与文字渲染参数（dxf-viewer）。
 *
 * 背景（dxf-viewer 1.0.50 实测）：
 *  - `Load({ fonts })` 只接受字体 URL 数组，worker 里 fetch 后用 opentype.js 解析；
 *  - 取字时按数组顺序逐个尝试，谁先有该字符就用谁（懒加载：缺字时才 fetch 下一个）；
 *  - 它**不读** DXF STYLE 表的字体名，也没有 SHX 通道；
 *  - 缺字时用 `textOptions.fallbackChar` 占位（默认 "\uFFFD?"，会画出替换符）；
 *  - 字形曲线用 `textOptions.curveSubdivision` 离散，默认只有 2 —— 这是文字看起来
 *    有棱角的主因。
 *
 * 因此这里只做两件事：给出优先级正确的字体链、提高曲线离散度。
 *
 * 关于编码：**不要**给 `Load()` 传 `fileEncoding`。服务端 `dxf-web.js` 已经把
 * 原图按 `$DWGCODEPAGE` 解码、并统一写成 UTF-8（见该文件 `buildWebDxf`），
 * 浏览器拿到的那份始终是 UTF-8。再传 gbk/big5 会二次解码、把文字变成乱码。
 *
 * 法务：这里的字体都是 OFL/SIL 授权的自由字体，许可文本同目录 `OFL-*.txt`。
 * **不要**把 AutoCAD 自带的 SHX/TTF 放进 `public/fonts/`。
 */

/**
 * 字体查找优先级。顺序即优先级，后面的只在前面缺字时才会被加载。
 *
 * 1. Noto Sans SC —— 无衬线，最接近工程图常用的 txt.shx / simplex.shx；
 *    覆盖 GB 常用字 + Latin + 常见制图符号（± ° ∅ √ ≥ Ⅰ-Ⅻ ⌒）。
 * 2. Noto Sans Symbols 2 —— 补充几何/箭头/杂项符号，只在缺字时才被拉取。
 *
 * 为什么只有两级：原先还挂了 Noto Serif SC 作为最后兜底，但它 14.6 MB，且实测
 * 对三张真实图纸里出现的 731 个字符（Sans + Symbols2 缺 0 个）**贡献为 0**，独占的
 * 48 个字都是与工程图无关的生僻字。删掉后安装包少 14.6 MB，缺字表现不变。
 *
 * 生成方式：Noto Sans SC 官方只发可变字体（fvar），而 dxf-viewer 不支持可变轴，
 * 所以用 fontTools 在 wght=400 处实例化成静态 TTF 后再放入。
 */
export const FONT_URLS: string[] = [
  "/fonts/NotoSansSC-Regular.ttf",
  "/fonts/NotoSansSymbols2-Regular.ttf",
];

export type TextRenderOptions = {
  /**
   * 每条曲线离散段数。默认 2（dxf-viewer 的 DefaultTextOptions）。
   * 16 是"看起来平滑"和"三角形数量"之间的折中：只对实际出现过的字符生成一次，
   * 之后复用缓存。超过 24 对大图纸收益递减、准备时间上升。
   */
  curveSubdivision: number;
  /** 缺字占位符。默认 "\uFFFD?" 会画出替换符菱形，改成 "?" 更安静。 */
  fallbackChar: string;
};

export const TEXT_OPTIONS: TextRenderOptions = {
  curveSubdivision: 16,
  fallbackChar: "?",
};
