import type { OpenResult } from "@/types";

/** 导出文件的基名：去掉图纸扩展名 */
function baseName(name: string): string {
  return name.replace(/\.(dwg|dxf)$/i, "") || "drawing";
}

/** 触发一次浏览器下载。objectURL 留一点余量再回收（立刻 revoke 会让部分浏览器取消下载） */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * 统计 JSON：与 `/api/open` 同构（去掉内部会话字段），给下游程序 / 存档用。
 * 只含统计与元数据，不含几何。
 */
export function downloadJson(file: OpenResult): void {
  const payload = {
    name: file.name,
    format: file.format,
    sizeBytes: file.sizeBytes,
    dxfVersion: file.dxfVersion,
    statsOk: file.statsOk,
    statsError: file.statsError ?? null,
    skippedEntities: file.skippedEntities ?? 0,
    stats: file.stats ?? null,
    tch: file.tch ?? null,
    cadcraftInfo: file.cadcraftInfo ?? null,
  };
  downloadBlob(
    new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json;charset=utf-8",
    }),
    `${baseName(file.name)}.json`
  );
}

/**
 * 原始 DXF（**不是**网页用的预处理版）。
 * 服务端 `?raw=1` 会按输入类型给 converted.dxf 或源文件本身 —— 要用 CAD 打开请用这一份。
 */
export function downloadRawDxf(file: OpenResult): void {
  const a = document.createElement("a");
  a.href = `/api/file/${file.id}/dxf?raw=1`;
  a.download = `${baseName(file.name)}.dxf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** 矢量 PDF：服务端把 cadcraft 导出的 SVG 转成 PDF（文字是描边路径，不依赖字体） */
export async function downloadPdf(file: OpenResult): Promise<void> {
  const res = await fetch(`/api/file/${file.id}/pdf`);
  if (!res.ok) {
    const j = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(j?.error || `PDF 生成失败（${res.status}）`);
  }
  downloadBlob(await res.blob(), `${baseName(file.name)}.pdf`);
}

/** PNG 截图落盘（截图本身由画布的 `capturePng` 提供） */
export function downloadPng(blob: Blob, file: OpenResult): void {
  downloadBlob(blob, `${baseName(file.name)}.png`);
}
