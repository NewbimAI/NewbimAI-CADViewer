import { Maximize2, ScanSearch, TriangleAlert } from "lucide-react";

import { ScrollArea } from "@/components/ui/scroll-area";
import { cn, formatBytes, formatNumber } from "@/lib/utils";
import type { OpenResult } from "@/types";

const ACADVER: Record<string, string> = {
  AC1009: "R12",
  AC1012: "R13",
  AC1014: "R14",
  AC1015: "R2000",
  AC1018: "R2004",
  AC1021: "R2007",
  AC1024: "R2010",
  AC1027: "R2013",
  AC1032: "R2018",
};

interface OverviewTabProps {
  file: OpenResult;
}

/**
 * 概览：整块只用面板自身的一张 surface，不再叠卡片。
 * 分组靠间距 + 细分隔线，信息密度和层级靠字号/字重/对齐拉开。
 */
export default function OverviewTab({ file }: OverviewTabProps) {
  const stats = file.stats;
  const typeEntries = stats
    ? Object.entries(stats.entities.byType).sort((a, b) => b[1] - a[1])
    : [];
  const maxCount = typeEntries[0]?.[1] || 1;

  // 主体范围 = 默认视图（内容盒优先）；全图范围 = 图纸实测全幅（用 `extents`，
  // 与画布「全图」按钮取景的范围是同一套坐标，见 DxfCanvas 的 fitAll）
  const mainBox = stats?.contentBox || stats?.coreExtents || stats?.extents;
  const fullBox = stats?.extents;
  const hasOuterContent =
    !!fullBox &&
    !!mainBox &&
    (fullBox.width > mainBox.width * 1.15 ||
      fullBox.height > mainBox.height * 1.15);

  const blockDefCount = stats
    ? // 与「图块」列表面口径一致：只算本图真的用到的定义
      // （refCount>0 或 nestedRefCount>0；两者都为 0 的是 PURGE 残留，列表也不显示）
      stats.blocks.length - (stats.unusedBlockDefCount ?? 0)
    : null;
  const layerCount = stats
    ? // 与「图层」面板表头「共 N 个图层」对齐：统计**全部图层**（含空图层）。
      // 之前这里只数“有实体”的层，导致概览 30 / 面板 31 对不上。
      stats.layers.length
    : null;

  const udo = file.udo;
  const isUdoObjects = udo?.level === "objects";
  /* v51：天正洞口已由 `udo-cli` 解析过一部分（当前只有门窗洞口是"已验证"，
   * 墙体/文字仍未解）。`decoded` 是服务端"已尝试解析"的实体数；老缓存没有该字段 → 0。 */
  const udoDecoded = udo?.decoded ?? 0;

  // 四个数字放一行：最长的那个决定整组字号，避免个别大数被截断或整组跳字号
  const statItems = [
    {
      label: "实体总数",
      value: stats ? formatNumber(stats.entities.total) : "—",
    },
    {
      label: "图块引用",
      value: stats ? formatNumber(stats.entities.inserts) : "—",
    },
    {
      label: "图块定义",
      value: blockDefCount != null ? formatNumber(blockDefCount) : "—",
    },
    {
      label: "图层数量",
      value: layerCount != null ? formatNumber(layerCount) : "—",
    },
  ];
  const longestStat = Math.max(...statItems.map((s) => s.value.length));
  const statSize =
    longestStat >= 9
      ? "text-[17px]"
      : longestStat >= 7
        ? "text-[20px]"
        : "text-[22px]";

  return (
    <ScrollArea className="h-full">
      <div className="px-5 pb-6 pt-4">
        {/* ---- 文件 ---- */}
        <dl className="space-y-1.5">
          <InfoRow label="文件名" value={file.name} />
          <InfoRow label="格式" value={file.format} />
          <InfoRow label="大小" value={formatBytes(file.sizeBytes)} />
          {stats?.header?.version && (
            <InfoRow
              label="DWG 版本"
              value={ACADVER[stats.header.version] || stats.header.version}
            />
          )}
          {stats?.header?.insunits != null && (
            <InfoRow label="插入单位" value={unitsLabel(stats.header.insunits)} />
          )}
        </dl>

        {/* ---- 规模 ---- */}
        <div className="@container mt-5 border-t border-border/60 pt-4">
          <div className="grid grid-cols-2 gap-x-3 gap-y-4 @min-[19rem]:grid-cols-4">
            {statItems.map((s) => (
              <Stat key={s.label} label={s.label} value={s.value} size={statSize} />
            ))}
          </div>
        </div>

        {/* ---- 实体构成 ---- */}
        {typeEntries.length > 0 && (
          <div className="mt-5 border-t border-border/60 pt-4">
            <SectionLabel right={`${typeEntries.length} 类`} className="mb-2.5">
              实体构成
            </SectionLabel>
            <div className="space-y-2">
              {typeEntries.slice(0, 18).map(([type, count]) => (
                <div key={type} className="flex items-center gap-3">
                  <span
                    className="w-[6.25rem] shrink-0 truncate font-mono text-[12px] leading-4 text-foreground/85"
                    title={type}
                  >
                    {type}
                  </span>
                  <span className="h-1 flex-1 overflow-hidden rounded-full bg-foreground/[0.08]">
                    <span
                      className="block h-full rounded-full bg-foreground/65"
                      style={{
                        width: `${Math.max(2, (count / maxCount) * 100)}%`,
                      }}
                    />
                  </span>
                  <span className="w-11 shrink-0 text-right text-[12px] leading-4 tabular-nums text-muted-foreground">
                    {formatNumber(count)}
                  </span>
                </div>
              ))}
            </div>
            {typeEntries.length > 18 && (
              <div className="mt-2 text-[11px] text-muted-foreground">
                其余 {typeEntries.length - 18} 类未列出
              </div>
            )}
          </div>
        )}

        {/* ---- 自定义对象提示：inline note，不占一张卡 ---- */}
        {(isUdoObjects || udo?.level === "provenance") && (
          <div
            className={cn(
              "mt-5 border-l-2 pl-3",
              isUdoObjects ? "border-destructive/40" : "border-foreground/20"
            )}
          >
            <div className="flex items-center gap-1.5 text-[12px] font-medium leading-4">
              <ScanSearch className="size-3.5 shrink-0 text-muted-foreground" />
              <span className={cn(isUdoObjects && "text-destructive")}>
                此图含自定义对象，已尝试解析 {udoDecoded} 个
              </span>
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
              未解析的部分请先用支持该对象的软件导出 T3 后打开。
            </p>
          </div>
        )}

        {/* ---- 解析失败 ---- */}
        {!stats && (
          <div className="mt-5 flex items-start gap-2 border-l-2 border-destructive/40 pl-3 text-[12px] leading-relaxed text-destructive">
            <TriangleAlert className="mt-[3px] size-3.5 shrink-0" />
            <span>
              统计信息解析失败{file.statsError ? `：${file.statsError}` : ""}
            </span>
          </div>
        )}
      </div>
    </ScrollArea>
  );
}

/** 尺寸格式化：大数取整，小数保留一位 */
function fmtDim(v: number): string {
  if (Math.abs(v) >= 100) return Math.round(v).toLocaleString("zh-CN");
  return v.toFixed(1);
}

/** 小节标题：11px muted + 可选右侧计数，不用边框也不用底色 */
function SectionLabel({
  children,
  right,
  className,
}: {
  children: string;
  right?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-baseline justify-between gap-3 text-[11px] font-medium leading-4 text-muted-foreground",
        className
      )}
    >
      <span>{children}</span>
      {right && <span className="tabular-nums opacity-80">{right}</span>}
    </div>
  );
}

/** 键值行：label 12px muted / value 13px 右对齐 tabular-nums */
function InfoRow({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-xs leading-5 text-muted-foreground">
        {label}
      </dt>
      <dd className="flex min-w-0 items-baseline justify-end gap-1.5">
        <span
          className="truncate text-[13px] leading-5 tabular-nums text-foreground/90"
          title={value}
        >
          {value}
        </span>
        {hint && (
          <span className="shrink-0 text-[11px] leading-4 text-muted-foreground/80">
            {hint}
          </span>
        )}
      </dd>
    </div>
  );
}

/** 数字组：大数字 + 小标签，无卡片 */
function Stat({
  label,
  value,
  size,
}: {
  label: string;
  value: string;
  size: string;
}) {
  return (
    <div className="min-w-0">
      <div
        className={cn(
          "truncate font-semibold leading-none tracking-tight tabular-nums text-foreground",
          size
        )}
        title={value}
      >
        {value}
      </div>
      <div className="mt-1.5 truncate text-[11px] leading-4 text-muted-foreground">
        {label}
      </div>
    </div>
  );
}

function Dot() {
  return (
    <span aria-hidden className="text-muted-foreground/40">
      ·
    </span>
  );
}

function unitsLabel(u: number | string): string {
  const map: Record<number, string> = {
    0: "无单位",
    1: "英寸",
    2: "英尺",
    4: "毫米",
    5: "厘米",
    6: "米",
    14: "千米",
  };
  const n = typeof u === "string" ? Number(u) : u;
  return map[n] || String(u);
}
