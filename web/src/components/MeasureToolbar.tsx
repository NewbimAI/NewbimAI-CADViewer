/**
 * 测量工具组（画布底部 dock 的左半边）。
 *
 * 只负责“选工具 / 清空”这类低频交互；所有指针取点、吸附、标注绘制都在
 * `MeasureOverlay` 里。工具之间互斥：点当前工具会收起它（Esc 也能退出）。
 *
 * 观感是胶囊工具条（Google Stitch 那种）：32px 圆形按钮、18px 线性图标、
 * 选中 = 实心圆（浅色主题深色圆 + 白图标，深色主题反过来），未选中只有 hover 浅底。
 * 工具组 / 清除组 / 单位之间用 20px 竖向细线分隔。
 * 外层胶囊容器由 App 提供（测量、缩放是两个独立容器）。
 */
import {
  Crosshair,
  DraftingCompass,
  Eraser,
  Pentagon,
  Radius,
  Route,
} from "lucide-react";
import { useLayoutEffect, useState } from "react";
import type { ComponentType } from "react";

import DockTooltip from "@/components/DockTooltip";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

/** 两点测距：|↔| —— 左右**虚线**挡板 + 中间细长水平线 + 两端指向挡板的小箭头。
 *  lucide 里没有完全一致的形状（UnfoldHorizontal 的竖线在中间），所以内联一个。 */
function DistanceIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {/* 两端竖直虚线挡板 */}
      <path d="M4 6v12M20 6v12" strokeDasharray="2 2.2" strokeWidth={1.3} />
      {/* 中间细长横线 */}
      <path d="M6.5 12h11" strokeWidth={1} />
      {/* 两端小箭头（指向挡板） */}
      <path
        d="M6.5 12l2.4-1.9M6.5 12l2.4 1.9M17.5 12l-2.4-1.9M17.5 12l-2.4 1.9"
        strokeWidth={1.3}
      />
    </svg>
  );
}

/** 工具图标：lucide 图标或内联 SVG 都只要求一个 className */
type MeasureIcon = ComponentType<{ className?: string }>;

/** 六种测量工具（互斥） */
export type MeasureTool =
  | "distance"
  | "length"
  | "area"
  | "angle"
  | "radius"
  | "coord";

export type MeasureToolDef = {
  id: MeasureTool;
  label: string;
  /** 悬浮气泡里的说明 */
  title: string;
  /** 工具激活后显示在工具条上方的操作提示 */
  hint: string;
  icon: MeasureIcon;
  /** 图标尺寸（默认 18px；内联画稿可以单独给 20px） */
  iconClassName?: string;
};

export const MEASURE_TOOLS: MeasureToolDef[] = [
  {
    id: "distance",
    label: "距离",
    title: "距离：单击两点测距",
    hint: "距离 · 单击两点即可出结果，可连续测量",
    icon: DistanceIcon,
    iconClassName: "size-5",
  },
  {
    id: "length",
    label: "连续长度",
    title: "连续长度：连续单击取点，双击或 Enter 结束",
    hint: "连续长度 · 连续取点，双击 / Enter 结束，Backspace 回退",
    icon: Route,
  },
  {
    id: "area",
    label: "面积",
    title: "面积：多边形取点，双击或 Enter 闭合",
    hint: "面积 · 取点后双击 / Enter 闭合，Backspace 回退",
    icon: Pentagon,
  },
  {
    id: "angle",
    label: "角度",
    title: "角度：依次点三点，第二点为顶点",
    hint: "角度 · 依次点三点，第二点为顶点",
    icon: DraftingCompass,
  },
  {
    id: "radius",
    label: "半径",
    title: "半径：在圆或弧上点三点",
    hint: "半径 · 在圆 / 弧上点三点，自动求圆心与半径",
    icon: Radius,
  },
  {
    id: "coord",
    label: "坐标",
    title: "坐标：单击读取该点坐标",
    hint: "坐标 · 单击读取该点坐标",
    icon: Crosshair,
  },
];

export const MEASURE_LABEL: Record<MeasureTool, string> = {
  distance: "距离",
  length: "长度",
  area: "面积",
  angle: "角度",
  radius: "半径",
  coord: "坐标",
};

type Props = {
  /** 当前工具；null = 未激活 */
  active: MeasureTool | null;
  onSelect: (tool: MeasureTool) => void;
  onClear: () => void;
  /** 测量引擎是否可用（图纸已解析 + 索引已建好） */
  canMeasure: boolean;
  /** 不可用时的说明（悬浮气泡） */
  disabledTitle: string;
  /** 已保存的测量条数（决定「清除」是否可点） */
  count: number;
  /** 单位后缀，例如 mm / m */
  units?: string;
  /** 单位全称，例如「单位：毫米」 */
  unitTitle?: string;
};

export default function MeasureToolbar({
  active,
  onSelect,
  onClear,
  canMeasure,
  disabledTitle,
  count,
  units,
  unitTitle,
}: Props) {
  const unitLabel = units ? units : canMeasure ? "—" : "…";
  const activeDef = active
    ? (MEASURE_TOOLS.find((t) => t.id === active) ?? null)
    : null;
  /** 当前工具按钮的 DOM 锚点：操作说明要贴在这个按钮正上方，而不是整条居中 */
  const [hintAnchor, setHintAnchor] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (!active) {
      setHintAnchor(null);
      return;
    }
    setHintAnchor(
      document.querySelector<HTMLElement>(`[data-measure-tool="${active}"]`)
    );
  }, [active]);

  return (
    <div
      role="group"
      aria-label="测量工具"
      data-measure-toolbar="1"
      data-measure-active={active ?? ""}
      className="flex shrink-0 items-center gap-1"
    >
      {MEASURE_TOOLS.map((t) => {
        const on = active === t.id;
        const Icon = t.icon;
        return (
          <DockTooltip
            key={t.id}
            content={canMeasure ? t.title : disabledTitle}
            // 激活工具的上方已经有常驻操作说明，不再叠加一层悬浮提示
            disabled={on}
          >
            <Button
              variant="ghost"
              size="icon"
              // 禁用时仍保留 hover 命中，气泡才能说明"为什么不可用"
              className={cn(
                "rounded-full text-muted-foreground disabled:pointer-events-auto disabled:cursor-not-allowed",
                // 选中 = 实心圆：反色填充 + 反色图标（深色主题自动变成浅圆深图标）
                on &&
                  "bg-primary text-primary-foreground shadow-xs hover:bg-primary/90 hover:text-primary-foreground"
              )}
              aria-label={t.label}
              aria-pressed={on}
              data-measure-tool={t.id}
              data-active={on ? "1" : undefined}
              disabled={!canMeasure}
              onClick={() => onSelect(t.id)}
            >
              <Icon className={t.iconClassName ?? "size-[18px]"} />
            </Button>
          </DockTooltip>
        );
      })}

      <Separator orientation="vertical" className="mx-1 h-5" />

      <DockTooltip
        content={
          count > 0 ? `清除画布上所有测量（${count} 条）` : "还没有测量结果"
        }
      >
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full text-muted-foreground disabled:pointer-events-auto disabled:cursor-not-allowed"
          aria-label="清除测量"
          data-measure-clear="1"
          disabled={!canMeasure || count === 0}
          onClick={onClear}
        >
          <Eraser className="size-[18px]" />
        </Button>
      </DockTooltip>

      {/* 单位读数：空间不够时整组（含分隔线）收起 */}
      <Separator
        orientation="vertical"
        className="mx-1 h-5 @max-[900px]:hidden"
      />
      <DockTooltip
        content={unitTitle ?? "单位未知"}
        wrapperClassName="@max-[900px]:hidden"
      >
        <span className="flex h-8 items-center gap-1 px-1.5 text-[11px] leading-none text-muted-foreground">
          <span className="opacity-70">单位</span>
          <span className="max-w-16 truncate font-medium tabular-nums text-foreground/80">
            {unitLabel}
          </span>
        </span>
      </DockTooltip>

      {/* 当前工具的操作说明：常驻气泡锚定在激活按钮正上方，随按钮位置走 */}
      <DockTooltip
        open={!!activeDef}
        anchor={hintAnchor}
        role="status"
        content={activeDef?.hint}
      />
    </div>
  );
}
