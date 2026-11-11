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

/**
 * 模型 / 布局页签（服务端 `/api/open.spaces`）。
 * id 直接拼进 `/api/file/:id/dxf?space=`：`model` 或 `layout:<布局名>`。
 */
export interface DrawingSpace {
  id: string;
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
  /** 模型 / 布局页签；只有一个空间时服务端也会给（此时前端隐藏页签） */
  spaces?: DrawingSpace[];
  skippedEntities?: number;
  /**
   * 自定义对象（TCH_* / AEC_* 等 DXF 类名）检测结果。
   * v1 不含天正对象解析，仅用于提示用户：在支持该对象的软件里导出 T3 后再打开可获得完整显示。
   * 服务端保证该字段一定存在，未检出时为 `{ level: "none", classes: [], evidence: [] }`。
   */
  udo: {
    /** objects=确证含天正自定义对象类；provenance=仅检出天正制作痕迹；none=无 */
    level: "objects" | "provenance" | "none";
    /** level==="objects" 时：DXF CLASSES 段里的 TCH_* 类名（去重） */
    classes: string[];
    /** level==="provenance" 时：命中的天正样式/图块/图层名（去重，最多 12 个） */
    evidence: string[];
    /* ── v51：服务端用 udo-cli 读 DWG 得到的计数（没有二进制/未检出时缺省） ── */
    /** DWG 里自定义对象实体总数（含尚未解码的墙体/文字） */
    entities?: number;
    /** 自定义对象类数（CLI 口径；与 classes.length 不一定相同） */
    classCount?: number;
    /** 其中**已成功解出几何**的实体数（洞口/墙体/文字；前端"已尝试解析 N 个"用它） */
    decoded?: number;
    /** v51 起按类拆分：洞口 / 墙体 / 文字 各解出多少 */
    decodedByKind?: { opening?: number; wall?: number; text?: number };
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

/* ------------------------------------------------------------------ *
 * 图纸比对（POST /api/compare）
 * 字段与 docs/compare-contract.md §3 一一对应；坐标一律是图纸 WCS。
 * 这里不引用 shared/geometry——前端只消费结果，不参与比对计算。
 * ------------------------------------------------------------------ */

export type CompareKind = "added" | "removed" | "modified";

/** 参与比对的属性（契约 §3 options.compareProps） */
export type ComparePropKey = "color" | "layer" | "linetype" | "lineweight";

/** 图元点：[x, y]（WCS） */
export type ComparePoint = [number, number];

/** 图元（契约 §2 Primitive），圆弧已被内核离散成 polyline */
export type ComparePrimitive =
  | { kind: "polyline"; points: ComparePoint[]; closed: boolean }
  | { kind: "point"; x: number; y: number }
  | {
      kind: "text";
      x: number;
      y: number;
      height: number;
      rotation: number;
      text: string;
      layer?: string;
    };

/** [minX, minY, maxX, maxY] */
export type CompareBBox = [number, number, number, number];

export interface CompareChange {
  id: number;
  kind: CompareKind;
  type: string;
  layer: string;
  handleBase: string | null;
  handleTarget: string | null;
  bbox: CompareBBox;
  /** added 只有 target；removed 只有 base；modified 两侧都有 */
  base: ComparePrimitive[];
  target: ComparePrimitive[];
  setId: number;
}

export interface CompareChangeSet {
  id: number;
  bbox: CompareBBox;
  count: number;
  kinds: Record<CompareKind, number>;
}

export interface CompareWarning {
  code: string;
  type?: string;
  reason?: string;
  name?: string;
  count?: number;
}

export interface CompareSummary {
  added: number;
  removed: number;
  modified: number;
  unchanged: number;
  notCompared: number;
  changeSets: number;
  elapsedMs: number;
  truncated: boolean;
}

export interface CompareResult {
  base: { id: string; name: string };
  target: { id: string; name: string };
  summary: CompareSummary;
  changes: CompareChange[];
  changeSets: CompareChangeSet[];
  warnings: CompareWarning[];
}

export interface CompareRequestOptions {
  tolerance: number;
  quantize: number;
  compareProps: ComparePropKey[];
  includeHatch: boolean;
  maxChanges: number;
}

export interface CompareRequest {
  base: string;
  target: string;
  options: CompareRequestOptions;
}

/** GET /api/recent 的条目（server/index.js:831） */
export interface RecentFile {
  id: string;
  name: string;
  format: string;
  sizeBytes: number;
  statsOk: boolean;
  openedAt: number;
}

/* ------------------------------------------------------------------ *
 * 自动更新（/api/update/*，契约见 server/update.js）
 * 前端只消费状态：检查、下载、应用都由本机服务完成，页面不直接联网。
 * ------------------------------------------------------------------ */

/** 清单里的一个包（url/size/sha256 都可能缺省，服务端归一化时会给 0/空串） */
export interface UpdateAsset {
  url?: string;
  size?: number;
  sha256?: string;
  file?: string;
}

export interface UpdateManifest {
  version: string;
  releasedAt?: string;
  channel?: string;
  minVersion?: string;
  /** 更新说明（GitHub Release body 原样透传，纯文本展示） */
  notes?: string;
  assets: {
    /** 小体积更新包（一键更新用） */
    update?: UpdateAsset;
    /** 完整安装包（手动下载用） */
    full?: UpdateAsset;
  };
}

/** POST /api/update/check 的响应，也是 status.lastCheck 的形状 */
export interface UpdateCheck {
  /** 检查完成的毫秒时间戳 */
  at: number;
  current: string;
  latest: string | null;
  available: boolean;
  manifest: UpdateManifest | null;
  source: string | null;
  /** 检查失败（离线 / 超时 / 版本过低）时的中文原因；成功时没有这个字段 */
  error?: string;
}

export type UpdateJobStatus = "running" | "ready" | "error";

/** 下载任务。进度轮询 GET /api/update/status 拿最新快照 */
export interface UpdateJob {
  version: string;
  status: UpdateJobStatus;
  progress: { received: number; total: number };
  error: string | null;
  stageDir: string | null;
  startedAt: number;
}

/** GET /api/update/status（纯本地读取，不联网） */
export interface UpdateInfo {
  current: string;
  /** 安装目录可写才支持一键更新 */
  canSelfUpdate: boolean;
  /** 不可写时的中文原因 */
  reason: string | null;
  /** 安装目录 */
  root: string;
  lastCheck: UpdateCheck | null;
  job: UpdateJob | null;
}

/** POST /api/update/apply 的响应（服务随即退出） */
export interface UpdateApplyResult {
  ok: boolean;
  version: string;
  restart: boolean;
  pid: number;
}
