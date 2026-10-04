export * from './types.js';
export { solveSnapshot } from './solver.js';

import type { AllocationPlan, PlanningSnapshot } from './types.js';
import { solveSnapshot } from './solver.js';

/** 库入口：载入规划快照，生成整体最优分配方案（仅内存，不改变快照）。 */
export function generatePlan(snapshot: PlanningSnapshot): AllocationPlan {
  return solveSnapshot(snapshot);
}
