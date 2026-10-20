/**
 * Web DXF 构建子进程。
 * 大图（90MB+ DXF）的解码 + 表格/块文字注入要几秒，放主进程会把事件循环堵死、整站假死，
 *
 * 参数：[源 DXF, web-vN.dxf, 源 DWG(可选), focus 串(可选), focus 名字集合 JSON(可选)]
 * 第三个参数（源 DWG）保留解析但本版不再使用 —— 曾用于天正桥接，现已摘除。
 * 第四个参数是聚焦串（`layer:<图层名>` / `block:<图块名>`），空串表示普通产物。
 * 第五个参数只对 block 聚焦有意义：原块名 + 被并入的匿名表示块名（JSON 数组）。
 */
import { buildWebDxf, parseFocus } from "./dxf-web.js";

const [src, out, , focusSpec, focusNamesJson] = process.argv.slice(2);
const focus = focusSpec ? parseFocus(focusSpec) : null;
if (focus && focus.kind === "block" && focusNamesJson) {
  try {
    const names = JSON.parse(focusNamesJson);
    if (Array.isArray(names) && names.length) focus.names = names.filter((n) => typeof n === "string");
  } catch {
    /* 名字集合不合法就退回 [focus.name] */
  }
}

try {
  const stats = buildWebDxf(src, out, focus);
  process.send({ type: "done", stats });
} catch (e) {
  process.send({ type: "error", error: e instanceof Error ? e.message : String(e) });
  process.exitCode = 1;
}
