/**
 * 模型 / 布局页签（AutoCAD 风格）。
 *
 * 只在图纸真的有布局时出现（服务端 /api/open 的 `spaces` 多于一项）；
 * 单空间图纸不渲染，保持原来"没有页签"的样子。
 *
 * 规则：
 *   · 只有 1 个布局 → `模型 | 平面图` 两个胶囊平铺；
 *   · 多于 1 个布局 → `模型 | 布局 ▾`，点"布局"向上弹出浮层列出全部布局，
 *     不再把布局名平铺成长排（AutoCAD 里也是这样收起的）。
 *
 * 视觉沿用画布 dock 的语言：胶囊容器 + 浅色 surface + backdrop blur，
 * 选中项用浅底/阴影，而不是浏览器默认 tab 的下划线。
 */
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";
import type { DrawingSpace } from "@/types";

type Props = {
  spaces: DrawingSpace[];
  active: string;
  onSelect: (id: string) => void;
};

const isLayout = (s: DrawingSpace) => s.id.startsWith("layout:");

export default function SpaceTabs({ spaces, active, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  /* 点击外部 / Esc 收起浮层；切换空间后由 onSelect 自己收 */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const layouts = spaces.filter(isLayout);
  if (spaces.length <= 1) return null;

  const activeLayout = layouts.find((l) => l.id === active) ?? null;
  const inLayout = activeLayout !== null;
  const hasManyLayouts = layouts.length > 1;

  const pill = (on: boolean) =>
    cn(
      "h-6 shrink-0 rounded-full px-2.5 text-[11px] leading-none transition-colors",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card",
      on
        ? "bg-secondary text-secondary-foreground shadow-xs"
        : "text-muted-foreground hover:bg-muted hover:text-foreground"
    );

  return (
    <div
      ref={rootRef}
      role="tablist"
      aria-label="模型与布局"
      data-space-tabs="1"
      className="pointer-events-auto relative flex max-w-[calc(100vw-2rem)] items-center gap-0.5 rounded-full border border-border/60 bg-card/90 p-1 shadow-sm backdrop-blur-sm"
    >
      <button
        type="button"
        role="tab"
        aria-selected={!inLayout}
        data-space-id="model"
        onClick={() => {
          setOpen(false);
          if (inLayout) onSelect("model");
        }}
        className={pill(!inLayout)}
      >
        模型
      </button>

      {!hasManyLayouts && layouts[0] && (
        <button
          type="button"
          role="tab"
          aria-selected={inLayout}
          data-space-id={layouts[0].id}
          onClick={() => {
            setOpen(false);
            if (!inLayout) onSelect(layouts[0].id);
          }}
          className={pill(inLayout)}
        >
          {layouts[0].name}
        </button>
      )}

      {hasManyLayouts && (
        <>
          <button
            type="button"
            role="tab"
            aria-selected={inLayout}
            aria-haspopup="menu"
            aria-expanded={open}
            data-space-id="__layout_menu__"
            onClick={() => setOpen((v) => !v)}
            className={cn(pill(inLayout), "flex items-center gap-1")}
          >
            {/* 已选中某个布局时只显示布局名（不再前缀「布局」二字）；
                还没进布局时才显示「布局」作为动作入口。 */}
            <span className="max-w-28 truncate">
              {activeLayout ? activeLayout.name : "布局"}
            </span>
            <ChevronDown
              className={cn("h-3 w-3 transition-transform", open && "rotate-180")}
              aria-hidden
            />
          </button>

          {open && (
            <div
              role="menu"
              aria-label="选择布局"
              data-space-menu="1"
              className="absolute bottom-full left-0 z-30 mb-1.5 min-w-36 max-w-[min(20rem,calc(100vw-2rem))] rounded-2xl border border-border/60 bg-card/95 p-1 shadow-lg backdrop-blur"
            >
              {layouts.map((l) => {
                const on = l.id === active;
                return (
                  <button
                    key={l.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={on}
                    data-space-id={l.id}
                    onClick={() => {
                      setOpen(false);
                      if (!on) onSelect(l.id);
                    }}
                    className={cn(
                      "flex w-full items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-left text-[11px] transition-colors",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      on
                        ? "bg-secondary text-secondary-foreground"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{l.name}</span>
                    {on && <Check className="h-3 w-3 shrink-0" aria-hidden />}
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
