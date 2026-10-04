/** 底稿行与某一侧新版行之间的一对一相等匹配。 */
export interface LineMatch {
  /** 底稿行号（从 0 开始）。 */
  baseIndex: number;
  /** 新版行号（从 0 开始）。 */
  sideIndex: number;
}

/**
 * 一侧相对底稿的一次连续替换。
 * 底稿区间 [baseStart, baseEnd) 被替换为 lines。
 * baseStart === baseEnd 表示纯插入；lines 为空表示纯删除。
 */
export interface Edit {
  baseStart: number;
  baseEnd: number;
  lines: string[];
}

/** 一个冲突：底稿片段与两侧各自修改后的完整片段。 */
export interface Conflict {
  /** 冲突覆盖的底稿区间 [baseStart, baseEnd)。 */
  baseStart: number;
  baseEnd: number;
  /** 底稿原文片段。 */
  baseLines: string[];
  /** 仅纳入本组修改后的本地侧片段。 */
  localLines: string[];
  /** 仅纳入本组修改后的修订侧片段。 */
  remoteLines: string[];
}

/** 合并输出中的一个块：已确定的行，或一个待选择的冲突。 */
export type MergeChunk =
  | { kind: 'lines'; lines: string[] }
  | { kind: 'conflict'; conflictIndex: number };

/** 三方合并结果，仅驻留内存。 */
export interface MergeResult {
  /** 按顺序排列的合并块。 */
  chunks: MergeChunk[];
  /** 全部冲突，顺序与 chunks 中的出现顺序一致。 */
  conflicts: Conflict[];
}

/** 冲突选择：本地侧或修订侧。 */
export type ConflictChoice = 'local' | 'remote';
