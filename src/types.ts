/** 一次连续替换：底稿区间 [baseStart, baseEnd) 被替换为 lines。 */
export interface Edit {
  baseStart: number;
  baseEnd: number;
  lines: string[];
}

/** 一个冲突：覆盖的底稿区间，以及底稿/本地/修订三侧在该区间内的完整片段。 */
export interface Conflict {
  index: number;
  baseStart: number;
  baseEnd: number;
  base: string[];
  local: string[];
  revised: string[];
}

/** 合并输出片段：已自动合并的行，或一个待选择的冲突块。 */
export type Segment =
  | { type: 'lines'; lines: string[] }
  | { type: 'conflict'; conflictIndex: number };

export interface MergeResult {
  segments: Segment[];
  conflicts: Conflict[];
}

export type Side = 'local' | 'revised';
