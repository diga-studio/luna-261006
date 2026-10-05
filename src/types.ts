/** 一项待结算成果。预算 P 以积分单位计，1 个积分单位 = 0.01 工作量分。 */
export interface WorkInput {
  /** 成果唯一 ID */
  id: string;
  /** 所属指标 */
  indicator: string;
  /** 非负整数预算 P（积分单位） */
  budget: number;
  /** 有序且不重复的作者列表，第 1 位权重最高 */
  authors: string[];
}

/** 一个（作者, 指标）组合的非负整数周期上限 C（积分单位）。 */
export interface CapInput {
  author: string;
  indicator: string;
  cap: number;
}

/** 调用方提供的某个周期已定版的结算输入。 */
export interface SettleInput {
  works: WorkInput[];
  caps: CapInput[];
}

/** 一项成果的整数积分分配结果。 */
export interface WorkAllocation {
  workId: string;
  /** 仅包含署名作者；值为该作者分得的整数积分 */
  shares: Record<string, number>;
}

export type SettleOutput = WorkAllocation[];
