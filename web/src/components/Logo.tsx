import { cn } from "@/lib/utils";
import { BrandMark } from "./BrandMark";

/**
 * 应用标志：NewbimAI 品牌标记（像素「N」）。
 *
 * 形状来自设计师导出的 PNG（256px），已在 BrandMark.tsx 中按连通域还原成矢量矩形；
 * 颜色走 currentColor，所以浅底/深底都跟随文字色，不需要另做反色版本。
 * 改形状请改源 PNG 后重跑追踪脚本，不要手改矩形坐标。
 */
export function Logo({ className }: { className?: string }) {
  return <BrandMark className={cn("shrink-0", className)} />;
}

export default Logo;
