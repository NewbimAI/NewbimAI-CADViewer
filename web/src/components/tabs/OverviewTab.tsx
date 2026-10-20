import {
  Boxes,
  Component,
  Copy,
  Layers,
  ScanSearch,
} from "lucide-react";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
    (fullBox.width > mainBox.width * 1.15 || fullBox.height > mainBox.height * 1.15);

  return (
    <ScrollArea className="h-full">
      <div className="space-y-4 px-4 py-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-normal">文件信息</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5">
            <Row label="文件名" value={file.name} />
            <Row label="格式" value={file.format} />
            <Row label="大小" value={formatBytes(file.sizeBytes)} />
            {stats?.header?.version && (
              <Row
                label="DWG 版本"
                value={ACADVER[stats.header.version] || stats.header.version}
              />
            )}
            {stats?.header?.insunits != null && (
              <Row label="插入单位" value={unitsLabel(stats.header.insunits)} />
            )}
            {mainBox && (
              <Row
                label="主体范围"
                value={`${fmtDim(mainBox.width)} × ${fmtDim(mainBox.height)}`}
              />
            )}
            {hasOuterContent && fullBox && (
              <Row
                label="全图范围"
                value={`${fmtDim(fullBox.width)} × ${fmtDim(fullBox.height)}`}
                hint="含主体外内容"
              />
            )}
          </CardContent>
        </Card>

        <div className="grid grid-cols-2 gap-2">
          <StatCard
            icon={<Boxes className="size-4" />}
            label="实体总数"
            value={stats ? formatNumber(stats.entities.total) : "—"}
          />
          <StatCard
            icon={<Copy className="size-4" />}
            label="图块引用"
            value={stats ? formatNumber(stats.entities.inserts) : "—"}
          />
          <StatCard
            icon={<Component className="size-4" />}
            label="图块定义"
            value={
              // 与「图块」列表面口径一致：只算本图真的用到的定义
              // （refCount>0 或 nestedRefCount>0；两者都为 0 的是 PURGE 残留，列表也不显示）
              stats
                ? formatNumber(
                    stats.blocks.length - (stats.unusedBlockDefCount ?? 0)
                  )
                : "—"
            }
          />
          <StatCard
            icon={<Layers className="size-4" />}
            label="图层数量"
            value={
              // 与「图层」列表面径一致：只算**有实体**的图层（空图层在列表里不显示）
              stats
                ? formatNumber(
                    stats.layers.filter((l) => (l.entityCount || 0) > 0).length
                  )
                : "—"
            }
          />
        </div>

        {hasOuterContent && (
          <Card className="bg-muted/50">
            <CardContent className="flex items-start gap-2.5">
              <ScanSearch className="mt-px h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="text-sm leading-relaxed">
                <b className="font-medium">主体范围外还有内容</b>
                <div className="text-muted-foreground">
                  图框、幕墙延伸等已折叠在视图外，点画布工具条的「全图」按钮可查看。
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {typeEntries.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-normal">实体类型分布</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5">
              {typeEntries.slice(0, 18).map(([type, count]) => (
                <div key={type} className="flex items-center gap-2">
                  <span
                    className="w-24 shrink-0 truncate font-mono text-xs leading-tight"
                    title={type}
                  >
                    {type}
                  </span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-foreground/10">
                    <div
                      className="h-full rounded-full bg-foreground/75"
                      style={{ width: `${Math.max(2, (count / maxCount) * 100)}%` }}
                    />
                  </div>
                  <span className="w-14 shrink-0 text-right text-sm tabular-nums text-muted-foreground">
                    {formatNumber(count)}
                  </span>
                </div>
              ))}
              {typeEntries.length > 18 && (
                <div className="pt-0.5 text-xs text-muted-foreground">
                  … 其余 {typeEntries.length - 18} 类
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {file.tch?.level === "objects" && (
          <Card className="bg-destructive/5">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm font-normal text-destructive">
                <Component className="size-4" />
                天正对象
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5">
              <div className="text-sm leading-relaxed">
                检测到 {file.tch.classes.length} 个天正自定义对象类（TCH_*）。本版本不含天正对象解析，几何与文字可能不完整。
              </div>
              <div className="text-sm leading-relaxed text-muted-foreground">
                请在天正软件中把图纸导出为 T3 后再打开，即可完整显示。
              </div>
            </CardContent>
          </Card>
        )}

        {file.tch?.level === "provenance" && (
          <Card className="bg-muted/50">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm font-normal">
                <ScanSearch className="size-4 text-muted-foreground" />
                天正图纸
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5">
              <div className="text-sm leading-relaxed">
                本图由天正软件绘制。本版本不含天正对象解析。
              </div>
              <div className="text-sm leading-relaxed text-muted-foreground">
                若发现图形不完整，请在天正软件中把图纸导出为 T3 后再打开。
              </div>
            </CardContent>
          </Card>
        )}

        {file.cadcraftInfo && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-normal">图纸结构</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-1.5">
              <Badge variant="secondary">布局 {file.cadcraftInfo.layouts.length}</Badge>
              <Badge variant="secondary">线型 {file.cadcraftInfo.linetypes}</Badge>
              <Badge variant="secondary">
                文字样式 {file.cadcraftInfo.textStyles}
              </Badge>
              {(file.skippedEntities ?? 0) > 0 && (
                <Badge variant="destructive">跳过实体 {file.skippedEntities}</Badge>
              )}
            </CardContent>
          </Card>
        )}

        {!stats && (
          <Card className="border-destructive/40 bg-destructive/5">
            <CardContent className="text-sm text-destructive">
              统计信息解析失败{file.statsError ? `：${file.statsError}` : ""}
            </CardContent>
          </Card>
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

function Row({
  label,
  value,
  muted,
  hint,
}: {
  label: string;
  value: string;
  muted?: boolean;
  hint?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-sm text-muted-foreground">{label}</span>
      <span
        className={cn(
          "flex min-w-0 items-baseline gap-1.5",
          muted && "text-muted-foreground"
        )}
      >
        <span className="truncate text-sm tabular-nums" title={value}>
          {value}
        </span>
        {hint && (
          <span className="shrink-0 text-xs text-muted-foreground">{hint}</span>
        )}
      </span>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <Card className="transition-colors hover:bg-muted/50">
      <CardContent>
        <div className="flex items-center gap-2 text-muted-foreground">
          {icon}
          <span className="text-sm">{label}</span>
        </div>
        <div className="mt-1.5 text-sm tabular-nums">
          {value}
        </div>
      </CardContent>
    </Card>
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
