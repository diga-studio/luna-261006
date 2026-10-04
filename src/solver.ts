import { MinCostFlow } from './mincostflow.js';
import type {
  AllocationPlan,
  Assignment,
  PlanningSnapshot,
  PlanMetrics,
  Priority,
} from './types.js';

/** 用 JSON 序列化做复合键，避免 id 中出现分隔符导致冲突。 */
function pairKeyOf(employeeId: string, demandId: string): string {
  return JSON.stringify([employeeId, demandId]);
}

function familyKeyOf(departmentId: string, familyId: string): string {
  return JSON.stringify([departmentId, familyId]);
}

/**
 * 求解思路：把问题建成最小费用流，用 bigint 大 M 权重把五项目标
 * （高/中/低优先级人数、匹配分之和、换岗人数）编码进单一费用，
 * 权重逐级放大保证严格字典序。冻结分配预先扣除额度后从图中移除。
 */
export function solveSnapshot(snapshot: PlanningSnapshot): AllocationPlan {
  const model = buildModel(snapshot);

  const employeeCount = snapshot.employees.length;
  const scoreSlot = BigInt(100 * employeeCount + 1);
  const unitLow = scoreSlot;
  const unitMid = BigInt(employeeCount + 1) * unitLow;
  const unitHigh = BigInt(employeeCount + 1) * unitMid;
  const maxAssignmentValue = BigInt(employeeCount) * (unitHigh + 100n);
  const moveWeight = maxAssignmentValue + 1n;

  const source = 0;
  const sink = 1;
  const unassigned = 2;
  let nextNode = 3;
  const employeeNode = new Map<string, number>();
  const demandNode = new Map<string, number>();
  const familyNode = new Map<string, number>();
  const departmentNode = new Map<string, number>();
  for (const id of model.movableEmployeeIds) employeeNode.set(id, nextNode++);
  for (const demand of snapshot.demands) demandNode.set(demand.id, nextNode++);
  for (const key of model.familyKeys) familyNode.set(key, nextNode++);
  for (const id of model.departmentIds) departmentNode.set(id, nextNode++);

  const flow = new MinCostFlow(nextNode);
  const pairEdges: Array<{ employeeId: string; demandId: string }> = [];

  for (const id of model.movableEmployeeIds) {
    flow.addEdge({ from: source, to: employeeNode.get(id)!, capacity: 1, cost: 0n });
  }
  for (const pair of model.candidatePairs) {
    const priorityUnit = priorityUnitOf(model.demandPriority.get(pair.demandId)!, {
      low: unitLow,
      mid: unitMid,
      high: unitHigh,
    });
    const value = moveWeight * (priorityUnit + BigInt(pair.score));
    const previous = model.currentDemandOf.get(pair.employeeId);
    const moveCost = previous !== undefined && previous !== pair.demandId ? 1n : 0n;
    flow.addEdge({
      from: employeeNode.get(pair.employeeId)!,
      to: demandNode.get(pair.demandId)!,
      capacity: 1,
      cost: moveCost - value,
    });
    pairEdges.push({ employeeId: pair.employeeId, demandId: pair.demandId });
  }
  for (const id of model.movableEmployeeIds) {
    const moveCost = model.currentDemandOf.has(id) ? 1n : 0n;
    flow.addEdge({ from: employeeNode.get(id)!, to: unassigned, capacity: 1, cost: moveCost });
  }
  flow.addEdge({ from: unassigned, to: sink, capacity: model.movableEmployeeIds.length, cost: 0n });
  for (const demand of snapshot.demands) {
    flow.addEdge({
      from: demandNode.get(demand.id)!,
      to: familyNode.get(familyKeyOf(demand.departmentId, demand.familyId))!,
      capacity: model.remainingHeadcount.get(demand.id)!,
      cost: 0n,
    });
  }
  for (const key of model.familyKeys) {
    const [departmentId] = JSON.parse(key) as [string, string];
    flow.addEdge({
      from: familyNode.get(key)!,
      to: departmentNode.get(departmentId)!,
      capacity: model.remainingFamilyCapacity.get(key)!,
      cost: 0n,
    });
  }
  for (const id of model.departmentIds) {
    flow.addEdge({
      from: departmentNode.get(id)!,
      to: sink,
      capacity: model.remainingDepartmentCapacity.get(id)!,
      cost: 0n,
    });
  }

  flow.solve(source, sink, model.movableEmployeeIds.length);

  // pairEdges 之前按添加顺序还有 source->employee 边，flowOn 下标需要偏移。
  const edgeOffset = model.movableEmployeeIds.length;
  const assignments: Assignment[] = snapshot.frozenAssignments.map((a) => ({ ...a }));
  pairEdges.forEach(({ employeeId, demandId }, index) => {
    if (flow.flowOn(edgeOffset + index) === 1) assignments.push({ employeeId, demandId });
  });
  return { assignments, metrics: computeMetrics(snapshot, assignments) };
}

function priorityUnitOf(priority: Priority, units: { low: bigint; mid: bigint; high: bigint }): bigint {
  if (priority === 'high') return units.high;
  if (priority === 'medium') return units.mid;
  return units.low;
}

interface Model {
  movableEmployeeIds: string[];
  candidatePairs: Array<{ employeeId: string; demandId: string; score: number }>;
  /** 非冻结员工中，当前已分配者 employeeId -> demandId。 */
  currentDemandOf: Map<string, string>;
  demandPriority: Map<string, Priority>;
  remainingHeadcount: Map<string, number>;
  remainingFamilyCapacity: Map<string, number>;
  remainingDepartmentCapacity: Map<string, number>;
  familyKeys: string[];
  departmentIds: string[];
}

function buildModel(snapshot: PlanningSnapshot): Model {
  validateSnapshot(snapshot);

  const frozenEmployees = new Set(snapshot.frozenAssignments.map((a) => a.employeeId));
  const movableEmployeeIds = snapshot.employees
    .map((e) => e.id)
    .filter((id) => !frozenEmployees.has(id));

  const currentDemandOf = new Map<string, string>();
  for (const assignment of snapshot.currentAssignments) {
    if (!frozenEmployees.has(assignment.employeeId)) {
      currentDemandOf.set(assignment.employeeId, assignment.demandId);
    }
  }

  const remainingHeadcount = new Map(snapshot.demands.map((d) => [d.id, d.headcount]));
  const familyCapacities = new Map<string, number>();
  for (const fc of snapshot.familyCapacities) {
    familyCapacities.set(familyKeyOf(fc.departmentId, fc.familyId), fc.capacity);
  }
  const departmentCapacities = new Map(snapshot.departments.map((d) => [d.id, d.capacity]));

  const familyKeys: string[] = [];
  const departmentIds: string[] = [];
  const seenFamilies = new Set<string>();
  const seenDepartments = new Set<string>();
  for (const demand of snapshot.demands) {
    const key = familyKeyOf(demand.departmentId, demand.familyId);
    if (!seenFamilies.has(key)) {
      seenFamilies.add(key);
      familyKeys.push(key);
    }
    if (!seenDepartments.has(demand.departmentId)) {
      seenDepartments.add(demand.departmentId);
      departmentIds.push(demand.departmentId);
    }
  }

  const unlimited = snapshot.employees.length;
  const remainingFamilyCapacity = new Map<string, number>();
  const remainingDepartmentCapacity = new Map<string, number>();
  for (const key of familyKeys) {
    remainingFamilyCapacity.set(key, familyCapacities.get(key) ?? unlimited);
  }
  for (const id of departmentIds) {
    const capacity = departmentCapacities.get(id);
    if (capacity === undefined) {
      throw new Error(`需求项引用了未定义上限的部门: ${id}`);
    }
    remainingDepartmentCapacity.set(id, capacity);
  }

  for (const frozen of snapshot.frozenAssignments) {
    const demand = snapshot.demands.find((d) => d.id === frozen.demandId)!;
    decrement(remainingHeadcount, demand.id, `需求 ${demand.id} 的剩余人数`);
    const familyKey = familyKeyOf(demand.departmentId, demand.familyId);
    decrement(remainingFamilyCapacity, familyKey, `职族 ${familyKey} 的剩余额度`);
    decrement(remainingDepartmentCapacity, demand.departmentId, `部门 ${demand.departmentId} 的剩余额度`);
  }

  const candidatePairs: Model['candidatePairs'] = [];
  const seenPairs = new Set<string>();
  for (const candidate of snapshot.candidates) {
    if (frozenEmployees.has(candidate.employeeId)) continue;
    const key = pairKeyOf(candidate.employeeId, candidate.demandId);
    if (seenPairs.has(key)) {
      throw new Error(`重复的候选配对: ${key}`);
    }
    seenPairs.add(key);
    candidatePairs.push(candidate);
  }

  return {
    movableEmployeeIds,
    candidatePairs,
    currentDemandOf,
    demandPriority: new Map(snapshot.demands.map((d) => [d.id, d.priority])),
    remainingHeadcount,
    remainingFamilyCapacity,
    remainingDepartmentCapacity,
    familyKeys,
    departmentIds,
  };
}

function decrement(map: Map<string, number>, key: string, what: string): void {
  const next = map.get(key)! - 1;
  if (next < 0) throw new Error(`冻结分配超出${what}`);
  map.set(key, next);
}

function computeMetrics(snapshot: PlanningSnapshot, assignments: Assignment[]): PlanMetrics {
  const priorityOf = new Map(snapshot.demands.map((d) => [d.id, d.priority]));
  const scoreOf = new Map(
    snapshot.candidates.map((c) => [pairKeyOf(c.employeeId, c.demandId), c.score]),
  );
  const previous = new Map(snapshot.currentAssignments.map((a) => [a.employeeId, a.demandId]));
  const frozen = new Set(snapshot.frozenAssignments.map((a) => a.employeeId));

  const metrics: PlanMetrics = {
    highFilled: 0,
    mediumFilled: 0,
    lowFilled: 0,
    totalScore: 0,
    moves: 0,
  };
  const assignedTo = new Map<string, string>();
  for (const assignment of assignments) {
    assignedTo.set(assignment.employeeId, assignment.demandId);
    const priority = priorityOf.get(assignment.demandId)!;
    if (priority === 'high') metrics.highFilled += 1;
    else if (priority === 'medium') metrics.mediumFilled += 1;
    else metrics.lowFilled += 1;
    const score = scoreOf.get(pairKeyOf(assignment.employeeId, assignment.demandId));
    if (score === undefined) {
      throw new Error(`分配不在候选配对中: ${assignment.employeeId} -> ${assignment.demandId}`);
    }
    metrics.totalScore += score;
  }
  for (const [employeeId, demandId] of previous) {
    if (frozen.has(employeeId)) continue;
    if (assignedTo.get(employeeId) !== demandId) metrics.moves += 1;
  }
  return metrics;
}

function validateSnapshot(snapshot: PlanningSnapshot): void {
  const employeeIds = new Set<string>();
  for (const employee of snapshot.employees) {
    if (employeeIds.has(employee.id)) throw new Error(`重复的员工 id: ${employee.id}`);
    employeeIds.add(employee.id);
  }
  const demandIds = new Set<string>();
  for (const demand of snapshot.demands) {
    if (demandIds.has(demand.id)) throw new Error(`重复的需求项 id: ${demand.id}`);
    demandIds.add(demand.id);
    if (!Number.isInteger(demand.headcount) || demand.headcount < 0) {
      throw new Error(`需求 ${demand.id} 的需求人数必须是非负整数`);
    }
  }
  for (const candidate of snapshot.candidates) {
    if (!employeeIds.has(candidate.employeeId)) {
      throw new Error(`候选配对引用了不存在的员工: ${candidate.employeeId}`);
    }
    if (!demandIds.has(candidate.demandId)) {
      throw new Error(`候选配对引用了不存在的需求项: ${candidate.demandId}`);
    }
    if (
      !Number.isInteger(candidate.score) ||
      candidate.score < 0 ||
      candidate.score > 100
    ) {
      throw new Error(`匹配分必须是 0-100 的整数: ${candidate.employeeId} -> ${candidate.demandId}`);
    }
  }
  const currentKeys = new Set<string>();
  for (const assignment of snapshot.currentAssignments) {
    const key = pairKeyOf(assignment.employeeId, assignment.demandId);
    if (currentKeys.has(key)) throw new Error(`重复的当前分配: ${key}`);
    currentKeys.add(key);
    if (!employeeIds.has(assignment.employeeId) || !demandIds.has(assignment.demandId)) {
      throw new Error(`当前分配引用了不存在的员工或需求项: ${key}`);
    }
  }
  const frozenKeys = new Set<string>();
  for (const assignment of snapshot.frozenAssignments) {
    const key = pairKeyOf(assignment.employeeId, assignment.demandId);
    if (frozenKeys.has(key)) throw new Error(`重复的冻结分配: ${key}`);
    frozenKeys.add(key);
    if (!currentKeys.has(key)) {
      throw new Error(`冻结分配必须是当前分配的子集: ${key}`);
    }
  }
}
