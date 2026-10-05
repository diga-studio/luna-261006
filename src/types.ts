/**
 * 历史记录与索引的类型定义。
 *
 * 批次内部数量用从 0 开始的左闭右开整数区间 [start, end) 表示。
 */

/** 左闭右开区间 [start, end)。 */
export interface Range {
  start: number;
  end: number;
}

/** 父批次输入引用：取父批次 [start, end) 这一段。 */
export interface InputRef {
  parent: string;
  start: number;
  end: number;
}

/** 原始入库记录：只有批次 ID 和数量。 */
export interface IntakeRecord {
  kind: 'intake';
  id: string;
  qty: number;
}

/** 拆分拼箱记录：新批次按 inputs 顺序连续拼接各输入区间。 */
export interface RepackRecord {
  kind: 'repack';
  id: string;
  inputs: InputRef[];
}

/** 生产混料记录：任一实际投用区间含污染则新批次全部受污染。 */
export interface MixRecord {
  kind: 'mix';
  id: string;
  inputs: InputRef[];
  qty: number;
}

export type HistoryRecord = IntakeRecord | RepackRecord | MixRecord;

/** 索引内部：归一化后的批次信息。 */
export interface BatchInfo {
  id: string;
  kind: 'intake' | 'repack' | 'mix';
  qty: number;
  /**
   * 该批次创建记录中的输入项。repack 的每项带 offset：
   * 父区间 [start, end) 映射到本批次 [offset, offset + (end - start))。
   */
  inputs: Array<{ parent: string; start: number; end: number; offset: number }>;
}

/** 索引内部：挂在父批次上的一条后续取用引用。 */
export interface OutRef {
  start: number;
  end: number;
  child: string;
  /** 在 child 的 inputs 数组中的下标。 */
  inputIndex: number;
}

/** buildIndex 的返回值：可重复查询的只读索引。 */
export interface RecallIndex {
  batches: Map<string, BatchInfo>;
  /** 每个父批次的后续取用引用，按 start 升序（同一父批次的引用互不重叠）。 */
  outRefs: Map<string, OutRef[]>;
}

/** 单次召回查询的结果：批次 ID -> 有序、不重叠、相邻已合并的受影响区间。 */
export type RecallResult = Map<string, Range[]>;

/** 可选的查询统计（用于测试验证查询开销）。 */
export interface RecallStats {
  /** 进入过污染集合的批次数。 */
  batchesTouched: number;
  /** 传播产生的污染区间片段总数。 */
  piecesPropagated: number;
  /** 在父批次引用表中执行二分查找的次数。 */
  refSearches: number;
  /** 实际命中并处理的后续取用引用条数。 */
  refsVisited: number;
}
