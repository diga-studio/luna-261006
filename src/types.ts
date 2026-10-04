/** 网格标识 */
export type GridId = string;
/** 会话标识 */
export type SessionId = string;
/** 操作标识（全局唯一） */
export type OpId = string;
/** 单元格值，结构化克隆可序列化的任意值 */
export type CellValue = unknown;

/** 单元格地址 */
export interface CellAddress {
  grid: GridId;
  row: number;
  col: number;
}

/** 一次编辑中的单个补丁 */
export interface Patch extends CellAddress {
  value: CellValue;
}

/** 构造时传入的网格规格 */
export interface GridSpec {
  id: GridId;
  rows: number;
  cols: number;
  /** 单一初始值，或 rows x cols 的二维初始值数组 */
  initial: CellValue | CellValue[][];
}

/** 行快照：某次提交后该行的完整值视图 */
export interface RowSnapshot {
  /** 产生该快照时的行版本号 */
  version: number;
  /** 快照时该行各列的值 */
  values: CellValue[];
}

/** inspect 中单个网格的只读视图 */
export interface GridInspection {
  id: GridId;
  rows: number;
  cols: number;
  /** 当前值，rows x cols */
  values: CellValue[][];
  /** 每行当前版本号 */
  rowVersions: number[];
  /** 每行保留的最近快照（每行最多 20 份，旧→新） */
  rowSnapshots: RowSnapshot[][];
}

/** inspect 中单个会话的只读视图 */
export interface SessionInspection {
  id: SessionId;
  /** 可撤销操作，按首次 edit 顺序（旧→新） */
  undoable: OpId[];
  /** 可重做操作，按重做执行顺序（先执行的在前） */
  redoable: OpId[];
}

/** inspect() 返回的整体只读视图（深拷贝，修改不影响内部状态） */
export interface Inspection {
  grids: GridInspection[];
  sessions: SessionInspection[];
}

/** edit 成功结果 */
export interface EditResult {
  ok: true;
  opId: OpId;
}

/** undo/redo 结果 */
export type UndoRedoResult =
  | { ok: true; opId: OpId }
  | { ok: false; reason: 'empty' | 'conflict' };
