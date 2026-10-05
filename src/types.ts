/** 难度固定为三档。 */
export type Difficulty = "基础" | "进阶" | "高阶";

export const DIFFICULTIES: readonly Difficulty[] = ["基础", "进阶", "高阶"];

/** 题目版本。questionId 跨版本不变；同一 questionId 只有最大 version 参与组卷。 */
export interface QuestionVersion {
  questionId: string;
  version: number;
  category: string;
  difficulty: Difficulty;
}

/** 题库快照：已按 questionId 去重（保留最大 version），并与外部输入隔离。 */
export interface QuestionBank {
  readonly questions: readonly QuestionVersion[];
}

/** 类别配额：未列出的类别配额为 0。 */
export type CategoryCounts = Readonly<Record<string, number>>;

/** 难度配额。 */
export type DifficultyCounts = Readonly<Partial<Record<Difficulty, number>>>;

/** 组卷成功结果。 */
export interface AssembleOk {
  readonly ok: true;
  /** 试卷题目，顺序稳定（与输入顺序无关）。 */
  readonly questions: readonly QuestionVersion[];
  /** 重复题数量（questionId 曾出现在 history 任意试卷中的题数）。 */
  readonly repeats: number;
  /** 随机成本总和（精确整数，BigInt 表示）。 */
  readonly totalCost: bigint;
}

/** 组卷失败结果：不存在合法试卷时明确返回无解，绝不返回部分试卷。 */
export interface AssembleNoSolution {
  readonly ok: false;
  readonly reason: string;
}

export type AssembleResult = AssembleOk | AssembleNoSolution;
