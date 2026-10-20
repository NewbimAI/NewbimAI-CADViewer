import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownNarrowWide, ArrowDownAZ, Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
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
    // 只列"本图真的用到"的块定义。
    // ⚠️ 不能只看 refCount：它只数顶层 INSERT，块定义仍可能被别的块内部引用（nestedRefCount）。
    //    实测规律：refCount=0 的块里，多数其实被块内嵌套引用（例如某个设备类块被嵌 8 次），
    //    只按 refCount 过滤会凭空隐藏这些正在用的块；两者都为 0 才是 PURGE 残留。
    const used = (b: BlockInfo) =>
      b.used === undefined
        ? (b.refCount || 0) > 0 || (b.nestedRefCount || 0) > 0
        : b.used !== false;
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
            <button
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title="清空"
              onClick={() => setQuery("")}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <Button
          variant="outline"
          size="icon-sm"
          className="shrink-0"
          title={
            sortBy === "count"
              ? "当前按引用次数排序，点击改为按名称"
              : "当前按名称排序，点击改为按引用次数"
          }
          onClick={() => setSortBy((s) => (s === "count" ? "name" : "count"))}
        >
          {sortBy === "count" ? <ArrowDownNarrowWide /> : <ArrowDownAZ />}
        </Button>
      </div>

      {/* 图块表 */}
      <div className="min-h-0 flex-1 border-t">
        <ScrollArea className="h-full">
          <table
            className="w-full table-fixed text-sm"
            style={{ fontFamily: '"Microsoft YaHei", "微软雅黑", "PingFang SC", sans-serif' }}
          >
            <thead className="sticky top-0 z-10 bg-card shadow-[0_1px_0_var(--border)]">
              <tr className="text-xs text-muted-foreground">
                <th className="whitespace-nowrap py-2 pl-4 text-left font-medium">
                  图块名
                </th>
                <th className="w-16 whitespace-nowrap py-2 text-right font-medium">
                  引用
                </th>
                <th className="w-16 whitespace-nowrap py-2 pr-4 text-right font-medium">
                  实体
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
                        <div
                          className="truncate font-sans text-sm font-medium tracking-tight"
                          title={b.name}
                        >
                          {b.name}
                        </div>
                        {missingDef && (
                          <div className="truncate text-[11px] leading-4 text-muted-foreground/70">
                            定义不在本图
                          </div>
                        )}
                      </div>
                    </td>
                    <td
                      className="py-2 text-right text-sm font-medium tabular-nums"
                      title={
                        b.anonymousRefCount
                          ? `其中 ${b.anonymousRefCount} 个来自动态块实例`
                          : undefined
                      }
                    >
                      {formatNumber(b.refCount)}
                    </td>
                    <td className="py-2 pr-4 text-right text-sm tabular-nums text-muted-foreground">
                      {formatNumber(b.entityCount)}
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td
                    colSpan={3}
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
