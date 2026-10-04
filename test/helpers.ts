import type { Assignment, PlanningSnapshot, PlanMetrics } from '../src/index.js';

function pairKey(employeeId: string, demandId: string): string {
  return JSON.stringify([employeeId, demandId]);
}

function familyKey(departmentId: string, familyId: string): string {
  return JSON.stringify([departmentId, familyId]);
}

/** 独立核算：直接按定义统计五项目标值。 */
export function metricsOf(snapshot: PlanningSnapshot, assignments: Assignment[]): PlanMetrics {
  const priorityOf = new Map(snapshot.demands.map((d) => [d.id, d.priority]));
  const scoreOf = new Map(
    snapshot.candidates.map((c) => [pairKey(c.employeeId, c.demandId), c.score]),
  );
  const previous = new Map(snapshot.currentAssignments.map((a) => [a.employeeId, a.demandId]));
  const frozen = new Set(snapshot.frozenAssignments.map((a) => a.employeeId));
  const assignedTo = new Map(assignments.map((a) => [a.employeeId, a.demandId]));

  const metrics: PlanMetrics = {
    highFilled: 0,
    mediumFilled: 0,
    lowFilled: 0,
    totalScore: 0,
    moves: 0,
  };
  for (const assignment of assignments) {
    const priority = priorityOf.get(assignment.demandId)!;
    if (priority === 'high') metrics.highFilled += 1;
    else if (priority === 'medium') metrics.mediumFilled += 1;
    else metrics.lowFilled += 1;
    metrics.totalScore += scoreOf.get(pairKey(assignment.employeeId, assignment.demandId))!;
  }
  for (const [employeeId, demandId] of previous) {
    if (!frozen.has(employeeId) && assignedTo.get(employeeId) !== demandId) {
      metrics.moves += 1;
    }
  }
  return metrics;
}

/** 字典序比较：a 优于 b 返回正数。换岗人数越少越优。 */
export function compareMetrics(a: PlanMetrics, b: PlanMetrics): number {
  if (a.highFilled !== b.highFilled) return a.highFilled - b.highFilled;
  if (a.mediumFilled !== b.mediumFilled) return a.mediumFilled - b.mediumFilled;
  if (a.lowFilled !== b.lowFilled) return a.lowFilled - b.lowFilled;
  if (a.totalScore !== b.totalScore) return a.totalScore - b.totalScore;
  return b.moves - a.moves;
}

/** 校验方案是否满足全部硬约束（含冻结保留）。 */
export function feasibilityErrors(
  snapshot: PlanningSnapshot,
  assignments: Assignment[],
): string[] {
  const errors: string[] = [];
  const candidateKeys = new Set(
    snapshot.candidates.map((c) => pairKey(c.employeeId, c.demandId)),
  );
  const demandOf = new Map(snapshot.demands.map((d) => [d.id, d]));
  const employeeIds = new Set(snapshot.employees.map((e) => e.id));

  const byEmployee = new Map<string, string>();
  for (const assignment of assignments) {
    if (!employeeIds.has(assignment.employeeId)) {
      errors.push(`未知员工 ${assignment.employeeId}`);
    }
    if (!demandOf.has(assignment.demandId)) {
      errors.push(`未知需求项 ${assignment.demandId}`);
    }
    if (byEmployee.has(assignment.employeeId)) {
      errors.push(`员工 ${assignment.employeeId} 被分配多次`);
    }
    byEmployee.set(assignment.employeeId, assignment.demandId);
    if (!candidateKeys.has(pairKey(assignment.employeeId, assignment.demandId))) {
      errors.push(`非候选配对 ${assignment.employeeId} -> ${assignment.demandId}`);
    }
  }

  for (const frozen of snapshot.frozenAssignments) {
    if (byEmployee.get(frozen.employeeId) !== frozen.demandId) {
      errors.push(`冻结分配被改动: ${frozen.employeeId} -> ${frozen.demandId}`);
    }
  }

  const headcountUsed = new Map<string, number>();
  const familyUsed = new Map<string, number>();
  const departmentUsed = new Map<string, number>();
  for (const assignment of assignments) {
    const demand = demandOf.get(assignment.demandId)!;
    increment(headcountUsed, demand.id);
    increment(familyUsed, familyKey(demand.departmentId, demand.familyId));
    increment(departmentUsed, demand.departmentId);
  }
  for (const demand of snapshot.demands) {
    if ((headcountUsed.get(demand.id) ?? 0) > demand.headcount) {
      errors.push(`需求 ${demand.id} 超出需求人数`);
    }
  }
  for (const fc of snapshot.familyCapacities) {
    if ((familyUsed.get(familyKey(fc.departmentId, fc.familyId)) ?? 0) > fc.capacity) {
      errors.push(`职族 ${fc.departmentId}/${fc.familyId} 超出额度`);
    }
  }
  for (const department of snapshot.departments) {
    if ((departmentUsed.get(department.id) ?? 0) > department.capacity) {
      errors.push(`部门 ${department.id} 超出额度`);
    }
  }
  return errors;
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** 暴力枚举所有可行方案，返回字典序最优的目标值（仅适用于小规模）。 */
export function bruteForceBestMetrics(snapshot: PlanningSnapshot): PlanMetrics {
  const frozenByEmployee = new Map(
    snapshot.frozenAssignments.map((a) => [a.employeeId, a.demandId]),
  );
  const movable = snapshot.employees.filter((e) => !frozenByEmployee.has(e.id));
  const candidatesOf = new Map<string, string[]>();
  for (const employee of movable) {
    candidatesOf.set(
      employee.id,
      snapshot.candidates
        .filter((c) => c.employeeId === employee.id)
        .map((c) => c.demandId),
    );
  }

  let best: PlanMetrics | null = null;
  const chosen: Assignment[] = snapshot.frozenAssignments.map((a) => ({ ...a }));

  const visit = (index: number): void => {
    if (index === movable.length) {
      if (feasibilityErrors(snapshot, chosen).length > 0) return;
      const metrics = metricsOf(snapshot, chosen);
      if (best === null || compareMetrics(metrics, best) > 0) {
        best = metrics;
      }
      return;
    }
    const employeeId = movable[index].id;
    for (const demandId of candidatesOf.get(employeeId)!) {
      chosen.push({ employeeId, demandId });
      visit(index + 1);
      chosen.pop();
    }
    visit(index + 1); // 不分配
  };
  visit(0);
  if (best === null) throw new Error('暴力枚举没有找到可行方案');
  return best;
}
