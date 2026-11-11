/**
 * 视图控制组（画布底部 dock 的右半边）。
 *
 * 缩小 · 百分比（点击适应窗口）· 放大 | 适应窗口 | 聚焦 | 主题。
 *
 * 观感和测量组完全同构：32px 圆形按钮、18px 线性图标、选中 = 实心圆，
 * 不同功能组之间用 20px 竖向细线分隔。外层胶囊容器由 App 提供。
 *
 * 「聚焦」是**动作**而不是开关：按下去闪一下实心圆，140ms 后自己褪回 ghost。
 * 它背后确实还是全图 / 主体的来回切换，但一旦常驻深色就会被读成"当前处于聚焦模式"，
 * 既和实际状态对不上，也和测量组那种持久选中混为一谈——所以这里不做持久高亮，
 * 也不挂 aria-pressed。
 */
import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { Maximize2, Minus, Moon, Plus, ScanSearch, Sun } from "lucide-react";

import DockTooltip from "@/components/DockTooltip";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

/** 按下后深色底停留时长（ms）。140–180 之间，够看清又不至于像"选中"。 */
const PRESS_FLASH_MS = 140;

type Props = {
  /** 缩放百分比的文本节点：App 直接写 textContent，避免整树重渲染 */
  scaleRef: RefObject<HTMLSpanElement>;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  /** 全图 / 主体的来回切换由 App 管；这里不再用它来决定按钮长相 */
  fullView: boolean;
  onToggleFullView: () => void;
  dark: boolean;
  onToggleTheme: () => void;
};

export default function ViewToolbar({
  scaleRef,
  onZoomIn,
  onZoomOut,
  onFit,
  onToggleFullView,
  dark,
  onToggleTheme,
}: Props) {
  /** 按下瞬间的深色底；PRESS_FLASH_MS 后自动熄灭 */
  const [pressed, setPressed] = useState(false);
  const flashTimer = useRef<number | null>(null);

  // 卸载时清掉没跑完的计时器，别对着已卸载的组件 setState
  useEffect(
    () => () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
      flashTimer.current = null;
    },
    []
  );

  const handleFullView = () => {
    // 连点：重置计时，别让上一次的计时把这次的高亮提前收掉
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    setPressed(true);
    flashTimer.current = window.setTimeout(() => {
      flashTimer.current = null;
      setPressed(false);
    }, PRESS_FLASH_MS);
    onToggleFullView();
  };

  return (
    <div
      role="group"
      aria-label="视图控制"
      data-view-toolbar="1"
      className="flex shrink-0 items-center gap-1"
    >
      <DockTooltip content="缩小">
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full text-muted-foreground"
          aria-label="缩小"
          onClick={onZoomOut}
        >
          <Minus className="size-[18px]" />
        </Button>
      </DockTooltip>
      <DockTooltip content="适应窗口（双击画布 / F 键）">
        <button
          type="button"
          className="flex h-8 min-w-10 items-center justify-center rounded-full px-1.5 text-xs tabular-nums text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label="适应窗口"
          onClick={onFit}
        >
          <span ref={scaleRef} className="tabular-nums">
            100%
          </span>
        </button>
      </DockTooltip>
      <DockTooltip content="放大">
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full text-muted-foreground"
          aria-label="放大"
          onClick={onZoomIn}
        >
          <Plus className="size-[18px]" />
        </Button>
      </DockTooltip>

      <Separator orientation="vertical" className="mx-1 h-5" />

      <DockTooltip content="适应窗口（双击画布 / F 键）">
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full text-muted-foreground"
          aria-label="适应窗口"
          onClick={onFit}
        >
          <Maximize2 className="size-[18px]" />
        </Button>
      </DockTooltip>

      <Separator orientation="vertical" className="mx-1 h-5" />

      <DockTooltip content="聚焦">
        <Button
          variant="ghost"
          size="icon"
          // 深色底只在按下后的一瞬出现，然后自己褪回 ghost；
          // transition-colors（150ms）负责松开时的渐隐，和同排按钮同一套 hover 手感。
          className={cn(
            "rounded-full transition-colors duration-150",
            pressed
              ? "bg-primary text-primary-foreground shadow-xs hover:bg-primary/90 hover:text-primary-foreground"
              : "text-muted-foreground"
          )}
          aria-label="聚焦"
          onClick={handleFullView}
          // 按下这一帧把过渡时长压成 0：深色底必须"瞬间"到位，不能花 150ms 慢慢变深；
          // 松开时这条内联样式被移除，transition-colors 的 150ms 才接管，于是回 grey 是渐隐的。
          style={pressed ? { transitionDuration: "0ms" } : undefined}
        >
          <ScanSearch className="size-[18px]" />
        </Button>
      </DockTooltip>

      <Separator orientation="vertical" className="mx-1 h-5" />

      <DockTooltip content={dark ? "切换浅色画布" : "切换深色画布"}>
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full text-muted-foreground"
          aria-label={dark ? "切换浅色画布" : "切换深色画布"}
          onClick={onToggleTheme}
        >
          {dark ? (
            <Sun className="size-[18px]" />
          ) : (
            <Moon className="size-[18px]" />
          )}
        </Button>
      </DockTooltip>
    </div>
  );
}
