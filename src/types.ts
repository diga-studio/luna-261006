/**
 * 共享费用分摊的公共类型定义。
 *
 * 比例规则已全部换算为万分比（合计 10000）的非负整数权重；
 * 金额一律以“分”为单位的非负 bigint 表示。
 */

/** 一个待分摊的共享费用科目。 */
export interface ExpenseSubject {
  /** 科目唯一字符串 ID。 */
  readonly id: string;
  /** 待分摊金额（分），非负。 */
  readonly amount: bigint;
  /** 部门 ID -> 万分比权重（非负整数，全部部门合计 10000）。 */
  readonly weights: Readonly<Record<string, number>>;
}

/** 一批待分摊的共享费用。 */
export interface AllocationBatch {
  readonly subjects: readonly ExpenseSubject[];
}

/** 分摊结果：整数分摊矩阵 + 部门合计。 */
export interface AllocationResult {
  /** 科目 ID -> 部门 ID -> 分摊金额（分）。 */
  readonly matrix: Readonly<Record<string, Readonly<Record<string, bigint>>>>;
  /** 部门 ID -> 该部门全部分摊合计（分）。 */
  readonly departmentTotals: Readonly<Record<string, bigint>>;
}
