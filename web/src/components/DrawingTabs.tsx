/**
 * 图纸标签栏（画布上方的独立一行）。
 *
 * 左边是已打开的图纸（格式徽标 + 文件名 + 关闭），右端是信息面板的分段控件
 * （概览 / 图层 / 图块）。点分段打开/收起 App 里的浮动信息面板；「图纸对比」
 * 只在顶栏，不在这里。没有打开任何图纸时整行不渲染（App 负责）。
 *
 * 标签多起来以后：
 *  - 整条标签只在**可用宽度内**横向滚动，滚动条隐藏，左右两端用渐隐遮罩提示还有内容；
 *  - 单个标签有最大宽度，文件名 ellipsis 截断，title 里保留完整文件名；
 *  - 切换 / 新开标签时，把当前标签滚进可视区（平滑），并让出遮罩宽度，避免它半隐在渐隐里。
 *
 * 拖拽打开仍然由 App 根节点的 onDragOver / onDrop 处理，这一行只是普通 DOM，
 * 指针事件不会挡住画布（它在画布之外）。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { X } from "lucide-react";

import AllDrawingsMenu from "@/components/AllDrawingsMenu";
import DockTooltip from "@/components/DockTooltip";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type DrawingTab = {
  id: string;
  name: string;
  format: string;
};

/** 浮动信息面板的三个分段（对比模式由顶栏触发，不在分段里） */
export type PanelSegment = "overview" | "layers" | "blocks";

const PANEL_SEGMENTS: { id: PanelSegment; label: string }[] = [
  { id: "overview", label: "概览" },
  { id: "layers", label: "图层" },
  { id: "blocks", label: "图块" },
];

/** 分段控件选项：和右面板里那套完全一致（胶囊、纯文字、150ms） */
const SEG_ITEM =
  "relative z-10 flex h-5.5 items-center rounded-full px-2.5 text-xs font-normal text-muted-foreground transition-colors duration-150 hover:bg-foreground/[0.04] hover:text-foreground aria-pressed:font-medium aria-pressed:text-foreground aria-pressed:hover:bg-transparent";

type Props = {
  tabs: DrawingTab[];
  activeId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  /** 面板打开时高亮的分段；null = 面板关闭 / 处于对比模式 */
  panelSegment: PanelSegment | null;
  onSelectPanel: (segment: PanelSegment, trigger: HTMLElement) => void;
};

/** 左右渐隐的宽度（也作为标签滚入时的安全边距） */
const FADE_W = 28;

export default function DrawingTabs({
  tabs,
  activeId,
  onActivate,
  onClose,
  panelSegment,
  onSelectPanel,
}: Props) {
  const listRef = useRef<HTMLDivElement | null>(null);
  /** 哪一侧还有被滚出去的内容（决定渐隐遮罩是否出现） */
  const [edges, setEdges] = useState({ left: false, right: false });
  /** 标签条是否溢出（决定右端「全部图纸」下拉是否出现） */
  const [overflowing, setOverflowing] = useState(false);

  /* ---------------- 分段控件的滑动 thumb ---------------- */
  const segWrapRef = useRef<HTMLDivElement | null>(null);
  const segRefs = useRef(new Map<PanelSegment, HTMLButtonElement>());
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);

  /** 读激活项的 offsetLeft / offsetWidth 写进 thumb；没有激活项（面板关闭 / 对比模式）就不画 */
  const measureThumb = useCallback(() => {
    const wrap = segWrapRef.current;
    const btn = panelSegment ? segRefs.current.get(panelSegment) : null;
    if (!wrap || !btn) {
      setThumb(null);
      return;
    }
    setThumb({ x: btn.offsetLeft, w: btn.offsetWidth });
  }, [panelSegment]);

  // useLayoutEffect：切换分段时在绘制前把位置写进去，thumb 直接从旧位置滑到新位置
  useLayoutEffect(() => {
    measureThumb();
  }, [measureThumb, tabs.length]);

  // 容器宽度 / 窗口变化后重新量（字体、滚动条、面板开合都可能改变按钮宽度）
  useEffect(() => {
    const wrap = segWrapRef.current;
    if (!wrap) return;
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => measureThumb())
        : null;
    ro?.observe(wrap);
    const onResize = () => measureThumb();
    window.addEventListener("resize", onResize);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, [measureThumb]);

  const syncEdges = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setOverflowing(max > 1);
    setEdges({
      left: el.scrollLeft > 1,
      right: el.scrollLeft < max - 1,
    });
  }, []);

  /** 当前标签滚进可视区；用了 getBoundingClientRect，只动横向，不牵动页面其它滚动条 */
  const keepActiveVisible = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const list = listRef.current;
      if (!list || !activeId) return;
      const el = list.querySelector<HTMLElement>(
        `[data-tab-id="${CSS.escape(activeId)}"]`
      );
      if (!el) return;
      const lr = list.getBoundingClientRect();
      const tr = el.getBoundingClientRect();
      if (tr.left < lr.left + FADE_W) {
        list.scrollBy({
          left: tr.left - lr.left - FADE_W,
          behavior,
        });
      } else if (tr.right > lr.right - FADE_W) {
        list.scrollBy({
          left: tr.right - lr.right + FADE_W,
          behavior,
        });
      }
    },
    [activeId]
  );

  // 切换标签 / 新开标签 → 把当前标签带回视野
  useEffect(() => {
    keepActiveVisible("smooth");
  }, [keepActiveVisible, tabs.length]);

  // 面板开合、窗口缩放都会改变可用宽度：即时校正（不走动画，避免和宽度过渡打架）
  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      keepActiveVisible("auto");
      syncEdges();
    });
    ro.observe(list);
    return () => ro.disconnect();
  }, [keepActiveVisible, syncEdges]);

  // 标签数量变化后，滚动范围也变了
  useEffect(() => {
    syncEdges();
  }, [tabs.length, syncEdges]);

  /** 标签溢出、或图纸多到一眼扫不完时，右端给一个「全部图纸」入口 */
  const showAllDrawings = overflowing || tabs.length > 6;

  return (
    <div
      data-tab-strip="1"
      className="flex h-[34px] shrink-0 items-center gap-2 overflow-hidden border-b bg-card pl-2.5 pr-2"
    >
      <div className="relative min-w-0 flex-1">
        <div
          ref={listRef}
          role="tablist"
          aria-label="已打开的图纸"
          onScroll={syncEdges}
          className="flex h-full items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {tabs.map((tab) => {
            const active = tab.id === activeId;
            return (
              <div
                key={tab.id}
                role="tab"
                data-tab-id={tab.id}
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                onClick={() => onActivate(tab.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onActivate(tab.id);
                  }
                }}
                className={cn(
                  "group flex h-7 max-w-64 min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-2 text-sm transition-colors outline-hidden focus-visible:ring-3 focus-visible:ring-ring/50",
                  // 激活 = 实心浅底、无描边；未激活保持安静，只在悬停时抬一点
                  active
                    ? "bg-accent font-medium text-foreground shadow-xs"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                )}
              >
                <Badge
                  variant="secondary"
                  className="h-4 shrink-0 px-1.5 py-0 text-[10px] font-semibold"
                >
                  {tab.format}
                </Badge>
                <span
                  className="min-w-0 flex-1 truncate text-xs"
                  title={tab.name}
                >
                  {tab.name}
                </span>
                <DockTooltip
                  content="关闭图纸（可从最近打开找回）"
                  wrapperClassName="-mr-0.5 shrink-0"
                >
                  <button
                    type="button"
                    className="rounded-full p-px text-muted-foreground/70 transition-colors hover:bg-foreground/10 hover:text-foreground"
                    aria-label={`关闭 ${tab.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onClose(tab.id);
                    }}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </DockTooltip>
              </div>
            );
          })}
        </div>

        {/* 两侧渐隐：只在对应方向真的还有内容时出现，纯装饰、不接管指针 */}
        {edges.left && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-0 w-7 bg-gradient-to-r from-card to-transparent"
          />
        )}
        {edges.right && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 w-7 bg-gradient-to-l from-card to-transparent"
          />
        )}
      </div>

      {/* 「全部图纸」：标签条放不下时的兜底入口，紧挨分段控件左侧 */}
      {showAllDrawings && (
        <AllDrawingsMenu
          tabs={tabs}
          activeId={activeId}
          onActivate={onActivate}
          onClose={onClose}
        />
      )}

      {/* 信息面板分段控件：点当前项 = 收起面板，点其它项 = 打开/切换。
          白色胶囊 thumb 用 transform/width 滑到激活项下面，文字只做颜色过渡。 */}
      <div
        ref={segWrapRef}
        role="group"
        aria-label="信息面板"
        className="relative flex h-7 shrink-0 items-center overflow-hidden rounded-full border border-border/60 bg-muted p-0.5"
      >
        {thumb && (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0.5 left-0 z-0 rounded-full bg-card shadow-sm"
            style={{
              width: thumb.w,
              transform: `translateX(${thumb.x}px)`,
              transition:
                "transform 240ms cubic-bezier(.32,.72,0,1), width 240ms cubic-bezier(.32,.72,0,1)",
            }}
          />
        )}
        {PANEL_SEGMENTS.map((seg) => {
          const on = panelSegment === seg.id;
          return (
            <DockTooltip
              key={seg.id}
              content={on ? `收起${seg.label}面板` : `打开${seg.label}面板`}
              wrapperClassName="h-full"
            >
              <button
                ref={(el) => {
                  if (el) segRefs.current.set(seg.id, el);
                  else segRefs.current.delete(seg.id);
                }}
                type="button"
                data-panel-trigger="1"
                aria-pressed={on}
                aria-label={on ? `收起${seg.label}面板` : `打开${seg.label}面板`}
                onClick={(e) => onSelectPanel(seg.id, e.currentTarget)}
                className={SEG_ITEM}
              >
                {seg.label}
              </button>
            </DockTooltip>
          );
        })}
      </div>
    </div>
  );
}
