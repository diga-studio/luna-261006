/** 课程与学期的二元组，各 key 相互独立。 */
export interface CourseKey {
  courseId: string;
  semester: string;
}

/** 选分策略：最高分 或 最后一次。 */
export type ScoreStrategy = 'max' | 'last';

/** 评分规则：三项整数百分比权重（和为 100）、统一选分策略、整数及格线。 */
export interface GradingRule {
  weights: { homework: number; midterm: number; final: number };
  strategy: ScoreStrategy;
  passLine: number;
}

/** 一名学生的三项成绩，每项按考试次序 1~3 个 0~100 的整数分数。 */
export interface Attempts {
  homework: number[];
  midterm: number[];
  final: number[];
}

/** 成绩簿中单个学生的已发布行。 */
export interface GradebookRow {
  inputVersion: number;
  total: number;
  passed: boolean;
}

/** readGradebook 的返回快照。 */
export interface GradebookSnapshot {
  ruleVersion: number;
  students: Record<string, GradebookRow>;
}

/**
 * 重算过程的可控暂停点（仅测试使用）。
 * 每个钩子返回的 Promise 被 await，测试可用闸门精确控制重算节奏。
 */
export interface RecomputeHooks {
  /** 即将读取某学生输入之前。 */
  beforeCompute?(key: CourseKey, studentId: string): void | Promise<void>;
  /** 已读取某学生输入快照、尚未按新规则计算与暂存结果之前。 */
  afterInputRead?(key: CourseKey, studentId: string, inputVersion: number): void | Promise<void>;
  /** 某学生的新规则结果已暂存之后；computeCount 为本次纠错已完成的计算次数。 */
  afterCompute?(key: CourseKey, studentId: string, inputVersion: number, computeCount: number): void | Promise<void>;
}
