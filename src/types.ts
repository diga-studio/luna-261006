/** 数量区间，左闭右开，基于 0。 */
export interface Interval {
  readonly start: number;
  readonly end: number;
}

/** 父批次的一段输入引用。 */
export interface InputRef {
  readonly parentId: string;
  readonly start: number;
  readonly end: number;
}

/** 原始入库记录。 */
export interface ReceiptRecord {
  readonly kind: 'receipt';
  readonly batchId: string;
  readonly quantity: number;
}

/** 拆分拼箱记录：新批次按 inputs 顺序连续拼接。 */
export interface RepackRecord {
  readonly kind: 'repack';
  readonly batchId: string;
  readonly inputs: readonly InputRef[];
}

/** 生产混料记录：任一实际投用区间含污染则整批受污染。 */
export interface MixRecord {
  readonly kind: 'mix';
  readonly batchId: string;
  readonly quantity: number;
  readonly inputs: readonly InputRef[];
}

export type HistoryRecord = ReceiptRecord | RepackRecord | MixRecord;

/** 召回结果：批次 ID -> 有序、不重叠、相邻已合并的受影响区间。 */
export type RecallResult = ReadonlyMap<string, readonly Interval[]>;
