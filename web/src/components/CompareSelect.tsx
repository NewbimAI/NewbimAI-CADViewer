/**
 * CompareSelect —— 比对面板里的 Stitch 风格下拉（替代原生 select）。
 *
 * 结构：
 *   · 触发按钮与面板输入框同一层级（浅色 surface、无硬边框、圆角、chevron）；
 *   · 弹层 portal 到 body，宽度与触发按钮一致，靠近视口底部时向上翻转；
 *   · 分组标题 + 扁平选项（选中 ✓ / 浅底，hover 浅底，禁用 muted）；
 *   · 键盘：↑/↓ 高亮、Enter 选中、Home/End 首尾、Esc 关闭；
 *   · 打开后把当前项滚进视野，键盘移动同步滚动；
 *   · 拿到锚点坐标后才淡入 + 上移 2px，避免从左上角飞入。
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

export type CompareSelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

export type CompareSelectGroup = {
  label?: string;
  options: CompareSelectOption[];
};

type Props = {
  value: string | null;
  placeholder: string;
  groups: CompareSelectGroup[];
  onChange: (value: string) => void;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
};

type Pos = {
  left: number;
  top: number;
  width: number;
  placement: "bottom" | "top";
};

const EDGE = 8;
const GAP = 6;
/** 弹层最大高度（含 6px 内边距），超出时列表内部滚动 */
const MAX_H = 280;
const PAD = 6;
const MAX_LIST_H = MAX_H - PAD * 2;

export default function CompareSelect({
  value,
  placeholder,
  groups,
  onChange,
  ariaLabel,
  disabled = false,
  className,
}: Props) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [pos, setPos] = useState<Pos | null>(null);
  const [maxListH, setMaxListH] = useState(MAX_LIST_H);
  /** 未受视口约束时的自然高度（用于后续重排时重新判断向上/向下） */
  const naturalHRef = useRef(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const baseId = useId();
  const listId = `${baseId}-listbox`;

  /** 占位项 + 所有分组拍平；占位项 value = ""，用于清除选择 */
  const { flat, renderGroups } = useMemo(() => {
    const placeholderOption: CompareSelectOption = {
      value: "",
      label: placeholder,
    };
    const flat: CompareSelectOption[] = [placeholderOption];
    let index = 1;
    const renderGroups = groups.map((g) => ({
      label: g.label,
      options: g.options.map((option) => {
        const item = { option, index };
        index += 1;
        flat.push(option);
        return item;
      }),
    }));
    return { flat, renderGroups };
  }, [groups, placeholder]);

  const selectedIndex = flat.findIndex((o) => o.value === (value ?? ""));
  const selected = selectedIndex >= 0 ? flat[selectedIndex] : null;
  const display = selected?.label ?? placeholder;
  const muted = !value || !selected; // null / 空 / 不在列表里的值都按未选处理

  const enabledIndexes = useMemo(
    () => flat.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0),
    [flat]
  );

  const close = useCallback((focusTrigger = false) => {
    setOpen(false);
    setReady(false);
    setPos(null);
    setAnchor(null);
    setMaxListH(MAX_LIST_H);
    naturalHRef.current = 0;
    if (focusTrigger) {
      triggerRef.current?.focus({ preventScroll: true });
    }
  }, []);

  /** 重新量锚点和弹层，决定向上/向下；空间不足时压缩列表高度，避免盖住触发按钮 */
  const reposition = useCallback(() => {
    const trigger = triggerRef.current;
    const popup = popupRef.current;
    if (!trigger || !popup) return;
    const r = trigger.getBoundingClientRect();
    const width = r.width;
    const naturalH = naturalHRef.current || popup.offsetHeight;
    if (!naturalHRef.current) naturalHRef.current = naturalH;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const belowSpace = vh - r.bottom - GAP - EDGE;
    const aboveSpace = r.top - GAP - EDGE;
    const canBelow = naturalH <= belowSpace;
    const canAbove = naturalH <= aboveSpace;
    // 优先向下；下方放不下、上方放得下就向上翻转；
    // 两边都不够时选空间更大的一侧，并压缩列表高度。
    const placement: "bottom" | "top" = canBelow
      ? "bottom"
      : canAbove
        ? "top"
        : belowSpace >= aboveSpace
          ? "bottom"
          : "top";
    const space = placement === "bottom" ? belowSpace : aboveSpace;
    const targetH = Math.min(naturalH, Math.max(0, space));
    setMaxListH(Math.min(MAX_LIST_H, Math.max(0, targetH - PAD * 2)));

    let top =
      placement === "bottom" ? r.bottom + GAP : r.top - GAP - targetH;
    top = Math.min(Math.max(EDGE, top), Math.max(EDGE, vh - targetH - EDGE));
    const left = Math.min(
      Math.max(r.left, EDGE),
      Math.max(EDGE, vw - width - EDGE)
    );
    setPos({ left, top, width, placement });
  }, []);

  const openPopup = useCallback(
    (prefer: "selected" | "first" | "last" = "selected") => {
      const trigger = triggerRef.current;
      if (!trigger || disabled) return;
      const r = trigger.getBoundingClientRect();
      setAnchor(r);
      setPos({
        left: r.left,
        top: r.bottom + GAP,
        width: r.width,
        placement: "bottom",
      });
      setMaxListH(MAX_LIST_H);
      naturalHRef.current = 0;
      setReady(false);
      const fallback =
        prefer === "first"
          ? (enabledIndexes[0] ?? 0)
          : prefer === "last"
            ? (enabledIndexes[enabledIndexes.length - 1] ?? 0)
            : selectedIndex >= 0
              ? selectedIndex
              : (enabledIndexes[0] ?? 0);
      setActiveIndex(fallback);
      setOpen(true);
    },
    [disabled, enabledIndexes, selectedIndex]
  );

  const choose = useCallback(
    (index: number) => {
      const option = flat[index];
      if (!option || option.disabled) return;
      onChange(option.value);
      close(true);
    },
    [close, flat, onChange]
  );

  const move = useCallback(
    (dir: 1 | -1) => {
      if (!enabledIndexes.length) return;
      const at = enabledIndexes.indexOf(activeIndex);
      const next =
        at < 0
          ? dir > 0
            ? enabledIndexes[0]
            : enabledIndexes[enabledIndexes.length - 1]
          : enabledIndexes[
              Math.min(
                Math.max(at + dir, 0),
                enabledIndexes.length - 1
              )
            ];
      setActiveIndex(next);
    },
    [activeIndex, enabledIndexes]
  );

  const first = useCallback(() => {
    if (enabledIndexes.length) setActiveIndex(enabledIndexes[0]);
  }, [enabledIndexes]);

  const last = useCallback(() => {
    if (enabledIndexes.length) {
      setActiveIndex(enabledIndexes[enabledIndexes.length - 1]);
    }
  }, [enabledIndexes]);

  // 打开后先定位（弹层此刻还不可见），下一帧再淡入 + 上移 2px
  useLayoutEffect(() => {
    if (!open) return;
    const popup = popupRef.current;
    if (!popup) return;
    reposition();
    let raf = 0;
    raf = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(raf);
  }, [open, reposition, flat.length]);

  // 跟随面板滚动 / 窗口变化；外部点击关闭；Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onScroll = () => reposition();
    const onResize = () => reposition();
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (triggerRef.current?.contains(t)) return;
      if (popupRef.current?.contains(t)) return;
      close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close(true);
      }
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, close, reposition]);

  // 高亮项滚入弹层视野（打开时 + 键盘移动）
  useLayoutEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-compare-option-index="${activeIndex}"]`
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  const onTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (!open) openPopup("selected");
        else move(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        if (!open) openPopup("selected");
        else move(-1);
        break;
      case "Home":
        e.preventDefault();
        if (!open) openPopup("first");
        else first();
        break;
      case "End":
        e.preventDefault();
        if (!open) openPopup("last");
        else last();
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (!open) openPopup("selected");
        else choose(activeIndex);
        break;
      case "Escape":
        if (open) {
          e.preventDefault();
          close(true);
        }
        break;
      case "Tab":
        if (open) close(false);
        break;
    }
  };

  const activeId =
    open && activeIndex >= 0 ? `${baseId}-opt-${activeIndex}` : undefined;

  return (
    <div className={cn("relative min-w-0", className)}>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-label={`${ariaLabel}，当前 ${display}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={activeId}
        aria-disabled={disabled || undefined}
        disabled={disabled}
        onClick={() => (open ? close(true) : openPopup("selected"))}
        onKeyDown={onTriggerKeyDown}
        className={cn(
          "flex h-9 w-full min-w-0 items-center gap-2 rounded-xl bg-muted/55 px-3.5 text-left text-[12.5px] outline-none transition-colors",
          "hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring/40",
          disabled && "cursor-not-allowed opacity-50",
          muted ? "text-muted-foreground" : "text-foreground"
        )}
      >
        <span className="min-w-0 flex-1 truncate">{display}</span>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform duration-150",
            open && "rotate-180"
          )}
        />
      </button>

      {open &&
        createPortal(
          <div
            ref={popupRef}
            id={listId}
            role="listbox"
            aria-label={ariaLabel}
            data-compare-select="1"
            style={{
              left: pos?.left ?? anchor?.left ?? 0,
              top:
                pos?.top ??
                (anchor ? anchor.bottom + GAP : 0),
              width: pos?.width ?? anchor?.width ?? 0,
              visibility: pos ? "visible" : "hidden",
              opacity: ready ? 1 : 0,
              transform: ready ? "translateY(0)" : "translateY(2px)",
              transition: "opacity 140ms ease, transform 140ms ease",
            }}
            className="fixed z-[90] overflow-hidden rounded-xl bg-popover p-1.5 shadow-xl"
          >
            <div
              ref={listRef}
              style={{ maxHeight: maxListH }}
              className="overflow-y-auto overscroll-contain [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border"
            >
              {/* 占位项：清空选择 */}
              <div
                role="option"
                aria-selected={selectedIndex === 0}
                aria-disabled={flat[0].disabled || undefined}
                id={`${baseId}-opt-0`}
                data-compare-option-index={0}
                onMouseDown={(e) => e.preventDefault()}
                // 用 mousemove 而不是 mouseenter：键盘滚动列表时指针不动，不应抢走高亮
                onMouseMove={() => setActiveIndex(0)}
                onClick={() => choose(0)}
                className={cn(
                  "flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2.5 text-[12.5px] outline-none transition-colors",
                  activeIndex === 0
                    ? "bg-accent text-foreground"
                    : selectedIndex === 0
                      ? "bg-accent/45 font-medium text-foreground"
                      : "text-muted-foreground",
                  activeIndex === 0 && selectedIndex === 0 && "font-medium"
                )}
              >
                <span className="min-w-0 flex-1 truncate">{placeholder}</span>
                {selectedIndex === 0 && (
                  <Check className="size-3.5 shrink-0" aria-hidden />
                )}
              </div>

              {renderGroups.map((g, gi) => (
                <div key={g.label ?? `group-${gi}`} role="group" aria-label={g.label}>
                  {g.label && (
                    <div
                      role="presentation"
                      className="px-2 py-1.5 text-[11px] text-muted-foreground"
                    >
                      {g.label}
                    </div>
                  )}
                  {g.options.map(({ option, index }) => {
                    const selected = index === selectedIndex;
                    const active = index === activeIndex;
                    return (
                      <div
                        key={`${option.value}-${index}`}
                        role="option"
                        aria-selected={selected}
                        aria-disabled={option.disabled || undefined}
                        id={`${baseId}-opt-${index}`}
                        data-compare-option-index={index}
                        onMouseDown={(e) => e.preventDefault()}
                        onMouseMove={() => {
                          if (!option.disabled) setActiveIndex(index);
                        }}
                        onClick={() => choose(index)}
                        className={cn(
                          "flex h-8 items-center gap-2 rounded-lg px-2.5 text-[12.5px] outline-none transition-colors",
                          option.disabled
                            ? "cursor-not-allowed text-muted-foreground/45"
                            : "cursor-pointer",
                          !option.disabled && active
                            ? "bg-accent text-foreground"
                            : !option.disabled && selected
                              ? "bg-accent/45 font-medium text-foreground"
                              : !option.disabled
                                ? "text-foreground/85 hover:bg-accent"
                                : "",
                          !option.disabled && selected && "font-medium"
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {option.label}
                        </span>
                        {selected && (
                          <Check className="size-3.5 shrink-0" aria-hidden />
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
