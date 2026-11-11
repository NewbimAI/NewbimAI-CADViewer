/**
 * 顶栏最右侧的设置入口：齿轮图标 + 下拉菜单。
 *
 * 菜单里只放「检查更新」；点它会打开原有的更新面板（`UpdatePanel`），
 * 检查、下载、安装、进度轮询全部沿用更新控制器。
 * 齿轮右上角的圆点是"有可用更新 / 正在下载 / 出错"的状态提示，绝对定位，
 * 出现或消失都不会让顶栏里的任何东西位移。
 */
import { useEffect, useRef, useState } from "react";
import { Loader2, Mail, Menu, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import DockTooltip from "@/components/DockTooltip";
import UpdatePanel from "@/components/UpdatePanel";
import ContactDialog from "@/components/ContactDialog";
import { useUpdateController } from "@/components/useUpdateController";

export default function SettingsMenu() {
  const ctl = useUpdateController();
  const [menuOpen, setMenuOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 点击外面 / Esc 关闭菜单或面板（Esc 还负责把焦点还给齿轮按钮）
  useEffect(() => {
    if (!menuOpen && !panelOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setMenuOpen(false);
        setPanelOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMenuOpen(false);
      setPanelOpen(false);
      rootRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen, panelOpen]);

  const { info, job } = ctl;
  const lastCheck = info?.lastCheck ?? null;
  const available = !!(lastCheck?.available && lastCheck.latest);

  const downloading = job?.status === "running" || ctl.downloading;
  const ready = job?.status === "ready";
  const failed = job?.status === "error" || !!ctl.applyError;

  // 图标固定是三横菜单入口；更新状态只通过右上角圆点表达，
  // 这样顶栏右侧的位置和视觉权重不会随着更新状态变化。
  const dot = downloading
    ? "bg-warning animate-pulse"
    : failed
      ? "bg-destructive"
      : ready
        ? "bg-success"
        : available
          ? "bg-warning"
          : null;

  /** 打开更新面板并立即联网检查一次 */
  const checkNow = () => {
    setMenuOpen(false);
    setPanelOpen(true);
    void ctl.check();
  };

  return (
    <>
      <div ref={rootRef} className="relative">
        <DockTooltip content="设置与更新">
          <Button
            variant="ghost"
            size="icon-sm"
            className="relative size-9 rounded-full text-muted-foreground hover:text-foreground"
            data-settings-trigger="1"
            aria-label="设置与更新"
            aria-haspopup="menu"
            aria-expanded={menuOpen || panelOpen}
            onClick={() => {
              setPanelOpen(false);
              setMenuOpen((v) => !v);
            }}
          >
            <Menu className={cn(downloading && "animate-pulse")} />
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

        {menuOpen && (
          <div
            role="menu"
            aria-label="更多"
            data-settings-menu="1"
            className="absolute right-0 top-full z-50 mt-1 w-48 origin-top-right rounded-2xl border bg-card p-1 shadow-lg animate-in fade-in-0 zoom-in-95 slide-in-from-top-1 duration-150"
          >
            <button
              type="button"
              role="menuitem"
              onClick={checkNow}
              className="flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-sm transition-colors outline-hidden hover:bg-muted focus-visible:bg-muted"
            >
              {ctl.checking ? (
                <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
              ) : (
                <RefreshCw className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="font-medium">检查更新</span>
              {available && (
                <span className="ml-auto flex items-center gap-1 text-[10px] tabular-nums text-muted-foreground">
                  v{lastCheck?.latest}
                  <span className="size-1.5 rounded-full bg-warning" />
                </span>
              )}
            </button>

            {/* 联系我们：第二项，点开居中模态 */}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                setPanelOpen(false);
                setContactOpen(true);
              }}
              className="flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-sm transition-colors outline-hidden hover:bg-muted focus-visible:bg-muted"
            >
              <Mail className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="font-medium">联系我们</span>
            </button>
          </div>
        )}

        {panelOpen && (
          <UpdatePanel ctl={ctl} onClose={() => setPanelOpen(false)} />
        )}
      </div>

      {/* 联系我们：居中轻模态（portal 到 body，层级独立于顶栏/画布） */}
      {contactOpen && (
        <ContactDialog
          onClose={() => {
            setContactOpen(false);
            // 焦点还给齿轮，键盘用户不会掉到页面开头
            rootRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
          }}
        />
      )}

      {/* 应用成功后服务就会退出：盖一层说明，5 秒后再给手动兜底 */}
      {ctl.applied && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-background/70 p-6 backdrop-blur-sm"
          role="alertdialog"
          aria-label="正在重启"
          aria-live="assertive"
        >
          <div className="flex w-full max-w-[20rem] flex-col items-center gap-3.5 rounded-2xl border bg-card px-6 py-7 text-center shadow-xl">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
            <div className="space-y-1">
              <div className="text-sm font-semibold tracking-tight">
                {ctl.applied.restart ? "正在重启…" : "正在关闭…"}
              </div>
              <div className="text-[11px] leading-relaxed text-muted-foreground">
                v{ctl.applied.version} 正在安装
                {ctl.applied.restart
                  ? "，完成后页面会自动恢复"
                  : "，下次启动时生效"}
              </div>
            </div>
            {ctl.restartHint && (
              <p className="w-full rounded-xl border border-warning/40 bg-warning/[0.07] px-3 py-2 text-[11px] leading-relaxed text-foreground/80">
                如果页面没有自动恢复，请手动重新打开 start.bat。
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
}
