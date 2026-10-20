export { cn } from "cn"

/* ---- 以下为本项目业务辅助函数（shadcn CLI 不管理，重装组件后勿删）---- */

export function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat("zh-CN").format(n);
}
