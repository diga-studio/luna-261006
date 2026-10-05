import { solve } from "./solver";
import { validateRequest } from "./validate";
import { COST_PER_HOUR } from "./types";
import type { PlanRequest, PlanResult } from "./types";

/**
 * 为一个厂区计算总停产费用最低的维护计划。
 * 费用相同时返回任意一个最优计划；无法覆盖全部设备时返回不可行。
 * 输入与计算结果仅保留在内存中。
 */
export function planMaintenance(request: PlanRequest): PlanResult {
  const { devices, candidateStarts } = validateRequest(request);
  const result = solve(devices, candidateStarts);
  if (!result.feasible) {
    return { feasible: false, groups: [], totalDowntimeHours: 0, totalCost: 0 };
  }
  return {
    feasible: true,
    groups: result.groups,
    totalDowntimeHours: result.totalDowntimeHours,
    totalCost: result.totalDowntimeHours * COST_PER_HOUR,
  };
}
