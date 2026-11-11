/**
 * DockTooltip —— 跟随触发元素的 Stitch 风格气泡提示（替代原生 title / 居中提示条）。
 *
 * 观感：浅色 popover surface、圆角 pill、轻阴影、无硬边框、12px 文字，
 * 气泡下方带一个小三角箭头指向锚点；深色主题由 `--popover` 令牌自动跟随。
 *
 * 两种用法：
 *   1) 悬浮提示（默认）：包住按钮，悬浮约 450ms 后出现在按钮正上方；
 *   2) 常驻提示（受控）：传 `open` + `anchor`，不渲染包裹层，直接锚定到外部元素，
 *      用于「当前测量工具」这类一直显示、但必须跟着按钮走的操作说明。
 *
 * 定位：
 *   · 默认在锚点正上方；顶部放不下（顶栏按钮）时自动翻到正下方，箭头改为贴顶边；
 *   · 水平居中于锚点，超出视口时夹取到 8px 安全边距，箭头单独偏移继续指向锚点；
 *   · 通过 portal 挂到 body，不会被面板 / dock 的 overflow 裁掉；
 *   · 滚动（任意滚动容器）、窗口尺寸、锚点或气泡自身尺寸变化都会重新定位。
 *
 * 入场：先量坐标（layout effect）→ 下一帧只把 opacity 从 0 过渡到 1。
 * 没有 translate / scale / zoom，气泡不会从别处"飞"过来。
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";

/** 气泡底边到锚点顶边的距离（px）。其中约 4px 是小三角露出的部分，
 *  剩下的才是"看得见的留白"——太贴会显得压在图标上（用户反馈），所以留 14px。 */
const GAP = 14;
/** 视口左右安全边距 */
const EDGE = 8;
const DEFAULT_DELAY = 450;

/**
 * 最近一次交互是键盘还是指针。
 * 只在键盘交互后响应 focus：面板关闭时组件会把焦点还给触发按钮，
 * 鼠标用户不该因为"焦点被挪回去"就看到一个黏住的气泡。
 */
let keyboardIntent = false;
let intentWatched = false;
function watchInputIntent() {
  if (intentWatched || typeof window === "undefined") return;
  intentWatched = true;
  const pointer = () => {
    keyboardIntent = false;
  };
  window.addEventListener("keydown", () => {
    keyboardIntent = true;
  }, true);
  window.addEventListener("pointerdown", pointer, true);
  window.addEventListener("mousedown", pointer, true);
  window.addEventListener("touchstart", pointer, { capture: true, passive: true });
  window.addEventListener("wheel", pointer, { capture: true, passive: true });
}

type Props = {
  /** 气泡内容（一般是一句说明） */
  content: ReactNode;
  /** 悬浮触发元素；受控常驻模式（open + anchor）时可以省略 */
  children?: ReactNode;
  /** 外部锚点：给常驻提示用，例如当前激活的测量按钮 */
  anchor?: HTMLElement | null;
  /** 受控显示：传了就不走 hover / delay（常驻操作提示） */
  open?: boolean;
  /** 气泡语义；常驻状态提示可用 status */
  role?: "tooltip" | "status";
  /** 悬浮多久后出现（ms） */
  delay?: number;
  /** 临时禁用悬浮气泡（不影响子按钮） */
  disabled?: boolean;
  /** 外层 span 的类名：需要 shrink-0 / 外边距时从这里给 */
  wrapperClassName?: string;
  /** 气泡本体额外类名 */
  className?: string;
};

type Position = {
  left: number;
  top: number;
  arrow: number;
  /** 气泡在锚点上方还是下方（顶部空间不足时翻到下面） */
  side: "top" | "bottom";
};

export default function DockTooltip({
  content,
  children,
  anchor: anchorProp,
  open: openProp,
  role = "tooltip",
  delay = DEFAULT_DELAY,
  disabled = false,
  wrapperClassName,
  className,
}: Props) {
  const controlled = openProp !== undefined;
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const [hoverOpen, setHoverOpen] = useState(false);
  const isOpen = controlled ? !!openProp : hoverOpen;
  /** 视口坐标；null = 还没量完（先隐藏，避免闪一下旧位置） */
  const [pos, setPos] = useState<Position | null>(null);
  /** 淡入门控：量到坐标后的下一帧才置 true，第一帧永远停在 opacity 0 */
  const [faded, setFaded] = useState(false);
  const bubbleId = useId();

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  /**
   * 真正的定位锚点：
   *   · 受控模式用外部 anchor；
   *   · 悬浮模式取 wrapper 的第一个子元素（Button / button），而不是 0 尺寸的 wrapper。
   */
  const anchorOf = useCallback(() => {
    if (anchorProp !== undefined) return anchorProp;
    return (
      (wrapRef.current?.firstElementChild as HTMLElement | null) ??
      wrapRef.current
    );
  }, [anchorProp]);

  const reposition = useCallback(() => {
    const bubble = bubbleRef.current;
    const anchor = anchorOf();
    if (!bubble || !anchor) return;

    const a = anchor.getBoundingClientRect();
    const w = bubble.offsetWidth;
    const h = bubble.offsetHeight;
    if (!w || !h) return;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const centerX = a.left + a.width / 2;
    const maxLeft = Math.max(EDGE, vw - w - EDGE);
    const left = Math.min(Math.max(centerX - w / 2, EDGE), maxLeft);

    // 默认在正上方（dock 在底部）；顶部放不下就翻到正下方（顶栏按钮），
    // 两边都放不下时留在空间更大的那一侧并夹取到安全边距。
    const aboveTop = a.top - GAP - h;
    const belowTop = a.bottom + GAP;
    const fitsAbove = aboveTop >= EDGE;
    const fitsBelow = belowTop + h <= vh - EDGE;

    let top = aboveTop;
    let side: "top" | "bottom" = "top";
    if (!fitsAbove) {
      if (fitsBelow) {
        top = belowTop;
        side = "bottom";
      } else if (vh - a.bottom > a.top) {
        top = Math.min(belowTop, Math.max(EDGE, vh - h - EDGE));
        side = "bottom";
      } else {
        top = EDGE;
      }
    }
    if (top + h > vh - EDGE) top = Math.max(EDGE, vh - h - EDGE);

    // 小三角始终指向按钮中心；气泡被视口挤偏时箭头跟着偏
    const arrow = Math.min(Math.max(centerX - left, 12), Math.max(12, w - 12));

    setPos({ left, top, arrow, side });
  }, [anchorOf]);

  const hide = useCallback(() => {
    clearTimer();
    setHoverOpen(false);
  }, [clearTimer]);

  const show = useCallback(
    (wait: number) => {
      if (disabled) return;
      clearTimer();
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        setHoverOpen(true);
      }, wait);
    },
    [clearTimer, disabled]
  );

  // 打开后先量一次（layout effect：在首帧绘制前落位）；
  // 内容 / 锚点变化也重排，常驻提示切工具时不会停在旧位置。
  useLayoutEffect(() => {
    if (!isOpen) return;
    reposition();
  }, [isOpen, reposition, content]);

  // 关闭后撤掉淡入标记、清掉旧坐标，下次打开从"隐藏→测量→淡入"重新开始
  useEffect(() => {
    if (isOpen) return;
    setFaded(false);
    setPos(null);
  }, [isOpen]);

  // 坐标就位后的下一帧才开始淡入。
  // 只做 opacity：没有 translate / scale，气泡第一帧起就在正确位置，
  // 不会出现"从页面左上角滑过来"的观感。
  const hasPos = pos !== null;
  useEffect(() => {
    if (!isOpen || !hasPos) return;
    const raf = requestAnimationFrame(() => setFaded(true));
    return () => cancelAnimationFrame(raf);
  }, [isOpen, hasPos]);

  // 无障碍：气泡展开期间把锚点关联到气泡（读屏器可读出说明）。
  // 受控常驻提示（测量工具的 status）不挂，避免重复播报。
  useEffect(() => {
    if (!isOpen || controlled) return;
    const anchor = anchorOf();
    if (!anchor?.setAttribute) return;
    const prev = anchor.getAttribute("aria-describedby");
    anchor.setAttribute("aria-describedby", prev ? `${prev} ${bubbleId}` : bubbleId);
    return () => {
      if (prev) anchor.setAttribute("aria-describedby", prev);
      else anchor.removeAttribute("aria-describedby");
    };
  }, [isOpen, controlled, anchorOf, bubbleId]);

  // 跟随滚动 / 窗口变化 / 锚点或气泡自身尺寸变化重新定位
  useEffect(() => {
    if (!isOpen) return;
    const update = () => reposition();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    // 常驻提示的开关归父组件管，Esc 不在这里拦截
    if (!controlled) window.addEventListener("keydown", onKey);
    const ro =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    const anchor = anchorOf();
    if (anchor && ro) ro.observe(anchor);
    // 内容变化（例如“不可用→可用”换了文案）会改宽度，箭头也得重新对准
    if (bubbleRef.current && ro) ro.observe(bubbleRef.current);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
      if (!controlled) window.removeEventListener("keydown", onKey);
      ro?.disconnect();
    };
  }, [isOpen, controlled, reposition, hide, anchorOf]);

  // 卸载时清掉还没触发的计时器
  useEffect(() => () => clearTimer(), [clearTimer]);

  // 记录最近一次交互是键盘还是指针（focus 气泡只在键盘交互后出现）
  useEffect(() => {
    watchInputIntent();
  }, []);

  return (
    <>
      {children !== undefined && (
        <span
          ref={wrapRef}
          className={cn("inline-flex", wrapperClassName)}
          onMouseEnter={() => show(delay)}
          onMouseLeave={hide}
          onFocus={(e) => {
            // 鼠标点击也会触发 focus：只有"键盘交互后真的 focus-visible"才立刻弹，
            // 否则会留下一个没人要、又不会自己消失的气泡
            if (
              keyboardIntent &&
              (e.target as HTMLElement).matches?.(":focus-visible")
            ) {
              show(0);
            }
          }}
          onBlur={hide}
          onClick={hide}
          onKeyDown={(e) => {
            if (e.key === "Escape") hide();
          }}
        >
          {children}
        </span>
      )}

      {isOpen &&
        content != null &&
        createPortal(
          <div
            ref={bubbleRef}
            id={bubbleId}
            role={role}
            data-dock-tooltip="1"
            data-side={pos?.side ?? "top"}
            data-state={faded ? "open" : "starting"}
            style={{
              left: pos?.left ?? 0,
              top: pos?.top ?? 0,
              opacity: pos !== null && faded ? 1 : 0,
              visibility: pos ? "visible" : "hidden",
              // 只过渡透明度；位移 / 缩放一律不参与
              transition: "opacity 120ms ease-out",
            }}
            className={cn(
              // 浅色 surface / 无边框 / 12px 文字 / 6–8px 内边距
              // 注意：入场只淡入，且由 pos + rAF 双重门控。任何 animate-in /
              // zoom-in / slide-in 都会在坐标未定时先出现在别处，务必不要加回来。
              // 配色对齐 Stitch 的提示条：浅灰 surface + 近黑文字（不是纯白卡片），
              // 深色主题下换成深灰 surface + 浅字；无边框，软阴影，箭头与气泡同色。
              "pointer-events-none fixed z-[80] max-w-64 rounded-xl bg-[#EFEFEF] px-2.5 py-1.5 text-center text-[12px] leading-snug font-medium text-[#2B2B2B] shadow-[0_10px_28px_-10px_rgba(0,0,0,0.30),0_2px_8px_-3px_rgba(0,0,0,0.16)] dark:bg-[#2E2E2E] dark:text-[#F2F2F2]",
              className
            )}
          >
            {content}
            {/* 小三角：旋转 45° 的方块，露出气泡的那一半就是箭头。
                上方的气泡 → 箭头贴底边；翻到下方的气泡 → 箭头贴顶边。 */}
            <span
              aria-hidden
              className={cn(
                "absolute size-2 -translate-x-1/2 rotate-45 rounded-[1px] bg-[#EFEFEF] dark:bg-[#2E2E2E]",
                pos?.side === "bottom"
                  ? "bottom-full translate-y-1/2"
                  : "top-full -translate-y-1/2"
              )}
              style={{ left: pos?.arrow ?? 0 }}
            />
          </div>,
          document.body
        )}
    </>
  );
}
