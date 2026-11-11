/**
 * 自动更新面板（顶栏图标按钮的弹出层）。
 *
 * 这里只做呈现：所有网络/轮询状态都放在 UpdateButton 的控制器里。
 * 面板关闭再打开、切换图纸 tab 都不会打断下载进度——进度不属于这个组件。
 *
 * 视觉语言沿用顶栏「导出」二级菜单：绝对定位、右对齐、bg-popover + shadow-lg，
 * 文字沿用面板里的 11px / 12px 两级。
 */
import type { ReactNode } from "react";
import {
  Check,
  CircleAlert,
  Download,
  ExternalLink,
  Loader2,
  RefreshCw,
  TriangleAlert,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import DockTooltip from "@/components/DockTooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type {
  UpdateApplyResult,
  UpdateAsset,
  UpdateInfo,
  UpdateJob,
} from "@/types";

/* ------------------------------------------------------------------ */
/* 控制器契约（实现见 UpdateButton.tsx）                                */
/* ------------------------------------------------------------------ */

export interface UpdateController {
  /** GET /api/update/status 的本地快照；null = 还没读到 */
  info: UpdateInfo | null;
  /** 当前下载任务（与 info.job 同步刷新） */
  job: UpdateJob | null;
  /** 正在读取 status */
  loading: boolean;
  /** 读取 status 失败（本机服务都读不到，极少见） */
  statusError: string | null;
  /** 正在 POST /api/update/check */
  checking: boolean;
  /** 检查请求本身失败（离线/超时不会走这里，见 lastCheck.error） */
  checkError: string | null;
  /** POST /api/update/download 正在路上 */
  downloading: boolean;
  downloadError: string | null;
  /** POST /api/update/apply 正在路上 */
  applying: boolean;
  applyError: string | null;
  /** 应用成功：服务即将退出，页面不要再做别的事 */
  applied: UpdateApplyResult | null;
  /** 应用成功 5 秒后为 true：提示手动重开 start.bat */
  restartHint: boolean;
  /** 「重启并更新」开关（默认开） */
  restart: boolean;
  setRestart: (value: boolean) => void;
  refresh: () => Promise<void>;
  check: () => Promise<void>;
  download: () => Promise<void>;
  apply: () => Promise<void>;
}

/* ------------------------------------------------------------------ */
/* 面板                                                               */
/* ------------------------------------------------------------------ */

export default function UpdatePanel({
  ctl,
  onClose,
}: {
  ctl: UpdateController;
  onClose: () => void;
}) {
  const { info, job } = ctl;

  const lastCheck = info?.lastCheck ?? null;
  const manifest = lastCheck?.manifest ?? null;
  const latest = manifest?.version ?? lastCheck?.latest ?? null;
  const available = !!(lastCheck?.available && latest);
  const canSelfUpdate = info?.canSelfUpdate ?? false;
  const updateAsset = manifest?.assets?.update ?? null;
  const fullAsset = manifest?.assets?.full ?? null;
  /** 一键下载还要求清单里真的有更新包地址（有的发布只给完整安装包） */
  const canDownload = canSelfUpdate && !!updateAsset?.url;

  const running = job?.status === "running";
  const ready = job?.status === "ready";
  const jobError = job?.status === "error" ? job.error || "更新包下载失败" : null;
  const downloading = running || ctl.downloading;

  const received = job?.progress?.received ?? 0;
  const total = job?.progress?.total ?? 0;
  const pct = total > 0 ? Math.min(100, Math.max(0, (received / total) * 100)) : null;
  /** POST 还在路上时 job 可能还是旧的失败快照：进度一律按"未开始"显示 */
  const activeReceived = running ? received : 0;
  const activeTotal = running ? total : 0;
  const activePct = running ? pct : null;

  const notes = manifest?.notes?.trim() ?? "";

  /** 「上次检查」正文里已经写过时间时，页脚不再重复一遍 */
  let showsCheckTime = false;

  let body: ReactNode;

  if (ctl.applied) {
    /* 服务马上退出：这个面板只是陪衬，真正的提示是页面上的浮层 */
    body = (
      <div className="flex items-start gap-2.5">
        <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />
        <div className="min-w-0 space-y-0.5">
          <div className="text-xs font-medium">正在重启…</div>
          <div className="text-[11px] leading-relaxed text-muted-foreground">
            正在安装 v{ctl.applied.version}，完成后页面会自动恢复。
          </div>
        </div>
      </div>
    );
  } else if (!info) {
    body = ctl.statusError ? (
      <div className="space-y-2">
        <CalmNote
          text="读取更新信息失败"
          detail={ctl.statusError}
          actionLabel="重试"
          onAction={() => void ctl.refresh()}
          busy={ctl.loading}
        />
        <p className="text-[10px] leading-relaxed text-muted-foreground/80">
          更新不可用时不影响查看图纸。
        </p>
      </div>
    ) : (
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        正在读取更新信息…
      </div>
    );
  } else if (downloading) {
    body = (
      <div className="space-y-2.5">
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-medium">
            正在下载{versionSuffix(job?.version ?? latest)}
          </span>
          <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
            {activePct != null ? `${Math.round(activePct)}%` : "准备中"}
          </span>
        </div>
        <ProgressBar value={activePct} />
        <div className="flex items-baseline justify-between gap-2 text-[11px] tabular-nums">
          <span className="text-foreground/80">
            {formatBytes(activeReceived)} /{" "}
            {activeTotal > 0 ? formatBytes(activeTotal) : "未知大小"}
          </span>
          <span className="text-[10px] text-muted-foreground">
            下载完成后重启生效
          </span>
        </div>
        <p className="text-[10px] leading-relaxed text-muted-foreground/80">
          关掉这个面板不会中断下载。
        </p>
      </div>
    );
  } else if (ready && job) {
    body = (
      <div className="space-y-2.5">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border border-success/30 bg-success/10 text-success">
            <Check className="size-3.5" />
          </span>
          <div className="min-w-0 space-y-0.5">
            <div className="text-xs font-medium">更新已下载，重启后生效</div>
            <div className="text-[11px] tabular-nums text-muted-foreground">
              v{job.version} · {formatBytes(job.progress.received)}
              {job.progress.total > 0 ? ` / ${formatBytes(job.progress.total)}` : ""}
            </div>
          </div>
        </div>

        {canSelfUpdate ? (
          <>
            <DockTooltip
              content="开：装完自动重启；关：下次启动生效"
              wrapperClassName="w-full"
            >
              <label className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg border bg-muted/20 px-2.5 py-2">
                <span className="text-xs">重启并更新</span>
                <Switch
                  size="sm"
                  checked={ctl.restart}
                  onCheckedChange={ctl.setRestart}
                />
              </label>
            </DockTooltip>
            <DockTooltip
              content={`安装 v${job.version} 并${ctl.restart ? "重启" : "关闭"}应用`}
              wrapperClassName="w-full"
            >
              <Button
                className="w-full gap-1.5"
                disabled={ctl.applying}
                onClick={() => void ctl.apply()}
              >
                {ctl.applying ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <RefreshCw />
                )}
                {ctl.applying ? "正在应用…" : "立即更新"}
              </Button>
            </DockTooltip>
            {ctl.applyError && <ErrorLine text={ctl.applyError} />}
            <p className="text-[10px] leading-relaxed text-muted-foreground/80">
              应用结束后会关闭当前窗口；data 目录（图纸与设置）不会丢失。
            </p>
          </>
        ) : (
          <ManualBlock
            title={info.reason || "当前安装目录不支持一键更新"}
            root={info.root}
            fullAsset={fullAsset}
            version={latest}
          />
        )}
      </div>
    );
  } else if (jobError) {
    body = (
      <div className="space-y-2.5">
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/[0.07] px-2.5 py-2 text-[11px] leading-relaxed text-destructive">
          <CircleAlert className="mt-px size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{jobError}</span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            disabled={ctl.downloading || !latest || !canDownload}
            title={
              !latest
                ? "缺少版本号，请重新检查更新"
                : !canSelfUpdate
                  ? info.reason || "当前安装目录不支持一键更新"
                  : !updateAsset?.url
                    ? "本次发布没有提供一键更新包，请手动下载"
                    : "重新下载更新包"
            }
            onClick={() => void ctl.download()}
          >
            {ctl.downloading ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Download />
            )}
            重试下载
          </Button>
        </div>
        {!canDownload && (
          <ManualBlock
            title={
              canSelfUpdate
                ? "本次发布没有提供一键更新包"
                : info.reason || "当前安装目录不支持一键更新"
            }
            root={canSelfUpdate ? null : info.root}
            fullAsset={fullAsset}
            version={latest}
          />
        )}
        {canDownload && (
          <ManualBlock
            title="如果反复失败，可以手动下载安装"
            fullAsset={fullAsset}
            version={latest}
          />
        )}
        {ctl.downloadError && <ErrorLine text={ctl.downloadError} />}
      </div>
    );
  } else if (available && lastCheck) {
    body = (
      <div className="space-y-2.5">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-sm font-semibold tracking-tight">
            发现新版本
          </span>
          <Badge
            variant="secondary"
            className="h-5 px-1.5 text-[11px] font-semibold tabular-nums"
          >
            v{latest}
          </Badge>
          {manifest?.channel && manifest.channel !== "stable" && (
            <DockTooltip content="发布通道" wrapperClassName="shrink-0">
              <Badge
                variant="outline"
                className="h-5 px-1.5 text-[10px] font-normal text-muted-foreground"
              >
                {manifest.channel}
              </Badge>
            </DockTooltip>
          )}
          <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
            当前 v{lastCheck.current}
          </span>
        </div>

        {manifest?.releasedAt && (
          <div className="text-[10px] text-muted-foreground">
            发布于 {formatDate(manifest.releasedAt)}
          </div>
        )}

        {notes && (
          <div className="overflow-hidden rounded-lg border bg-muted/20">
            <div className="border-b border-border/60 px-2.5 py-1 text-[10px] font-medium text-muted-foreground">
              更新说明
            </div>
            <ScrollArea className={cn(notes.length > 420 && "h-40")}>
              <div className="whitespace-pre-wrap break-words px-2.5 py-2 text-[11px] leading-relaxed text-foreground/85">
                {notes}
              </div>
            </ScrollArea>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 text-[11px]">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <Download className="size-3" />
            {updateAsset?.url ? "更新包" : fullAsset?.url ? "完整安装包" : "更新包"}
          </span>
          <span className="tabular-nums text-foreground/80">
            {updateSizeOf(updateAsset?.url ? updateAsset : fullAsset)}
          </span>
        </div>

        {canDownload ? (
          <DockTooltip
            content="下载并校验更新包（下载中别关窗口）"
            wrapperClassName="w-full"
          >
            <Button
              className="w-full gap-1.5"
              disabled={ctl.downloading}
              onClick={() => void ctl.download()}
            >
              {ctl.downloading ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Download />
              )}
              {ctl.downloading ? "正在开始下载…" : "下载更新"}
            </Button>
          </DockTooltip>
        ) : (
          <ManualBlock
            title={
              canSelfUpdate
                ? "本次发布没有提供一键更新包"
                : info.reason || "当前安装目录不支持一键更新"
            }
            root={canSelfUpdate ? null : info.root}
            fullAsset={fullAsset}
            version={latest}
          />
        )}

        {ctl.downloadError && <ErrorLine text={ctl.downloadError} />}
      </div>
    );
  } else if (lastCheck?.error) {
    const failure = describeCheckError(lastCheck.error);
    body = (
      <div className="space-y-2">
        <CalmNote
          text={failure.text}
          detail={failure.detail ?? lastCheck.error}
          actionLabel="重试"
          onAction={() => void ctl.check()}
          busy={ctl.checking}
        />
        {fullAsset?.url && (
          <ManualLink asset={fullAsset} version={latest} />
        )}
      </div>
    );
  } else if (lastCheck) {
    showsCheckTime = true;
    body = (
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border border-success/30 bg-success/10 text-success">
          <Check className="size-3.5" />
        </span>
        <div className="min-w-0 space-y-0.5">
          <div className="text-xs font-medium">
            已是最新版本（v{lastCheck.current}）
          </div>
          <div className="text-[11px] text-muted-foreground">
            上次检查 {formatWhen(lastCheck.at)}
          </div>
        </div>
      </div>
    );
  } else {
    body = (
      <div className="space-y-2">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          需要时再检查。启动时不会联网，离线或连不上发布页都不会弹错，也不影响使用。
        </p>
        {ctl.checking && (
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            正在连接发布页，最多约 20 秒…
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      role="dialog"
      aria-label="软件更新"
      className="absolute right-0 top-full z-50 w-[21.5rem] max-w-[calc(100vw_-_2rem)] origin-top-right pt-1.5 animate-in fade-in-0 zoom-in-95 slide-in-from-top-1 duration-150"
    >
      <div className="overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg">
        <div className="flex items-center gap-2 border-b bg-muted/30 px-3.5 py-2">
          <RefreshCw className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="text-[13px] font-semibold tracking-tight">
            软件更新
          </span>
          <Badge
            variant="outline"
            className="ml-auto h-5 px-1.5 text-[10px] font-normal tabular-nums text-muted-foreground"
          >
            v{info?.current ?? "—"}
          </Badge>
          <DockTooltip content="关闭" wrapperClassName="shrink-0">
            <button
              type="button"
              className="-mr-1 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label="关闭更新面板"
              onClick={onClose}
            >
              <X className="size-3.5" />
            </button>
          </DockTooltip>
        </div>

        <div className="space-y-3 px-3.5 py-3">
          {body}
          {ctl.checkError && !lastCheck?.error && (
            <CalmNote
              text="没能连上更新服务器（离线时属正常）"
              detail={ctl.checkError}
              actionLabel="重试"
              onAction={() => void ctl.check()}
              busy={ctl.checking}
            />
          )}
        </div>

        <Separator />
        <div className="flex items-center gap-2 px-3.5 py-2">
          <DockTooltip content="向发布页查询最新版本">
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              disabled={ctl.checking || downloading || ctl.applying || !info}
              onClick={() => void ctl.check()}
            >
              {ctl.checking ? (
                <Loader2 className="animate-spin" />
              ) : (
                <RefreshCw />
              )}
              {ctl.checking ? "检查中…" : "检查更新"}
            </Button>
          </DockTooltip>
          <DockTooltip
            content={
              lastCheck
                ? new Date(lastCheck.at).toLocaleString("zh-CN")
                : "启动时只读本地状态，不联网"
            }
            wrapperClassName="ml-auto min-w-0"
          >
            <span className="block min-w-0 truncate text-right text-[10px] tabular-nums text-muted-foreground">
              {!lastCheck
                ? "尚未检查"
                : showsCheckTime
                  ? null
                  : `上次检查 ${formatWhen(lastCheck.at)}`}
            </span>
          </DockTooltip>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 小零件                                                             */
/* ------------------------------------------------------------------ */

/** 进度条：total 未知时用一段 1/3 宽的脉冲条表示"还没开始/大小未知" */
function ProgressBar({ value }: { value: number | null }) {
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      role="progressbar"
      aria-label="更新包下载进度"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value == null ? undefined : Math.round(value)}
    >
      <div
        className={cn(
          "h-full rounded-full bg-primary transition-[width] duration-300 ease-out",
          value == null && "w-1/3 animate-pulse"
        )}
        style={value == null ? undefined : { width: `${Math.max(2, value)}%` }}
      />
    </div>
  );
}

/** 一行克制的提示：图标 + 说明 +（可选）重试，绝不大红banner */
function CalmNote({
  text,
  detail,
  actionLabel,
  onAction,
  busy,
}: {
  text: string;
  detail?: string | null;
  actionLabel?: string;
  onAction?: () => void;
  busy?: boolean;
}) {
  return (
    <div className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
      <CircleAlert className="mt-px size-3.5 shrink-0 opacity-70" />
      {detail ? (
        <DockTooltip content={detail} wrapperClassName="min-w-0 flex-1">
          <span className="block min-w-0">{text}</span>
        </DockTooltip>
      ) : (
        <span className="min-w-0 flex-1">{text}</span>
      )}
      {actionLabel && onAction && (
        <button
          type="button"
          disabled={busy}
          className="shrink-0 font-medium text-foreground/70 underline-offset-4 transition-colors hover:text-foreground hover:underline disabled:opacity-50"
          onClick={onAction}
        >
          {busy ? "重试中…" : actionLabel}
        </button>
      )}
    </div>
  );
}

/** 下载/应用失败：小号 destructive 块（比检查更新的网络失败更明确） */
function ErrorLine({ text }: { text: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/[0.07] px-2.5 py-2 text-[11px] leading-relaxed text-destructive"
    >
      <CircleAlert className="mt-px size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 break-words">{text}</span>
    </div>
  );
}

/** 手动下载说明：不伪造链接，只有清单里真有 full.url 时才给入口 */
function ManualBlock({
  title,
  root,
  fullAsset,
  version,
}: {
  title: string;
  root?: string | null;
  fullAsset?: UpdateAsset | null;
  version?: string | null;
}) {
  return (
    <div className="space-y-2 rounded-lg border border-warning/40 bg-warning/[0.06] px-2.5 py-2">
      <div className="flex items-start gap-1.5 text-[11px] leading-relaxed">
        <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" />
        <span className="min-w-0 flex-1">{title}</span>
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        可以手动下载完整安装包，解压后覆盖原安装目录；保留 data 目录就不会丢图纸与设置。
      </p>
      {root && (
        <DockTooltip content={root} wrapperClassName="block w-full">
          <p className="truncate font-mono text-[10px] text-muted-foreground/80">
            安装目录：{root}
          </p>
        </DockTooltip>
      )}
      {fullAsset?.url && <ManualLink asset={fullAsset} version={version} />}
    </div>
  );
}

function ManualLink({
  asset,
  version,
}: {
  asset: UpdateAsset;
  version?: string | null;
}) {
  if (!asset.url) return null;
  const size = asset.size ?? 0;
  return (
    <DockTooltip content={asset.url} wrapperClassName="max-w-full">
      <a
        href={asset.url}
        target="_blank"
        rel="noreferrer noopener"
        className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-[11px] font-medium transition-colors hover:bg-muted"
      >
        <ExternalLink className="size-3 shrink-0" />
        <span className="truncate">
          下载完整安装包{version ? `（v${version}）` : ""}
        </span>
        {size > 0 && (
          <span className="shrink-0 font-normal tabular-nums text-muted-foreground">
            · {formatBytes(size)}
          </span>
        )}
      </a>
    </DockTooltip>
  );
}

/* ------------------------------------------------------------------ */
/* 格式化                                                             */
/* ------------------------------------------------------------------ */

/** 45.6 MB / 12.3 MB；0 或未知显示为"—"由调用方决定 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return i === 0 ? `${Math.round(value)} B` : `${value.toFixed(1)} ${units[i]}`;
}

/** 更新包大小：清单没给 size 时说"大小未知"，不假装知道 */
function updateSizeOf(asset: UpdateAsset | null): string {
  const size = asset?.size ?? 0;
  return size > 0 ? formatBytes(size) : "大小未知";
}

function formatWhen(at: number): string {
  const diff = Date.now() - at;
  if (Number.isFinite(diff) && diff >= 0) {
    if (diff < 60_000) return "刚刚";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  }
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatDate(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

/** 检查失败的两类文案：连不上（克制说法）vs 版本过低（原样告知） */
function describeCheckError(error: string): {
  text: string;
  detail?: string;
} {
  const looksOffline =
    error.includes("检查更新失败") ||
    error.includes("请求超时") ||
    error.includes("网络") ||
    error.includes("fetch");
  if (looksOffline) {
    return { text: "暂时连不上更新服务器（离线时属正常）", detail: error };
  }
  return { text: error };
}

/** "0.3.0" / "v0.3.0" → " v0.3.0"（用于"正在下载 v0.3.0"） */
function versionSuffix(version: string | null): string {
  if (!version) return "";
  return ` v${version.replace(/^[vV]/, "")}`;
}
