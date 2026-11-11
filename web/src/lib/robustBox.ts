import type { DxfViewer } from "dxf-viewer";

export type RobustBox = { minX: number; minY: number; maxX: number; maxY: number };

/**
 * 场景真实内容的稳健包围盒（Tukey 箱线图栅栏，k = 1.5）。
 *
 * 为什么不能直接用 `viewer.GetBounds()`（2026-11-08 实测，勿删）：
 *   引擎的 bounds 是所有已画顶点的**硬** min/max。真实图纸里常混着坐标已经损坏的
 *   游离图元（本例 `施工005-车库消防.dwg` 有落在 x≈7.8e11 / y≈-1.08e11 的实体），
 *   它们会把 bounds 撑大 5~6 个数量级：按它 `FitView` 等于把整张图缩成一个点，
 *   这就是用户说的「打开/全图以后什么都没有」。
 *
 * 而服务端 `meta.json` 的 `contentBox` 又走向另一个极端：它只统计 ENTITIES 段里的
 *   顶层锚点，**看不见块内几何**。本图 2815 个 INSERT 里最大的一块（地库墙柱）
 *   插在图纸一角、内容却铺满全图，于是 contentBox 只覆盖到图纸下方 2/3，
 *   默认取景把顶部整条设备房裁掉——同样是「看起来丢了内容」。
 *
 * 因此这里按**实际画出来的顶点**做分位数统计：坐标分布本身就代表"内容在哪"，
 *   Tukey 栅栏能剔除 1% 量级的飞点而保留稀疏但真实的边角内容（实测本图
 *   x 496.7k..1340.3k / y -72.3k..82.9k → 修正后 x 521k..1318k / y -168.6k..246.8k，
 *   完整覆盖 649k..1258k / -123k..235k 的真实图面）。
 *
 * 采样上限 25 万点：大图（本图 88.8 万顶点）下也只是毫秒级，且分布足够稳定。
 */
const MAX_SAMPLES = 250_000;

/** 每个轴允许的 Tukey 栅栏系数。1.5 = 常规离群点定义。 */
const TUKEY_K = 1.5;

/** 绝对上限：超过它就认为坐标已经损坏，不参与统计（1e9 ≈ 1000 km）。 */
const ABS_LIMIT = 1e9;

function quantile(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[i];
}

/**
 * @param viewer 已 Load 完成的 DxfViewer
 * @returns 图纸内容盒（模型坐标）；顶点不足或数据异常时返回 null
 */
export function sceneRobustBox(viewer: DxfViewer): RobustBox | null {
  let scene: { children: ArrayLike<unknown> };
  let origin: { x: number; y: number };
  try {
    scene = viewer.GetScene() as unknown as { children: ArrayLike<unknown> };
    origin = viewer.GetOrigin();
  } catch {
    return null;
  }
  if (!scene || !scene.children) return null;

  const objects: Array<{ geometry?: { attributes?: Record<string, { array?: ArrayLike<number>; count?: number; itemSize?: number } | undefined> } }> = [];
  let total = 0;
  for (let i = 0; i < scene.children.length; i++) {
    const obj = scene.children[i] as (typeof objects)[number] | null;
    const pos = obj?.geometry?.attributes?.position;
    if (!pos || !pos.count) continue;
    objects.push(obj!);
    total += pos.count;
  }
  if (total < 32) return null;

  const stride = 1;
  const xs = new Float64Array(Math.ceil(total / stride) + 1);
  const ys = new Float64Array(xs.length);
  let n = 0;
  let seen = 0;
  /* 每个批次固定取 32 个点（而不是按顶点总数统一抽稀）。v36 起 TTF 文字变成三角网格，
   * 一个 EQUIP-消防 批次就有 570 万顶点，按总量抽稀时它会把 Tukey 分位数整个拉进文字区，
   * 内容盒随之缩到半张图 —— 实测 施工005 从 y -167k..234k 缩成 -71k..77k。
   * 按批次等量采样后，文字批次和墙线批次权重相同，盒回到真实图面。 */
  const PER_OBJECT_SAMPLES = 32;
  for (const obj of objects) {
    const pos = obj.geometry?.attributes?.position;
    if (!pos?.array || !pos.count) continue;
    const arr = pos.array;
    const step = pos.itemSize || 2;
    const objStride = Math.max(1, Math.ceil(pos.count / PER_OBJECT_SAMPLES));
    for (let i = 0; i < pos.count; i += objStride, seen++) {
      const x = arr[i * step] + origin.x;
      const y = arr[i * step + 1] + origin.y;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (Math.abs(x) > ABS_LIMIT || Math.abs(y) > ABS_LIMIT) continue;
      xs[n] = x;
      ys[n] = y;
      n++;
    }
  }
  if (n < 32) return null;

  const sx = xs.subarray(0, n).slice().sort();
  const sy = ys.subarray(0, n).slice().sort();

  const fence = (sorted: Float64Array): [number, number] => {
    const q1 = quantile(sorted, 0.25);
    const q3 = quantile(sorted, 0.75);
    const iqr = q3 - q1;
    if (!(iqr > 0)) return [sorted[0], sorted[sorted.length - 1]];
    return [q1 - TUKEY_K * iqr, q3 + TUKEY_K * iqr];
  };
  const [loX, hiX] = fence(sx);
  const [loY, hiY] = fence(sy);
  if (!(hiX > loX) || !(hiY > loY)) return null;

  /* 栅栏之后再把"完全空的边缘"往里收：Tukey 栅栏按 IQR 外扩，本图 x 左边界会多出
   * ~8 万单位空白。只剪**一个顶点都没有**的直方图分箱，稀疏但真实的内容（图框、
   * 远处注释）一个点就能保住。 */
  const trimEmpty = (sorted: Float64Array, lo: number, hi: number): [number, number] => {
    const BINS = 512;
    const w = (hi - lo) / BINS;
    if (!(w > 0)) return [lo, hi];
    const hist = new Int32Array(BINS);
    for (let i = 0; i < sorted.length; i++) {
      const v = sorted[i];
      if (v < lo || v > hi) continue;
      hist[Math.min(BINS - 1, Math.floor((v - lo) / w))]++;
    }
    let a = 0;
    while (a < BINS && hist[a] === 0) a++;
    let b = BINS - 1;
    while (b >= 0 && hist[b] === 0) b--;
    if (a > b) return [lo, hi];
    return [lo + a * w, lo + (b + 1) * w];
  };
  const [tLoX, tHiX] = trimEmpty(sx, loX, hiX);
  const [tLoY, tHiY] = trimEmpty(sy, loY, hiY);

  /* 把栅栏夹回真实数据范围，避免对外扩出来的空区取景 */
  return {
    minX: Math.max(tLoX, sx[0]),
    maxX: Math.min(tHiX, sx[sx.length - 1]),
    minY: Math.max(tLoY, sy[0]),
    maxY: Math.min(tHiY, sy[sy.length - 1]),
  };
}

/** 两个盒子的并集；任一为空则返回另一个。 */
export function unionBox(a: RobustBox | null | undefined, b: RobustBox | null | undefined): RobustBox | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}
