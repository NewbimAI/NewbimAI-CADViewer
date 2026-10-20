import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownNarrowWide, ArrowDownAZ, Search, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { cn, formatNumber } from "@/lib/utils";
import type { DxfFocus, LayerInfo } from "@/types";

interface LayersTabProps {
  layers: LayerInfo[];
  visibleMap: Record<string, boolean>;
  onToggleLayer: (name: string, visible: boolean) => void;
  /**
   * 画布实际读到的图层名集合（dxf-viewer 的 `GetLayers(true)`）。
   * 只有真实存在于图纸里的层才允许开关——统计清单里可能出现画布根本没有的层；
   * 画布还没读出图层时（加载中）一律禁用，避免点了没反应。
   */
  availableLayers?: Set<string>;
  /** 被"没有实体"过滤掉、未在列表里显示的图层数（汇总徽标用） */
  hiddenEmptyCount?: number;
  /** 当前聚焦（图层或图块） */
  focus?: DxfFocus | null;
  onSetFocus: (kind: DxfFocus["kind"], name: string) => void;
  onClearFocus: () => void;
}

export default function LayersTab({
  layers,
  visibleMap,
  onToggleLayer,
  availableLayers,
  hiddenEmptyCount,
  focus,
  onSetFocus,
  onClearFocus,
}: LayersTabProps) {
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<"count" | "name">("count");

  // 单击/双击消歧：单击延迟清空聚焦，双击取消计时器改为设置聚焦，
  // 否则双击会先触发一次 clear 再 set，白白多下载一次。
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
    onSetFocus("layer", name);
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? layers.filter((l) => l.name.toLowerCase().includes(q))
      : layers;
    return [...list].sort((a, b) =>
      sortBy === "count"
        ? b.entityCount - a.entityCount
        : a.name.localeCompare(b.name, "zh-CN")
    );
  }, [layers, query, sortBy]);

  const hiddenCount = layers.filter((l) => visibleMap[l.name] === false).length;

  if (layers.length === 0) {
    return (
      <div className="p-4 text-xs text-muted-foreground">未获取到图层信息</div>
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
            placeholder="搜索图层名"
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
              ? "当前按实体数排序，点击改为按名称"
              : "当前按名称排序，点击改为按实体数"
          }
          onClick={() => setSortBy((s) => (s === "count" ? "name" : "count"))}
        >
          {sortBy === "count" ? <ArrowDownNarrowWide /> : <ArrowDownAZ />}
        </Button>
      </div>

      {/* 状态行 */}
      <div className="flex items-center justify-between gap-2 px-4 pb-2.5 text-xs text-muted-foreground">
        <span className="truncate">
          {query
            ? `${filtered.length} / ${layers.length} 个图层`
            : `共 ${layers.length} 个图层`}
          {hiddenCount > 0 && ` · 已隐藏 ${hiddenCount}`}
        </span>
        {availableLayers && availableLayers.size > 0 ? (
          <span className="flex shrink-0 items-center gap-1.5 text-foreground/80">
            <span className="h-1.5 w-1.5 rounded-full bg-foreground/60" />
            图层控制就绪
          </span>
        ) : (
          <span className="flex shrink-0 items-center gap-1.5">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-foreground/50" />
            图层加载中
          </span>
        )}
      </div>

      {/* 图层表 */}
      <div className="min-h-0 flex-1 border-t">
        <ScrollArea className="h-full">
          <table className="w-full table-fixed text-sm">
            <thead className="sticky top-0 z-10 bg-card shadow-[0_1px_0_var(--border)]">
              <tr className="text-xs text-muted-foreground">
                <th className="w-12 whitespace-nowrap py-2 pl-4 text-left font-medium">
                  显隐
                </th>
                <th className="w-8 whitespace-nowrap py-2 text-left font-medium">
                  色
                </th>
                <th className="whitespace-nowrap py-2 text-left font-medium">
                  图层名
                </th>
                <th className="w-16 whitespace-nowrap py-2 pr-4 text-right font-medium">
                  实体数
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((l) => {
                // 只有画布真的读到了这个层，开关才有意义
                const canToggle = !!availableLayers?.has(l.name);
                const visible = visibleMap[l.name] !== false;
                const focused = focus?.kind === "layer" && focus.name === l.name;
                return (
                  <tr
                    key={l.name}
                    onClick={handleRowClick}
                    onDoubleClick={() => handleRowDoubleClick(l.name)}
                    className={cn(
                      "border-t border-border/50 transition-colors hover:bg-accent/50",
                      !visible && "opacity-40",
                      focused && "bg-muted"
                    )}
                  >
                    {/* 开关单元格必须截断冒泡：否则点开关会连带触发聚焦/还原 */}
                    <td
                      className="py-1.5 pl-4"
                      onClick={(e) => e.stopPropagation()}
                      onDoubleClick={(e) => e.stopPropagation()}
                    >
                      <Switch
                        size="sm"
                        checked={visible}
                        disabled={!canToggle}
                        onCheckedChange={(v) => onToggleLayer(l.name, v)}
                      />
                    </td>
                    <td className="py-1.5">
                      <span
                        className="block h-4 w-4 rounded-sm border border-foreground/25"
                        style={{ backgroundColor: l.colorHex }}
                      />
                    </td>
                    <td
                      className="truncate py-1.5 pr-2 font-sans text-sm font-medium tracking-tight"
                      title={l.name}
                    >
                      {l.name}
                    </td>
                    <td className="py-1.5 pr-4 text-right text-sm tabular-nums text-muted-foreground">
                      {formatNumber(l.entityCount)}
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td
                    colSpan={4}
                    className="py-6 text-center text-xs text-muted-foreground"
                  >
                    没有匹配「{query}」的图层
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {/* 汇总徽标 */}
          <div className="flex flex-wrap gap-2 px-4 py-3">
            <Badge variant="secondary">
              冻结 {layers.filter((l) => l.frozen).length}
            </Badge>
            <Badge variant="secondary">
              锁定 {layers.filter((l) => l.locked).length}
            </Badge>
            <Badge variant="secondary">关闭 {layers.filter((l) => l.off).length}</Badge>
            <Badge
              variant="secondary"
              title="没有实体的图层已从列表隐藏，这里是被隐藏的数量"
            >
              空图层 {hiddenEmptyCount ?? 0}（已隐藏）
            </Badge>
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
