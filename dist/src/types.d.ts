/** 一个科目的待分摊共享费用。 */
export interface Subject {
    /** 科目唯一 ID。 */
    id: string;
    /** 待分摊金额，单位分，非负。 */
    amount: bigint;
    /** 部门 ID -> 权重（万分比，非负整数，全部部门合计 10000）。 */
    weights: Readonly<Record<string, number>>;
}
/** 一批共享费用。 */
export interface Batch {
    subjects: readonly Subject[];
}
/** 分摊结果。 */
export interface AllocationResult {
    /** subjectId -> departmentId -> 分摊金额（分，整数）。 */
    matrix: Readonly<Record<string, Readonly<Record<string, bigint>>>>;
    /** departmentId -> 部门合计（分，整数）。 */
    departmentTotals: Readonly<Record<string, bigint>>;
}
