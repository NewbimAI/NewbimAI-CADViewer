/**
 * 顶栏「更新」入口。
 *
 * 状态归属：所有更新状态和轮询都在这里（面板的父层），所以
 *   · 面板关掉再打开，进度还在；
 *   · 切换图纸 tab、打开新图纸都不会碰它；
 *   · 组件卸载（整个应用关闭）时清掉轮询定时器。
 *
 * 启动时只 GET /api/update/status（纯本地读取）。真正联网的检查必须由用户点「检查更新」触发：
 * 这是本地工具，很多用户离线或被 GitHub 挡住，静默失败不能变成错误弹窗。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { CircleAlert, Download, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import DockTooltip from "@/components/DockTooltip";
import {
  applyUpdate,
  checkForUpdate,
  downloadUpdate,
  fetchUpdateStatus,
} from "@/api";
import { cn } from "@/lib/utils";
import type { UpdateApplyResult, UpdateInfo, UpdateJob } from "@/types";
import UpdatePanel, { type UpdateController } from "@/components/UpdatePanel";

/** 下载进度轮询间隔（契约建议 700ms） */
const POLL_MS = 700;
/** 连续失败这么多次就认为本地服务断了，停掉轮询 */
const POLL_MAX_FAILURES = 5;
/** apply 成功后多久提示"手动重开 start.bat" */
const RESTART_HINT_DELAY = 5000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------------ */
/* 控制器：状态 + 动作 + 轮询                                           */
/* ------------------------------------------------------------------ */

function useUpdateController(): UpdateController {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [job, setJob] = useState<UpdateJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applied, setApplied] = useState<UpdateApplyResult | null>(null);
  const [restartHint, setRestartHint] = useState(false);
  const [restart, setRestart] = useState(true);

  /** status 响应是唯一事实来源：info 与 job 一起刷新 */
  const applyStatus = useCallback((next: UpdateInfo) => {
    setInfo(next);
    setJob(next.job);
    setStatusError(null);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      applyStatus(await fetchUpdateStatus());
    } catch (e) {
      setStatusError(messageOf(e));
    } finally {
      setLoading(false);
    }
  }, [applyStatus]);

  // 挂载：只读本地状态，不联网
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 下载中每 700ms 拉一次本地 status，直到 ready / error
  useEffect(() => {
    if (job?.status !== "running") return;

    let alive = true;
    let inFlight = false;
    let failures = 0;

    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await fetchUpdateStatus();
        if (!alive) return;
        failures = 0;
        applyStatus(next);
      } catch {
        if (!alive) return;
        failures += 1;
        if (failures >= POLL_MAX_FAILURES) {
          setJob((current) =>
            current && current.status === "running"
              ? {
                  ...current,
                  status: "error",
                  error: "与本地服务的连接中断，下载进度已停止",
                }
              : current
          );
        }
      } finally {
        inFlight = false;
      }
    };

    const timer = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [job?.status, applyStatus]);

  // apply 成功后 5 秒给出"手动重开"的兜底提示
  useEffect(() => {
    if (!applied) return;
    const timer = window.setTimeout(
      () => setRestartHint(true),
      RESTART_HINT_DELAY
    );
    return () => window.clearTimeout(timer);
  }, [applied]);

  const check = useCallback(async () => {
    if (checking) return;
    setChecking(true);
    setCheckError(null);
    setDownloadError(null);
    try {
      const result = await checkForUpdate();
      setInfo((prev) =>
        prev
          ? { ...prev, current: result.current, lastCheck: result }
          : prev
      );
      // 顺带补齐 canSelfUpdate / root / job 等（本地请求，不联网）。
      // 若本地快照里的 lastCheck 更旧（理论上不会），以刚查到的结果为准。
      const status = await fetchUpdateStatus().catch(() => null);
      if (status) {
        applyStatus({
          ...status,
          lastCheck:
            status.lastCheck && status.lastCheck.at >= result.at
              ? status.lastCheck
              : result,
        });
      }
    } catch (e) {
      // 检查失败（含离线）只留一行克制提示，绝不弹窗
      setCheckError(messageOf(e));
    } finally {
      setChecking(false);
    }
  }, [checking, applyStatus]);

  const download = useCallback(async () => {
    const version = info?.lastCheck?.latest ?? null;
    if (!version || downloading) return;
    setDownloading(true);
    setDownloadError(null);
    setApplyError(null);
    try {
      const next = await downloadUpdate(version);
      setJob(next);
      setInfo((prev) => (prev ? { ...prev, job: next } : prev));
    } catch (e) {
      setDownloadError(messageOf(e));
    } finally {
      setDownloading(false);
    }
  }, [info, downloading]);

  const apply = useCallback(async () => {
    if (!job || job.status !== "ready" || applying || applied) return;
    const restartNow = restart;
    const confirmed = window.confirm(
      `将安装 v${job.version}。\n\n` +
        (restartNow
          ? "应用将关闭并自动重启，数据（data 目录）不会丢失。"
          : "应用将关闭；更新会在下次启动时生效，数据（data 目录）不会丢失。")
    );
    if (!confirmed) return;

    setApplying(true);
    setApplyError(null);
    try {
      const result = await applyUpdate(restartNow);
      setApplied(result);
    } catch (e) {
      // 失败时保留 ready 状态，让用户能重试
      setApplyError(messageOf(e));
    } finally {
      setApplying(false);
    }
  }, [job, applying, applied, restart]);

  return {
    info,
    job,
    loading,
    statusError,
    checking,
    checkError,
    downloading,
    downloadError,
    applying,
    applyError,
    applied,
    restartHint,
    restart,
    setRestart,
    refresh,
    check,
    download,
    apply,
  };
}

/* ------------------------------------------------------------------ */
/* 顶栏入口                                                           */
/* ------------------------------------------------------------------ */

export default function UpdateButton() {
  const ctl = useUpdateController();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 点击面板外 / Esc 关闭（Esc 还负责把焦点还给触发按钮）
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      rootRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const { info, job } = ctl;
  const lastCheck = info?.lastCheck ?? null;
  const available = !!(lastCheck?.available && lastCheck.latest);

  const downloading = job?.status === "running" || ctl.downloading;
  const ready = job?.status === "ready";
  const failed = job?.status === "error" || !!ctl.applyError;

  const total = job?.progress?.total ?? 0;
  const received = job?.progress?.received ?? 0;
  const pct = total > 0 ? Math.round((received / total) * 100) : null;

  const Icon = downloading
    ? Download
    : failed
      ? CircleAlert
      : ready
        ? RefreshCw
        : available
          ? Download
          : RefreshCw;

  // 状态点：绝对定位，不占位——出现/消失都不会让顶栏抖动
  const dot = downloading
    ? "bg-warning animate-pulse"
    : failed
      ? "bg-destructive"
      : ready
        ? "bg-success"
        : available
          ? "bg-warning"
          : null;

  const title = ctl.applied
    ? "正在重启…"
    : downloading
      ? `正在下载更新${pct != null ? ` · ${pct}%` : ""}`
      : failed
        ? "更新失败，点击查看原因"
        : ready
          ? `更新 v${job?.version} 已下载，重启后生效`
          : available
            ? `发现新版本 v${lastCheck?.latest}，点击查看`
            : "检查更新";

  return (
    <>
      <div ref={rootRef} className="relative">
        <DockTooltip content={title}>
          <Button
            variant="ghost"
            size="icon-sm"
            // size-9 与相邻的「对比 / 导出」同高；点的大小仍是 icon-sm 的图标
            className="relative size-9 text-muted-foreground hover:text-foreground"
            aria-label={title}
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            <Icon />
            {dot && (
              <span
                aria-hidden
                className={cn(
                  "pointer-events-none absolute right-1 top-1 size-1.5 rounded-full ring-2 ring-card",
                  dot
                )}
              />
            )}
          </Button>
        </DockTooltip>

        {open && <UpdatePanel ctl={ctl} onClose={() => setOpen(false)} />}
      </div>

      {/* 应用成功后服务就会退出：盖一层说明，5 秒后再给手动兜底 */}
      {ctl.applied && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-background/70 p-6 backdrop-blur-sm"
          role="alertdialog"
          aria-label="正在重启"
          aria-live="assertive"
        >
          <div className="flex w-full max-w-[20rem] flex-col items-center gap-3.5 rounded-xl border bg-card px-6 py-7 text-center shadow-xl">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
            <div className="space-y-1">
              <div className="text-sm font-semibold tracking-tight">
                {ctl.applied.restart ? "正在重启…" : "正在关闭…"}
              </div>
              <div className="text-[11px] leading-relaxed text-muted-foreground">
                v{ctl.applied.version} 正在安装
                {ctl.applied.restart ? "，完成后页面会自动恢复" : "，下次启动时生效"}
              </div>
            </div>
            {ctl.restartHint && (
              <p className="w-full rounded-lg border border-warning/40 bg-warning/[0.07] px-3 py-2 text-[11px] leading-relaxed text-foreground/80">
                如果页面没有自动恢复，请手动重新打开 start.bat。
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
}
