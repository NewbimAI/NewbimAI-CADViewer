/**
 * Web DXF 构建子进程。
 * 大图（90MB+ DXF）的解码 + 表格/块文字注入要几秒，放主进程会把事件循环堵死、整站假死，
 *
 * 参数：[源 DXF, web-vN.dxf, 源 DWG(可选), focus 串(可选), focus 名字集合 JSON(可选),
 *        空间串(可选), contentBox JSON(可选), 天正 dump 路径(可选)]
 * 第三个参数（源 DWG）v51 起用于天正兜底：dump 缓存缺失时就地跑 `udo-cli`。
 * 第四个参数是聚焦串（`layer:<图层名>` / `block:<图块名>`），空串表示普通产物。
 * 第五个参数只对 block 聚焦有意义：原块名 + 被并入的匿名表示块名（JSON 数组）。
 * 第七个参数是 meta.json 里的 stats.contentBox：DXF 直开时源文件旁没有 meta.json，
 * 必须由主进程传进来，否则 filterFlatTexts 没有参照系会整段跳过（v50）。
 * 第八个参数是 `udo-cli` 的 dump JSON（v51，`<cache>/udo-dump.json`）：主进程开图时
 * 已经落盘，这里只读它把洞口几何注进 ENTITIES；缺文件时退回自己解码（同一份缓存）。
 * 第九个参数（v61）是图外散点过滤开关：`"0"` 关闭；缺省/其它值都开启。
 */
import { buildWebDxf, parseFocus, parseSpace } from "./dxf-web.js";

const [src, out, dwgPath, focusSpec, focusNamesJson, spaceSpec, contentBoxJson, udoDumpPath, strayFlag] =
  process.argv.slice(2);
const focus = focusSpec ? parseFocus(focusSpec) : null;
if (focus && focus.kind === "block" && focusNamesJson) {
  try {
    const names = JSON.parse(focusNamesJson);
    if (Array.isArray(names) && names.length) focus.names = names.filter((n) => typeof n === "string");
  } catch {
    /* 名字集合不合法就退回 [focus.name] */
  }
}
const space = spaceSpec ? parseSpace(spaceSpec) : null;
let contentBox = null;
if (contentBoxJson) {
  try {
    const box = JSON.parse(contentBoxJson);
    if (box && Number.isFinite(box.height) && box.height > 0) contentBox = box;
  } catch {
    /* 不合法就当没传：回退 contentBoxOf(srcPath) */
  }
}

try {
  const stats = await buildWebDxf(src, out, focus, {
    space,
    contentBox,
    udoDumpPath: udoDumpPath || "",
    udoSourcePath: dwgPath || "",
    strayFilter: strayFlag !== "0",
  });
  process.send({ type: "done", stats });
} catch (e) {
  process.send({ type: "error", error: e instanceof Error ? e.message : String(e) });
  process.exitCode = 1;
}
