/**
 * 「全部图纸」下拉 —— 标签条放不下时的兜底入口。
 *
 * 触发按钮只在标签溢出或图纸数 > 6 时由 DrawingTabs 挂载；菜单本体走 portal，
 * 不会被标签条的 overflow-hidden 裁掉。列表和标签条吃同一份 tabs，
 * 当前图纸 = ✓ + 浅底高亮；右侧小 × 关闭单张（菜单保持打开，方便连续关）。
 *
 * 观感沿用 Stitch：rounded-xl、popover surface、轻阴影、12.5px、32px 行高、
 * hover 浅底。
 */
import { Menu } from "@base-ui/react/menu";
import { Check, ChevronDown, X } from "lucide-react";

import DockTooltip from "@/components/DockTooltip";
import { cn } from "@/lib/utils";

export type AllDrawingsTab = {
  id: string;
  name: string;
};

type Props = {
  tabs: AllDrawingsTab[];
  activeId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
};

export default function AllDrawingsMenu({
  tabs,
  activeId,
  onActivate,
  onClose,
}: Props) {
  return (
    <Menu.Root modal={false}>
      <DockTooltip content="全部图纸" wrapperClassName="shrink-0">
        <Menu.Trigger
          aria-label="全部图纸"
          className="flex size-7 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 data-[popup-open]:bg-accent data-[popup-open]:text-foreground"
        >
          <ChevronDown className="size-4" />
        </Menu.Trigger>
      </DockTooltip>

      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align="end" className="z-[70]">
          <Menu.Popup
            className="animate-in fade-in-0 zoom-in-95 max-h-[min(22rem,60vh)] w-72 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl bg-popover p-1 text-popover-foreground shadow-[0_18px_44px_-16px_rgba(0,0,0,0.3)] outline-none duration-150"
            data-all-drawings-menu="1"
          >
            <div className="px-2 pb-1 pt-1.5 text-[11px] font-medium text-muted-foreground">
              全部图纸
              <span className="ml-1 tabular-nums opacity-70">
                {tabs.length}
              </span>
            </div>

            {tabs.map((tab) => {
              const active = tab.id === activeId;
              return (
                <div key={tab.id} className="flex items-center gap-1">
                  <Menu.Item
                    closeOnClick
                    onClick={() => onActivate(tab.id)}
                    aria-label={tab.name}
                    className={cn(
                      "flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2 text-[12.5px] outline-none transition-colors",
                      active
                        ? "bg-accent/70 font-medium text-foreground"
                        : "text-foreground/85",
                      "data-[highlighted]:bg-accent data-[highlighted]:text-foreground"
                    )}
                  >
                    <span className="flex size-4 shrink-0 items-center justify-center">
                      {active && <Check className="size-3.5" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{tab.name}</span>
                  </Menu.Item>
                  <DockTooltip
                    content="关闭这张图纸"
                    wrapperClassName="shrink-0 mr-0.5"
                  >
                    <button
                      type="button"
                      aria-label={`关闭 ${tab.name}`}
                      // 不把焦点从菜单项挪走：点 × 关掉一张后菜单保持打开，方便连续关
                      onPointerDown={(e) => e.preventDefault()}
                      onClick={(e) => {
                        e.stopPropagation();
                        onClose(tab.id);
                      }}
                      className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/55 transition-colors hover:bg-foreground/10 hover:text-foreground"
                    >
                      <X className="size-3" />
                    </button>
                  </DockTooltip>
                </div>
              );
            })}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
