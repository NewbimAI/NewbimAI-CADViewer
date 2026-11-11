/**
 * 比对差异叠加层。
 *
 * 一块铺在 WebGL 画布上的 SVG（`pointer-events: none`），只做一件事：
 * 把 `POST /api/compare` 返回的 WCS 图元投影成画布 CSS 像素并描出来。
 *
 * 为什么不用 React 渲染这几千条线：
 *   拖动画布时 `viewChanged` 每帧都来，React 每次 re-render + diff 几千个节点
 *   会把 16ms 的预算吃光。所以几何全部命令式建一次（`build`），之后每帧只
 *   改已经存在的节点的属性（`update`），并用 rAF 合并。
 *
 * 投影怎么算：契约只给了 `viewer.project(wcsX, wcsY)` 这一个点接口。
 *   正交相机下 WCS→canvas 是**仿射**的，所以每帧取三个点（原点、+X、+Y）
 *   反解出 2×2 基向量，之后所有顶点都是纯算术——零对象分配、零 three.js 调用。
 *   （拿 scene 坐标当 WCS 用会整体偏移 GetOrigin()，契约 §1 明确禁止。）
 */
import { useCallback, useEffect, useRef } from "react";

import type { DxfApi } from "@/components/DxfCanvas";
import type { CompareChange, CompareBBox, CompareKind } from "@/types";

/** 契约 §5 固定的三种颜色 */
export const CHANGE_COLORS: Record<CompareKind, string> = {
  added: "#22c55e",
  removed: "#ef4444",
  modified: "#f59e0b",
};

/** 叠加层最多画这么多条变更；超出部分在界面上标注"已简化显示" */
export const MAX_OVERLAY_CHANGES = 4000;

const KIND_ORDER: CompareKind[] = ["added", "removed", "modified"];

const SVG_NS = "http://www.w3.org/2000/svg";

/** 主描边 / 光晕描边（单位：画布像素）。
 *  用户反馈"红绿黄太粗"——主描边降到 1px、强调 1.8px，光晕收窄一些只做轻微衬底。 */
const MAIN_WIDTH = 1;
const MAIN_WIDTH_EMPHASIS = 1.8;
const HALO_WIDTH = MAIN_WIDTH * 2.2;
const HALO_WIDTH_EMPHASIS = MAIN_WIDTH_EMPHASIS * 2.2;

type PrimKind = "polyline" | "point" | "text";

type PrimRec = {
  kind: PrimKind;
  main: SVGElement;
  halo: SVGElement;
  /** WCS 平铺坐标：[x, y, x, y, …] */
  wcs: number[];
  /** 投影后的画布坐标，长度与 `wcs` 相同；复用以避免每帧分配 */
  scr: Float64Array;
  closed: boolean;
};

type ItemRec = {
  id: number;
  setId: number;
  /** WCS 包围盒；退化（0 面积）时为 null，只按点处理 */
  bbox: CompareBBox | null;
  group: SVGGElement;
  halo: SVGGElement;
  mains: SVGGElement;
  prims: PrimRec[];
  /** 当前是否画出来（视口粗筛结果），避免每帧重复写 display */
  shown: boolean;
};

type Props = {
  api: DxfApi | null;
  /** 已经按类型/种类筛选过的变更（App 里 useMemo） */
  changes: CompareChange[];
  /** 隐藏时完全不干活（连 rAF 都不排） */
  hidden?: boolean;
  /** 单条高亮：其余变更压暗 */
  selectedId?: number | null;
  /** 变更集高亮：不在该集里的变更压暗 */
  activeSetId?: number | null;
  maxChanges?: number;
  /**
   * 并排对比时按侧拆分：
   *   base   = 删除 + 修改的**左侧**（旧的）
   *   target = 新增 + 修改的**右侧**（新的）
   * 不传则保持单画布行为（修改两侧都画）。
   */
  side?: "base" | "target";
};

/** 一位小数够用，还能把坐标字符串做短（几千条线时这很值钱） */
function r1(v: number): number {
  return Math.round(v * 10) / 10;
}

function bboxOf(raw: CompareBBox | null | undefined): CompareBBox | null {
  if (!raw || raw.length < 4) return null;
  const [minX, minY, maxX, maxY] = raw;
  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY)
  ) {
    return null;
  }
  return [minX, minY, maxX, maxY];
}

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K
): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, tag);
}

export default function ChangeOverlay({
  api,
  changes,
  hidden = false,
  selectedId = null,
  activeSetId = null,
  maxChanges = MAX_OVERLAY_CHANGES,
  side,
}: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const rootRef = useRef<SVGGElement | null>(null);
  const itemsRef = useRef<ItemRec[]>([]);
  const rafRef = useRef(0);

  // 渲染期写 ref：rAF 回调、事件回调里读到的永远是最新值，且不会造成重渲染
  const apiRef = useRef(api);
  apiRef.current = api;
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const selRef = useRef(selectedId);
  selRef.current = selectedId;
  const setRef = useRef(activeSetId);
  setRef.current = activeSetId;

  /** 每帧重算所有顶点（rAF 合并后调用） */
  const update = useCallback(() => {
    const svg = svgRef.current;
    const viewer = apiRef.current;
    const items = itemsRef.current;
    if (!svg || !viewer?.project || hiddenRef.current || !items.length) return;

    const w = svg.clientWidth;
    const h = svg.clientHeight;
    if (!w || !h) return;

    // 三个点反解仿射基：canvas = p0 + a·x + b·y（x/y 为 WCS）
    let p0: { x: number; y: number } | null;
    let px: { x: number; y: number } | null;
    let py: { x: number; y: number } | null;
    try {
      p0 = viewer.project(0, 0);
      px = viewer.project(1, 0);
      py = viewer.project(0, 1);
    } catch {
      return;
    }
    if (!p0 || !px || !py) return;

    // a = 沿 WCS X 的每单位位移（画布像素），b = 沿 WCS Y 的
    const ax = px.x - p0.x;
    const ay = px.y - p0.y;
    const bx = py.x - p0.x;
    const by = py.y - p0.y;
    const ox = p0.x;
    const oy = p0.y;

    // 视口外留一点余量，避免粗描边在边缘被硬切
    const margin = 24;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      // 先用包围盒粗筛：缩放到局部时，绝大多数变更根本不在这块视口里
      if (item.bbox) {
        const [minX, minY, maxX, maxY] = item.bbox;
        let x0 = Infinity;
        let x1 = -Infinity;
        let y0 = Infinity;
        let y1 = -Infinity;
        for (let c = 0; c < 4; c++) {
          const cx = c & 1 ? maxX : minX;
          const cy = c & 2 ? maxY : minY;
          const sx = ox + ax * cx + bx * cy;
          const sy = oy + ay * cx + by * cy;
          if (sx < x0) x0 = sx;
          if (sx > x1) x1 = sx;
          if (sy < y0) y0 = sy;
          if (sy > y1) y1 = sy;
        }
        const outside =
          x1 < -margin || x0 > w + margin || y1 < -margin || y0 > h + margin;
        if (outside) {
          if (item.shown) {
            item.group.style.display = "none";
            item.shown = false;
          }
          continue;
        }
      }

      if (!item.shown) {
        item.group.style.display = "";
        item.shown = true;
      }

      for (let p = 0; p < item.prims.length; p++) {
        const prim = item.prims[p];
        const wcs = prim.wcs;
        const scr = prim.scr;
        const n = wcs.length;

        for (let k = 0; k < n; k += 2) {
          const x = wcs[k];
          const y = wcs[k + 1];
          scr[k] = ox + ax * x + bx * y;
          scr[k + 1] = oy + ay * x + by * y;
        }

        if (prim.kind === "polyline") {
          const count = n / 2;
          if (!count) continue;
          // 闭合多段线要补回起点：SVG 的 <polyline> 不会自动闭合
          const total = prim.closed && count > 1 ? count + 1 : count;
          let points = "";
          for (let k = 0; k < total; k++) {
            const j = (k % count) * 2;
            points +=
              (k ? " " : "") + `${r1(scr[j])},${r1(scr[j + 1])}`;
          }
          prim.main.setAttribute("points", points);
          prim.halo.setAttribute("points", points);
        } else if (prim.kind === "point") {
          const cx = `${r1(scr[0])}`;
          const cy = `${r1(scr[1])}`;
          prim.main.setAttribute("cx", cx);
          prim.main.setAttribute("cy", cy);
          prim.halo.setAttribute("cx", cx);
          prim.halo.setAttribute("cy", cy);
        } else {
          // 文字：只画一条 6px 短横线做标记，不排文字（几千条会糊成一片）
          const cx = scr[0];
          const cy = r1(scr[1]);
          const x1 = `${r1(cx - 3)}`;
          const x2 = `${r1(cx + 3)}`;
          for (const el of [prim.main, prim.halo]) {
            el.setAttribute("x1", x1);
            el.setAttribute("y1", `${cy}`);
            el.setAttribute("x2", x2);
            el.setAttribute("y2", `${cy}`);
          }
        }
      }
    }
  }, []);

  const schedule = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      update();
    });
  }, [update]);

  /** 高亮 / 压暗只改组属性：不重建节点，也不重算几何 */
  const applySelection = useCallback(() => {
    const sel = selRef.current;
    const activeSet = setRef.current;
    const items = itemsRef.current;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      let emphasis = false;
      let opacity = "1";
      if (sel != null) {
        emphasis = item.id === sel;
        if (!emphasis) opacity = "0.16";
      } else if (activeSet != null) {
        emphasis = item.setId === activeSet;
        if (!emphasis) opacity = "0.3";
      }
      item.group.setAttribute("opacity", opacity);
      item.mains.setAttribute(
        "stroke-width",
        `${emphasis ? MAIN_WIDTH_EMPHASIS : MAIN_WIDTH}`
      );
      item.halo.setAttribute(
        "stroke-width",
        `${emphasis ? HALO_WIDTH_EMPHASIS : HALO_WIDTH}`
      );
    }
  }, []);

  /**
   * 建节点。只在"数据/上限"变化时跑一次：每个变更一个 <g>，
   * 里面按光晕 → 主线的顺序放两层，保证光晕永远在线下面。
   */
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.replaceChildren();
    itemsRef.current = [];

    const cap = Math.max(0, maxChanges);
    // 先按侧过滤再截断：否则并排时一侧会被另一侧用不到的变更占掉名额
    const list = changes
      .filter((c) =>
        side === "base"
          ? c.kind !== "added"
          : side === "target"
            ? c.kind !== "removed"
            : true
      )
      .slice(0, cap);
    if (!list.length) return;

    const kindGroups = new Map<CompareKind, SVGGElement>();
    for (const kind of KIND_ORDER) {
      const g = svgEl("g");
      g.setAttribute("data-compare-kind", kind);
      // 颜色挂在这一层，子节点只继承；后面高亮只改描边宽度
      g.setAttribute("stroke", CHANGE_COLORS[kind]);
      root.append(g);
      kindGroups.set(kind, g);
    }

    for (const change of list) {
      const kindGroup = kindGroups.get(change.kind);
      if (!kindGroup) continue;

      const color = CHANGE_COLORS[change.kind];
      const group = svgEl("g");
      group.setAttribute("data-change-id", `${change.id}`);
      group.setAttribute("opacity", "1");

      const halo = svgEl("g");
      halo.setAttribute("fill", "none");
      halo.setAttribute("stroke", color);
      halo.setAttribute("stroke-opacity", "0.25");
      halo.setAttribute("stroke-width", `${HALO_WIDTH}`);
      halo.setAttribute("stroke-linecap", "round");
      halo.setAttribute("stroke-linejoin", "round");

      const mains = svgEl("g");
      mains.setAttribute("fill", "none");
      mains.setAttribute("stroke", color);
      mains.setAttribute("stroke-width", `${MAIN_WIDTH}`);
      mains.setAttribute("stroke-linecap", "round");
      mains.setAttribute("stroke-linejoin", "round");

      group.append(halo, mains);
      kindGroup.append(group);

      const item: ItemRec = {
        id: change.id,
        setId: change.setId,
        bbox: bboxOf(change.bbox),
        group,
        halo,
        mains,
        prims: [],
        shown: true,
      };

      // added 贴在 target 上、removed 贴在 base 上；modified 两侧都画（就是"旧→新"两处）。
      // 并排模式下每张画布只拿自己那一侧：修改在左边画旧的、右边画新的。
      const sources =
        side === "base"
          ? change.base
          : side === "target"
            ? change.target
            : change.kind === "removed"
              ? change.base
              : change.kind === "added"
                ? change.target
                : [...change.base, ...change.target];

      for (const prim of sources) {
        if (!prim) continue;

        if (prim.kind === "polyline") {
          const pts = prim.points ?? [];
          if (!pts.length) continue;
          const wcs: number[] = new Array(pts.length * 2);
          for (let i = 0; i < pts.length; i++) {
            const pt = pts[i];
            if (!pt) {
              wcs[i * 2] = 0;
              wcs[i * 2 + 1] = 0;
              continue;
            }
            wcs[i * 2] = pt[0];
            wcs[i * 2 + 1] = pt[1];
          }
          const haloEl = svgEl("polyline");
          haloEl.setAttribute("fill", "none");
          const mainEl = svgEl("polyline");
          mainEl.setAttribute("fill", "none");
          halo.append(haloEl);
          mains.append(mainEl);
          item.prims.push({
            kind: "polyline",
            main: mainEl,
            halo: haloEl,
            wcs,
            scr: new Float64Array(wcs.length),
            closed: !!prim.closed,
          });
        } else if (prim.kind === "point") {
          const wcs = [prim.x, prim.y];
          const haloEl = svgEl("circle");
          haloEl.setAttribute("r", "5");
          haloEl.setAttribute("fill", color);
          haloEl.setAttribute("fill-opacity", "0.25");
          haloEl.setAttribute("stroke", "none");
          const mainEl = svgEl("circle");
          mainEl.setAttribute("r", "2.5");
          mainEl.setAttribute("fill", color);
          mainEl.setAttribute("stroke", "none");
          halo.append(haloEl);
          mains.append(mainEl);
          item.prims.push({
            kind: "point",
            main: mainEl,
            halo: haloEl,
            wcs,
            scr: new Float64Array(2),
            closed: false,
          });
        } else if (prim.kind === "text") {
          const wcs = [prim.x, prim.y];
          const haloEl = svgEl("line");
          const mainEl = svgEl("line");
          halo.append(haloEl);
          mains.append(mainEl);
          item.prims.push({
            kind: "text",
            main: mainEl,
            halo: haloEl,
            wcs,
            scr: new Float64Array(2),
            closed: false,
          });
        }
      }

      if (!item.prims.length) {
        group.remove();
        continue;
      }

      itemsRef.current.push(item);
    }

    applySelection();
    // 建完立刻画一帧，别等下一次 viewChanged（换图后它可能一时半会不会来）
    update();
  }, [changes, maxChanges, side, applySelection, update]);

  // 选中项 / 高亮变更集变化
  useEffect(() => {
    applySelection();
  }, [selectedId, activeSetId, changes, applySelection]);

  // 视图订阅：回调里只排 rAF，真正的重算在 update 里
  useEffect(() => {
    if (!api?.onViewChange) return;
    return api.onViewChange(schedule);
  }, [api, schedule]);

  // 显隐切换 / 换画布 / 换数据：重新排一帧（隐藏期间不排，恢复时补画）
  useEffect(() => {
    if (!hidden) schedule();
  }, [hidden, api, changes, schedule]);

  // 容器尺寸变化（dxf-viewer 的 resized 也会发 viewChanged，这里兜一层）
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => schedule());
    ro.observe(svg);
    return () => ro.disconnect();
  }, [schedule]);

  // 卸载时取消还没跑的那一帧
  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      itemsRef.current = [];
    };
  }, []);

  // 这一侧实际会画的变更数（并排时两侧不同，排查用）
  const sideCount = side
    ? changes.reduce((n, c) => {
        const onThisSide = side === "base" ? c.kind !== "added" : c.kind !== "removed";
        return onThisSide ? n + 1 : n;
      }, 0)
    : changes.length;

  return (
    <svg
      ref={svgRef}
      className="pointer-events-none absolute inset-0 size-full"
      // 关闭「显示差异」时整层隐藏：不止停止重绘，已有的线也必须看不见
      style={hidden ? { display: "none" } : undefined}
      aria-hidden="true"
      data-compare-overlay="1"
      data-compare-side={side}
      data-compare-count={sideCount}
      data-compare-hidden={hidden ? "1" : undefined}
    >
      <g ref={rootRef} />
    </svg>
  );
}
