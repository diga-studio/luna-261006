/** 风险档位 */
export type Tier = "low" | "medium" | "high";

export const TIERS: readonly Tier[] = ["low", "medium", "high"];

/** 六个布尔指标，按固定顺序 */
export interface IndicatorFlags {
  /** 本学期 GPA 低于 2.0 */
  gpaBelow2: boolean;
  /** 出勤率低于 75% */
  attendanceBelow75: boolean;
  /** 助学金手续不完整 */
  aidIncomplete: boolean;
  /** 未定专业且累计学分超过 30 */
  undeclaredOver30: boolean;
  /** 当学期退课至少 2 门 */
  withdrew2Plus: boolean;
  /** 第一代大学生 */
  firstGen: boolean;
}

/** 一名学生的只读快照 */
export interface StudentSnapshot extends IndicatorFlags {
  studentId: string;
}

/** 一套规则：六个权重 + 中/高两条边界（均为整数） */
export interface RuleSet {
  weights: readonly [number, number, number, number, number, number];
  midThreshold: number;
  highThreshold: number;
}

/** 可修改参数名：六个权重 + 两条边界 */
export type ParameterKey =
  | "gpaWeight"
  | "attendanceWeight"
  | "aidWeight"
  | "undeclaredWeight"
  | "withdrawalWeight"
  | "firstGenWeight"
  | "midThreshold"
  | "highThreshold";

export const PARAMETER_KEYS: readonly ParameterKey[] = [
  "gpaWeight",
  "attendanceWeight",
  "aidWeight",
  "undeclaredWeight",
  "withdrawalWeight",
  "firstGenWeight",
  "midThreshold",
  "highThreshold",
];

/** 一份解释：实际发生变化的参数集合（规范化排序，与顺序无关） */
export interface Explanation {
  parameters: readonly ParameterKey[];
}

/** 某一迁移方向下，一份解释对应的人数 */
export interface ExplanationCount {
  parameters: readonly ParameterKey[];
  count: number;
}

/** 迁移方向，如 "medium->high" */
export type TransitionKey = `${Tier}->${Tier}`;

/** 一次完整预览的结果 */
export interface PreviewResult {
  /** 原档位 -> 候选档位 的九种人数 */
  transitions: Record<Tier, Record<Tier, number>>;
  /** 仅包含发生换档的方向；同一学生多份解释分别计数 */
  explanations: Partial<Record<TransitionKey, ExplanationCount[]>>;
}

/** 按学号查看的单学生预览 */
export interface StudentPreview {
  studentId: string;
  baselineScore: number;
  baselineTier: Tier;
  candidateScore: number;
  candidateTier: Tier;
  /** 不换档时为空数组 */
  explanations: Explanation[];
}
