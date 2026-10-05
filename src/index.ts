import type { PlantInput, PlanResult } from './types.js';
import { validateInput } from './validate.js';
import { solve } from './solver.js';
import { COST_PER_HOUR } from './types.js';

export type { Device, PlantInput, MaintenanceGroup, PlanResult } from './types.js';
export { COST_PER_HOUR } from './types.js';

/** 对一个厂区做一次维护窗口规划；输入与结果仅保留在内存中。 */
export function planMaintenance(input: PlantInput): PlanResult {
  validateInput(input);
  const devices = [...input.devices].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const slots = [...input.candidateSlots].sort((a, b) => a - b);
  const out = solve(devices, slots);
  return {
    feasible: out.feasible,
    groups: out.groups,
    totalDowntimeHours: out.totalDowntimeHours,
    totalCost: out.totalDowntimeHours * COST_PER_HOUR,
  };
}
