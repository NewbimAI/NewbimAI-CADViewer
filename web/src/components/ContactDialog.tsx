/**
 * 「联系我们」模态（从设置菜单进入）。
 *
 * 只做两件事：说明授权/合作方式、把邮箱复制进剪贴板。
 * 视觉是 Stitch 风格的轻模态：rounded-2xl、浅色 surface、24px 内边距、无描边、
 * 极轻阴影、很淡的遮罩模糊；两个胶囊按钮。
 * 关闭方式：Esc、点遮罩、点「关闭」。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, Github, Star } from "lucide-react";

import { Button } from "@/components/ui/button";
import DockTooltip from "@/components/DockTooltip";

const EMAIL = "nbimgpt@163.com";
const REPO_URL = "https://github.com/NewbimAI/NewbimAI-CADViewer";

export default function ContactDialog({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  // Esc 关闭（捕获阶段：不被内部按键处理吞掉）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const copyEmail = useCallback(async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(EMAIL);
      ok = true;
    } catch {
      // 旧内核 / 非安全上下文兜底
      const ta = document.createElement("textarea");
      ta.value = EMAIL;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "0";
      ta.style.left = "0";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      ta.remove();
    }

    if (!ok) {
      setStatus("failed");
      return;
    }
    setStatus("copied");
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setStatus("idle"), 2200);
  }, []);

  const copied = status === "copied";

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex animate-in items-center justify-center bg-foreground/25 p-6 fade-in-0 backdrop-blur-[2px] duration-150"
      // 只有点到遮罩本身才关闭；点面板内部不关
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="contact-title"
        className="w-full max-w-md animate-in rounded-2xl bg-card p-6 shadow-md fade-in-0 zoom-in-95 duration-150"
      >
        <h2
          id="contact-title"
          className="text-lg font-semibold tracking-tight"
        >
          联系我们
        </h2>

        <div className="mt-4 flex items-center justify-between gap-2 rounded-xl bg-muted/50 px-3 py-2">
          <DockTooltip
            content="在 GitHub 打开仓库"
            wrapperClassName="min-w-0 flex-1"
          >
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
              aria-label="在 GitHub 打开 CADViewer 仓库"
            >
              <Github className="size-4 shrink-0" />
              <span className="truncate">NewbimAI/NewbimAI-CADViewer</span>
            </a>
          </DockTooltip>
          <DockTooltip content="在 GitHub 上 Star 本项目" wrapperClassName="shrink-0">
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
              aria-label="在 GitHub 上 Star 本项目"
            >
              <Star className="size-3.5" />
              Star
            </a>
          </DockTooltip>
        </div>

        <div className="mt-3 space-y-2.5 text-sm leading-relaxed text-muted-foreground">
          <p>
            CADViewer 采用 AGPL-3.0 开源。若需闭源集成、嵌入商业产品、二次开发或定制支持，欢迎邮件联系。
          </p>
          <p>
            邮箱：
            <span className="select-all font-medium text-foreground">
              {EMAIL}
            </span>
          </p>
          <p>
            公众号：
            <span className="select-all font-medium text-foreground">
              NewbimAI
            </span>
          </p>
          {status === "failed" && (
            <p role="alert" className="text-xs text-destructive">
              复制失败，请手动选中邮箱地址
            </p>
          )}
        </div>

        <div className="mt-6 flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="lg"
            className="rounded-full px-4"
            onClick={onClose}
          >
            关闭
          </Button>
          <Button
            size="lg"
            className="min-w-28 gap-1.5 rounded-full px-4"
            onClick={copyEmail}
            autoFocus
          >
            {copied ? <Check /> : <Copy />}
            <span aria-live="polite">{copied ? "已复制" : "复制邮箱"}</span>
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}
