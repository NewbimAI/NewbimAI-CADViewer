import type { OpenResult } from "./types";

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
