import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownNarrowWide, ArrowDownAZ, Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import DockTooltip from "@/components/DockTooltip";
import FollowTooltip from "@/components/FollowTooltip";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn, formatNumber } from "@/lib/utils";
import type { BlockInfo, DxfFocus } from "@/types";

interface BlocksTabProps {
  blocks: BlockInfo[];
  /** 当前聚焦（图层或图块） */
  focus?: DxfFocus | null;
  onSetFocus: (kind: DxfFocus["kind"], name: string) => void;
  onClearFocus: () => void;
}

/** 有引用但没有块定义 → 画布上定位不到任何东西（如溯源出来的 BLOCK_X） */
function isDefinedBlock(b: BlockInfo): boolean {
  return b.defined !== false;
}

function isFocusableBlock(b: BlockInfo): boolean {
  return isDefinedBlock(b);
}

export default function BlocksTab({
  blocks,
  focus,
  onSetFocus,
  onClearFocus,
}: BlocksTabProps) {
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<"count" | "name">("count");

  // 与 LayersTab 同一套单击/双击消歧：单击稍后清空，双击立即设置
  const clickTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (clickTimer.current !== null) window.clearTimeout(clickTimer.current);
    },
    []
  );
  const handleRowClick = () => {
    if (clickTimer.current !== null) return;
    // 本来就没有聚焦：这次单击不该有任何效果，别装 300ms 定时器（普通单击零延迟）。
    // 有聚焦时保留 300ms 消歧窗口，让双击有机会取消它。
    if (!focus) return;
    clickTimer.current = window.setTimeout(() => {
      clickTimer.current = null;
      onClearFocus();
    }, 300);
  };
  const handleRowDoubleClick = (name: string) => {
    if (clickTimer.current !== null) {
      window.clearTimeout(clickTimer.current);
      clickTimer.current = null;
    }
    onSetFocus("block", name);
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    // 数量为 0 的块定义（含仅被嵌套引用、或残留待 PURGE 的）不在此列表展示，避免噪声。
    const used = (b: BlockInfo) => (b.refCount || 0) > 0;
    const base = blocks.filter(used);
    const list = q
      ? base.filter((b) => b.name.toLowerCase().includes(q))
      : base;
    return [...list].sort((a, b) =>
      sortBy === "count"
        ? (b.refCount || 0) - (a.refCount || 0) ||
          (b.entityCount || 0) - (a.entityCount || 0)
        : a.name.localeCompare(b.name, "zh-CN")
    );
  }, [blocks, query, sortBy]);

  if (blocks.length === 0) {
    return (
      <div className="p-4 text-xs text-muted-foreground">未获取到图块信息</div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* 搜索 + 排序 */}
      <div className="flex items-center gap-2 px-4 pb-2.5 pt-3">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索图块名"
            className="h-9 pl-9 pr-9 text-sm"
          />
          {query && (
            <DockTooltip
              content="清空搜索"
              wrapperClassName="absolute right-2 top-1/2 -translate-y-1/2"
            >
              <button
                aria-label="清空搜索"
                className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                onClick={() => setQuery("")}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </DockTooltip>
          )}
        </div>
        <DockTooltip
          content={
            sortBy === "count"
              ? "按引用次数排序 · 点击改为按名称"
              : "按名称排序 · 点击改为按引用次数"
          }
          wrapperClassName="shrink-0"
        >
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={sortBy === "count" ? "改为按名称排序" : "改为按引用次数排序"}
            onClick={() => setSortBy((s) => (s === "count" ? "name" : "count"))}
          >
            {sortBy === "count" ? <ArrowDownNarrowWide /> : <ArrowDownAZ />}
          </Button>
        </DockTooltip>
      </div>

      {/* 图块表 */}
      <div className="min-h-0 flex-1 border-t">
        <ScrollArea className="h-full">
          <table
            className="w-full table-fixed text-xs"
            style={{ fontFamily: '"Microsoft YaHei", "微软雅黑", "PingFang SC", sans-serif' }}
          >
            <thead className="sticky top-0 z-10 bg-card shadow-[0_1px_0_var(--border)]">
              <tr className="text-[11px] text-muted-foreground">
                <th className="whitespace-nowrap py-2 pl-4 text-left font-medium">
                  图块名
                </th>
                <th className="w-16 whitespace-nowrap py-2 pr-4 text-right font-medium">
                  数量
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((b) => {
                const focused = focus?.kind === "block" && focus.name === b.name;
                const missingDef = !isDefinedBlock(b);
                const focusable = isFocusableBlock(b);
                return (
                  <tr
                    key={b.name}
                    onClick={focusable ? handleRowClick : undefined}
                    onDoubleClick={
                      focusable ? () => handleRowDoubleClick(b.name) : undefined
                    }
                    className={cn(
                      "border-t border-border/50 transition-colors",
                      // 不可定位的行不给 hover 反馈，免得暗示"双击能高亮"
                      focusable && "hover:bg-accent/50",
                      focused && "bg-muted"
                    )}
                  >
                    <td className="py-1.5 pl-4 pr-2">
                      <div className="min-w-0">
                        <FollowTooltip
                          content={b.name}
                          focusable
                          wrapperClassName="block max-w-full truncate rounded-sm text-xs font-medium tracking-tight focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/30"
                        >
                          {b.name}
                        </FollowTooltip>
                        {missingDef && (
                          <div className="truncate text-[11px] leading-4 text-muted-foreground/70">
                            定义不在本图
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="py-1.5 pr-4 text-right text-xs font-medium tabular-nums">
                      {formatNumber(b.refCount)}
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td
                    colSpan={2}
                    className="py-6 text-center text-xs text-muted-foreground"
                  >
                    没有匹配「{query}」的图块
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </ScrollArea>
      </div>
    </div>
  );
}
