/**
 * FollowTooltip —— 跟随指针的 Stitch 风格名称气泡（替代原生 `title`）。
 *
 * 为什么不用原生 `title`：系统气泡的配色 / 圆角 / 字号都不受控，还带一段延迟，
 * 和面板里其他提示条完全不是一个语言。这里自己画一个，并且只在**名称真的被截断**
 * 时才弹（没截断的短名字弹气泡只是噪音）。
 *
 * 观感：popover 语义色 surface、rounded-xl、无硬边框、12px 文字、软阴影；
 * 浅色 / 深色主题由 `--popover` 令牌自动跟随，不写死颜色。
 *
 * 定位：气泡整块跟在指针的右上方——底边压在指针上方 12px，水平以指针居中（右移 14px）。
 *   行高大于 24px 时 12px 还不够，会再抬到 hover 行顶之上 4px，所以**永远不盖住那一行**；
 *   · 贴右边缘时整块翻到指针左侧，贴上边缘时翻到指针下方（顶边 = 指针 + 18px），
 *     上下都放不下时挑空间大的一侧，最后再夹进视口，绝不溢出；
 *   · 全程 rAF 节流，每次 pointermove 不直接进 React state。
 *
 * 入场：先在 (0,0) 用 visibility:hidden 量好尺寸 → 拿到坐标 → 只把 opacity 0→1。
 *   绝对不要加 animate-in / zoom-in / slide-in：坐标还没算出来时元素停在左上角，
 *   任何位移/缩放动画都会让它从页面左上角"飞"过来。
 *
 * 单例：模块级集合，同一时刻只允许一个气泡存在。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";

/** 视口安全边距 */
const EDGE = 8;
/** 水平：气泡中心相对指针右移 14px */
const OFF_X = 14;
/** 垂直：气泡整块在指针上方，底边留 12px（不压住 hover 的那一行） */
const GAP_ABOVE = 12;
/** 上方放不下时翻到指针下方，气泡顶边离指针 18px */
const GAP_BELOW = 18;
/**
 * 与 hover 那一行（`<tr>`）之间至少留的缝。
 * 行高 30px 而指针在行中间时，"离指针 12px"仍会切进行顶 3px（行顶在指针上方 15px），
 * 所以再补一条约束：底边不得低于行顶 - 4px。两条件取更靠上的那个，指针位置不会抖。
 */
const ROW_CLEAR = 4;
/** 淡入时长（ms） */
const FADE = 130;

/** 同一时刻只允许一个气泡：谁要开，先把别人的关掉 */
const openSet = new Set<() => void>();

type Props = {
  /** 气泡内容（一般是完整名称） */
  content: ReactNode;
  /** 触发元素（通常就是带 truncate 的名称文本） */
  children: ReactNode;
  /** 包裹层类名：截断样式、字号、焦点环都从这里给 */
  wrapperClassName?: string;
  /** 气泡本体额外类名 */
  className?: string;
  /**
   * 允许键盘聚焦读全名。只有**被截断**的才真正进 Tab 序列：
   * 一张图常常几十上百个图层，给每个名字都加 tabindex=0 会让键盘用户
   * 在这一列里按到天荒地老，而没截断的名字本来也读得全。
   */
  focusable?: boolean;
};

type Pos = { left: number; top: number; side: "top" | "bottom" };

export default function FollowTooltip({
  content,
  children,
  wrapperClassName,
  className,
  focusable = false,
}: Props) {
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  /** 最新指针位置（视口坐标）；键盘 focus 时用锚点矩形中心兜底 */
  const ptrRef = useRef({ x: 0, y: 0 });
  const rafRef = useRef<number | null>(null);
  /** 本实例注册进单例集合的"关掉自己"函数 */
  const selfCloseRef = useRef<(() => void) | null>(null);

  const [open, setOpen] = useState(false);
  /** 视口坐标；null = 还没量完（先隐藏，避免闪一下左上角） */
  const [pos, setPos] = useState<Pos | null>(null);
  /** 淡入门控：量到坐标后的下一帧才置 true，第一帧永远停在 opacity 0 */
  const [faded, setFaded] = useState(false);
  /** 名称是否被截断（决定要不要进 Tab 序列） */
  const [truncated, setTruncated] = useState(false);

  /** 名称是否真的被截断：只有截断了才有必要弹气泡 */
  const isTruncated = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap) return false;
    const cut = (el: HTMLElement) => el.scrollWidth > el.clientWidth + 1;
    if (cut(wrap)) return true;
    // 截断可能发生在子元素上（例如外层只是布局容器）
    return Array.from(wrap.querySelectorAll<HTMLElement>("*")).some(cut);
  }, []);

  /** 名称所在的行（表格行 / 列表项），用来保证气泡不压住这一整行 */
  const anchorRowRect = useCallback((): DOMRect | null => {
    const wrap = wrapRef.current;
    if (!wrap) return null;
    const row = wrap.closest("tr, li, [role='row']") ?? wrap;
    return row.getBoundingClientRect();
  }, []);

  /** 按最新指针位置摆好气泡，并做边界翻转 */
  const place = useCallback(() => {
    const bubble = bubbleRef.current;
    if (!bubble) return;
    const w = bubble.offsetWidth;
    const h = bubble.offsetHeight;
    if (!w || !h) return;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const { x, y } = ptrRef.current;
    const row = anchorRowRect();

    // 水平：以指针居中；贴右边缘 → 整块翻到指针左侧（改为向左展开），别被视口切掉
    let left = x + OFF_X - w / 2;
    if (left + w > vw - EDGE) left = x - OFF_X - w;
    left = Math.min(Math.max(left, EDGE), Math.max(EDGE, vw - w - EDGE));

    // 垂直：整块抬到指针上方，底边至少离指针 12px；
    // 指针落在这一行里时，12px 往往还不够（行高 30 > 24），再把底边提到行顶之上。
    const pointerOnRow = !!row && y >= row.top - ROW_CLEAR && y <= row.bottom + ROW_CLEAR;
    let bottomLimit = y - GAP_ABOVE;
    if (pointerOnRow && row && row.top < bottomLimit) bottomLimit = row.top - ROW_CLEAR;

    let top = bottomLimit - h;
    let side: "top" | "bottom" = "top";

    if (top < EDGE) {
      // 上方放不下 → 翻到指针下方（顶边 = 指针 + 18），指针在行里时再让到行底之下
      top = pointerOnRow && row ? Math.max(y + GAP_BELOW, row.bottom + ROW_CLEAR) : y + GAP_BELOW;
      side = "bottom";

      if (top + h > vh - EDGE) {
        // 上下都不够（视口很矮 / 气泡很高）：挑空间大的一侧，再夹进视口
        const roomAbove = bottomLimit - EDGE;
        const roomBelow = vh - EDGE - (y + GAP_BELOW);
        side = roomAbove >= roomBelow ? "top" : "bottom";
        top = side === "top" ? bottomLimit - h : y + GAP_BELOW;
      }
    }

    // 兜底夹取：视口比气泡还窄 / 还矮时至少保证不出界
    top = Math.min(Math.max(top, EDGE), Math.max(EDGE, vh - h - EDGE));

    setPos({ left, top, side });
  }, [anchorRowRect]);

  /** pointermove 只更新 ref，真正定位合并到一帧一次 */
  const schedulePlace = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      place();
    });
  }, [place]);

  const close = useCallback(() => setOpen(false), []);

  /** 打开：先关掉别人的气泡，再挂载（挂载后由 layout effect 量尺寸落位） */
  const requestOpen = useCallback(() => {
    if (!isTruncated()) return;
    openSet.forEach((fn) => {
      if (fn !== selfCloseRef.current) fn();
    });
    setFaded(false);
    setPos(null);
    setOpen(true);
  }, [isTruncated]);

  // 打开后的第一件事：在 (0,0)、visibility:hidden 的状态下量尺寸并落位。
  // 用 layout effect 是为了在首帧绘制前就落位，用户看不到"在左上角闪一下"。
  useLayoutEffect(() => {
    if (!open || pos !== null) return;
    place();
  }, [open, pos, place]);

  // 坐标就位后的下一帧才开始淡入（只过渡 opacity，没有位移 / 缩放）
  useEffect(() => {
    if (!open || !pos || faded) return;
    const raf = requestAnimationFrame(() => setFaded(true));
    return () => cancelAnimationFrame(raf);
  }, [open, pos, faded]);

  // 关闭后清掉旧坐标与淡入标记，下次打开重新走"隐藏→测量→淡入"
  useEffect(() => {
    if (open) return;
    setPos(null);
    setFaded(false);
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, [open]);

  // 注册到单例集合
  useEffect(() => {
    const fn = () => setOpen(false);
    selfCloseRef.current = fn;
    openSet.add(fn);
    return () => {
      openSet.delete(fn);
      if (selfCloseRef.current === fn) selfCloseRef.current = null;
    };
  }, []);

  // 量一次截断状态：只有被截断的名字才值得进 Tab 序列
  useLayoutEffect(() => {
    if (!focusable) return;
    const wrap = wrapRef.current;
    if (!wrap) return;
    const update = () => setTruncated(isTruncated());
    update();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    ro?.observe(wrap);
    return () => ro?.disconnect();
  }, [focusable, isTruncated]);

  // 滚动时指针坐标已经和行脱钩了，直接收起；Esc 也收起
  useEffect(() => {
    if (!open) return;
    const onScroll = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // 卸载时别留下没跑完的 frame
  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    },
    []
  );

  return (
    <>
      <span
        ref={wrapRef}
        tabIndex={focusable && truncated ? 0 : focusable ? -1 : undefined}
        className={cn("inline-block", wrapperClassName)}
        onPointerEnter={(e) => {
          ptrRef.current = { x: e.clientX, y: e.clientY };
          requestOpen();
        }}
        onPointerMove={(e) => {
          ptrRef.current = { x: e.clientX, y: e.clientY };
          if (open) schedulePlace();
        }}
        onPointerLeave={close}
        onFocus={(e) => {
          // 鼠标点击也会 focus：只有键盘交互后的 focus-visible 才弹，
          // 否则指针位置会被锚点中心覆盖、气泡莫名其妙地跳一下
          if (!(e.target as HTMLElement).matches?.(":focus-visible")) return;
          const r = wrapRef.current?.getBoundingClientRect();
          if (r) {
            ptrRef.current = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }
          requestOpen();
        }}
        onBlur={close}
      >
        {children}
      </span>

      {open &&
        content != null &&
        createPortal(
          <div
            ref={bubbleRef}
            role="tooltip"
            data-follow-tooltip="1"
            data-state={faded ? "open" : "starting"}
            data-side={pos?.side ?? "top"}
            style={{
              left: pos?.left ?? 0,
              top: pos?.top ?? 0,
              opacity: pos !== null && faded ? 1 : 0,
              visibility: pos ? "visible" : "hidden",
              // 只过渡透明度；位移 / 缩放不参与，气泡不会从别处飞过来
              transition: `opacity ${FADE}ms ease-out`,
            }}
            className={cn(
              // 长名字换行而不是 ellipsis：气泡里没必要再截一次
              "pointer-events-none fixed z-[80] max-w-72 rounded-xl bg-popover px-2.5 py-1.5 text-xs leading-snug break-words text-popover-foreground shadow-[0_10px_30px_-12px_rgba(0,0,0,0.35)]",
              className
            )}
          >
            {content}
          </div>,
          document.body
        )}
    </>
  );
}
