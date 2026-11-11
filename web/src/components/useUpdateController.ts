/**
 * 自动更新的状态机（设置菜单用）。
 *
 * 行为与 `UpdateButton.tsx` 里的控制器保持一致（那份实现服务顶栏的更新入口）：
 *   · 启动时只 GET /api/update/status（纯本地读取，不联网）；
 *   · 真正联网的检查必须由用户点「检查更新」触发；
 *   · 下载中每 700ms 拉一次本地 status，直到 ready / error；
 *   · 应用成功后 5 秒给出「手动重开 start.bat」的兜底提示。
 *
 * 单独抽成 hook 是为了让顶栏的齿轮菜单复用同一套状态，而不改动原有的
 * `UpdateButton.tsx` / `UpdatePanel.tsx`。
 */
import { useCallback, useEffect, useState } from "react";

import {
  applyUpdate,
  checkForUpdate,
  downloadUpdate,
  fetchUpdateStatus,
} from "@/api";
import type { UpdateApplyResult, UpdateInfo, UpdateJob } from "@/types";
import type { UpdateController } from "@/components/UpdatePanel";

/** 下载进度轮询间隔（契约建议 700ms） */
const POLL_MS = 700;
/** 连续失败这么多次就认为本地服务断了，停掉轮询 */
const POLL_MAX_FAILURES = 5;
/** apply 成功后多久提示"手动重开 start.bat" */
const RESTART_HINT_DELAY = 5000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useUpdateController(): UpdateController {
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
