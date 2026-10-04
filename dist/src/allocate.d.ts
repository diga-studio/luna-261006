import type { AllocationResult, Batch } from "./types.js";
export type { AllocationResult, Batch, Subject } from "./types.js";
/**
 * 对一批共享费用做分摊：
 * - 单格取理想金额的 floor/ceil；
 * - 每个科目合计恰好等于科目金额；
 * - 每个部门合计取该部门理想合计的 floor/ceil；
 * - 先最小化部门合计绝对误差之和，再最小化单格绝对误差之和。
 *
 * 建模：y_ij ∈ {0,1} 表示单格是否向上取整。行和为等式、列和为区间约束，
 * 两级目标均为线性函数。网络采用“下界循环流”的标准变换：
 * 列 j 到汇点的免费边容量恰为 k_j（该部门必有的向上取整次数），
 * 全部入汇边容量之和等于总流量，因此最小费用最大流必然饱和所有免费边，
 * 下界自动成立。约束矩阵全幺模，必存在整数最优解。
 */
export declare function allocate(batch: Batch): AllocationResult;
