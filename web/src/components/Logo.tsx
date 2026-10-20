import { cn } from "@/lib/utils";

/**
 * CADViewer 标志 ——「视口准星」
 *
 * 设计意图（勿轻易改动几何，改动请同步 web/public/favicon.svg 与 logo.svg）：
 *  - 四角标 = CAD 图框/视口，直接说明"看图"这件事；
 *  - 十字准星 + 方形拾取框 = AutoCAD 光标本体，是 CAD 用户一眼认得的符号；
 *  - 全几何、零文字、零色相（跟随 currentColor），与全站单色系（chroma=0）一致；
 *  - 32 网格上内容盒 3.8~28.2，缩到 16px 仍不糊边。
 *
 * 颜色一律走 currentColor：放置处用 text-foreground / cv-text 控制，
 * 深色画布上自动反白，不需要额外出反色版本。
 */
export function Logo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={cn("shrink-0", className)}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="CADViewer"
    >
      {/* 视口四角标 */}
      <g stroke="currentColor" strokeWidth={2.5} strokeLinecap="square">
        <path d="M3.8 11V3.8H11" />
        <path d="M21 3.8H28.2V11" />
        <path d="M28.2 21V28.2H21" />
        <path d="M11 28.2H3.8V21" />
      </g>
      {/* 十字准星（被拾取框断开，与 CAD 内光标一致） */}
      <g stroke="currentColor" strokeWidth={2.2} strokeLinecap="round">
        <path d="M9 16H13.1" />
        <path d="M18.9 16H23" />
        <path d="M16 9V13.1" />
        <path d="M16 18.9V23" />
      </g>
      {/* 拾取框 */}
      <rect
        x="13.1"
        y="13.1"
        width="5.8"
        height="5.8"
        rx="1"
        stroke="currentColor"
        strokeWidth={2.1}
      />
    </svg>
  );
}

export default Logo;
