export interface LayerInfo {
  name: string;
  color: number;
  colorHex: string;
  frozen: boolean;
  off: boolean;
  locked: boolean;
  entityCount: number;
}

/** 画布聚焦：双击图层 / 图块后只亮显其一（服务端按 `focus=` 重新着色） */
export interface DxfFocus {
  kind: "layer" | "block";
  name: string;
}

export interface BlockInfo {
  name: string;
  isLayout: boolean;
  entityCount: number;
  refCount: number;
  nestedRefCount?: number;
  /**
   * 以下字段由服务端新增。客户端声明为可选：并行发布期间可能还读到旧响应，
   * 缺省时按「具名、有定义」处理——不能把 undefined 当成「定义缺失」。
   */
  /** false = 只有引用、没有块定义（如被溯源出来的 BLOCK_X） */
  defined?: boolean;
  /** 服务端不再输出 true 行（匿名块已并回原块）；保留字段用于兼容旧响应 */
  anonymous?: boolean;
  /** refCount 中来自被并入匿名块实例的部分 */
  anonymousRefCount?: number;
  /** 被并入的匿名块名（*U8…），用于聚焦时一起高亮 */
  aggregatedFrom?: string[];
  /**
   * 本图是否真的用到这个块定义：`refCount > 0`（顶层 INSERT）**或** `nestedRefCount > 0`
   * （被别的块内部引用）。两者都为 0 才是 PURGE 残留，列表默认不显示。
   * 缺省（旧响应）时由前端按同一规则自行计算。
   */
  used?: boolean;
}

export interface Extents {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

export interface DrawingStats {
  layers: LayerInfo[];
  blocks: BlockInfo[];
  entities: {
    total: number;
    byType: Record<string, number>;
    inserts: number;
  };
  extents: Extents | null;
  /** IQR 剔除飞点后的主体范围 */
  coreExtents?: Extents | null;
  /** 2D 密度区域增长算出的主体内容盒（默认视图范围） */
  contentBox?: Extents | null;
  header: {
    version: string | null;
    insunits: number | string | null;
    lastSavedBy: string | null;
  };
  blockDefCount: number;
  /** 未使用的块定义数（refCount 与 nestedRefCount 都为 0，列表不显示） */
  unusedBlockDefCount?: number;
  /** 被隐藏、未并入任何原块的匿名块数量（界面暂不显示） */
  anonymousHiddenCount?: number;
}

export interface OpenResult {
  id: string;
  name: string;
  format: string;
  sizeBytes: number;
  statsOk: boolean;
  statsError: string | null;
  stats: DrawingStats | null;
  skippedEntities?: number;
  /**
   * 天正自定义对象（TCH_*）检测结果。
   * v1 不含天正对象解析，仅用于提示用户：在天正中导出 T3 后再打开可获得完整显示。
   * 服务端保证该字段一定存在，未检出时为 `{ level: "none", classes: [], evidence: [] }`。
   */
  tch: {
    /** objects=确证含天正自定义对象类；provenance=仅检出天正制作痕迹；none=无 */
    level: "objects" | "provenance" | "none";
    /** level==="objects" 时：DXF CLASSES 段里的 TCH_* 类名（去重） */
    classes: string[];
    /** level==="provenance" 时：命中的天正样式/图块/图层名（去重，最多 12 个） */
    evidence: string[];
  };
  cadcraftInfo?: {
    version: string;
    layouts: string[];
    linetypes: number;
    textStyles: number;
  } | null;
  /** 派生数据（DXF 预处理）版本号：拼进 `/api/file/:id/dxf?v=` 做缓存失效键 */
  dxfVersion: number;
}
