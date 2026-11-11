import type {
  CompareRequest,
  CompareResult,
  OpenResult,
  RecentFile,
  UpdateApplyResult,
  UpdateCheck,
  UpdateInfo,
  UpdateJob,
} from "./types";

export async function openByUpload(file: File): Promise<OpenResult> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch("/api/open", { method: "POST", body: fd });
  if (!res.ok) {
    const j = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(j.error || `打开失败 (${res.status})`);
  }
  return res.json();
}

export async function openByPath(path: string): Promise<OpenResult> {
  const res = await fetch("/api/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(j.error || `打开失败 (${res.status})`);
  }
  return res.json();
}

/** 从响应体里取 `{ error }` 文案；拿不到就退回状态码 */
async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const j = (await res.json()) as { error?: unknown };
    if (typeof j.error === "string" && j.error) return j.error;
  } catch {
    /* 非 JSON 响应（网关错误页等）走下面的兜底 */
  }
  return `${fallback} (${res.status})`;
}

/** 最近打开（服务端按打开时间倒序，最多 20 条） */
export async function fetchRecent(): Promise<RecentFile[]> {
  const res = await fetch("/api/recent");
  if (!res.ok) throw new Error(await errorMessage(res, "读取最近打开失败"));
  return res.json();
}

/**
 * 从 Content-Disposition 里取 `filename*=UTF-8''...`。
 * 服务端和前端都会生成同一个文件名；这里只作为兜底/一致性检查。
 */
function downloadNameFrom(res: Response): string | null {
  const raw = res.headers.get("Content-Disposition");
  if (!raw) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(raw);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      return star[1].trim();
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(raw);
  return plain?.[1] ?? null;
}

/**
 * 生成 Word 对比报告（真 .docx，由服务端 docx 库排版）。
 * 请求体可能很大（每张截图 base64），服务端路由单独放宽了 JSON 上限。
 */
export async function requestCompareReport(
  payload: unknown
): Promise<{ blob: Blob; fileName: string | null }> {
  const res = await fetch("/api/compare/report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(await errorMessage(res, "生成报告失败"));
  return { blob: await res.blob(), fileName: downloadNameFrom(res) };
}

/**
 * 图纸比对。坐标是图纸 WCS（见 docs/compare-contract.md §1），
 * 失败时服务端返回 4xx/5xx + `{ error }`。
 */
export async function compareDrawings(
  req: CompareRequest
): Promise<CompareResult> {
  const res = await fetch("/api/compare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error(await errorMessage(res, "比对失败"));
  return res.json();
}

/* ------------------------------------------------------------------ *
 * 自动更新（/api/update/*）
 * 检查/下载/应用都在本机服务里做；页面只发本地请求，启动时也绝不主动联网。
 * ------------------------------------------------------------------ */

/** 当前版本 / 安装目录可写性 / 上次检查 / 下载任务（只读，不联网） */
export async function fetchUpdateStatus(): Promise<UpdateInfo> {
  const res = await fetch("/api/update/status");
  if (!res.ok) throw new Error(await errorMessage(res, "读取更新信息失败"));
  return res.json();
}

/**
 * 主动检查更新（这次会由服务端联网访问发布页）。
 * ⚠️ 离线时服务端返回 200 + `lastCheck.error`，不算异常；只有本地 500 才抛。
 */
export async function checkForUpdate(): Promise<UpdateCheck> {
  const res = await fetch("/api/update/check", { method: "POST" });
  if (!res.ok) throw new Error(await errorMessage(res, "检查更新失败"));
  return res.json();
}

/** 下载并解压更新包：202 返回任务快照，后续进度靠轮询 status */
export async function downloadUpdate(version: string): Promise<UpdateJob> {
  const res = await fetch("/api/update/download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version }),
  });
  if (!res.ok) throw new Error(await errorMessage(res, "下载更新失败"));
  return res.json();
}

/** 应用已就绪的更新包（服务会先写回响应，再退出让脚本接手） */
export async function applyUpdate(
  restart: boolean
): Promise<UpdateApplyResult> {
  const res = await fetch("/api/update/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ restart }),
  });
  if (!res.ok) throw new Error(await errorMessage(res, "应用更新失败"));
  return res.json();
}
