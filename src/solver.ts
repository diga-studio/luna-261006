import { MinCostFlow } from './minCostFlow.js';
import type {
  AllocationPlan,
  Assignment,
  PlanningSnapshot,
  PlanStats,
  Priority,
} from './types.js';

const PRIORITY_ORDER: Priority[] = ['high', 'medium', 'low'];

/**
 * Generates a globally optimal allocation plan for the snapshot.
 *
 * Objectives are lexicographic: maximize filled high-priority headcount,
 * then medium, then low, then total match score, then minimize moves.
 * The snapshot is not mutated and the plan does not become the new
 * current assignment automatically.
 */
export function generatePlan(snapshot: PlanningSnapshot): AllocationPlan {
  validateSnapshot(snapshot);

  const employeeIndex = new Map(snapshot.employees.map((e, i) => [e.id, i]));
  const demandIndex = new Map(snapshot.demands.map((d, i) => [d.id, i]));

  const frozenPairs = new Set(snapshot.frozenAssignments.map(pairKey));
  const frozenEmployees = new Set(snapshot.frozenAssignments.map((a) => a.employeeId));

  // Residual capacities after removing frozen assignments, which are kept
  // as-is and consume demand headcount plus both quota layers as usual.
  const demandRemaining = snapshot.demands.map((d) => d.headcount);
  const familyRemaining = new Map<string, number>();
  const deptRemaining = new Map<string, number>();
  for (const quota of snapshot.departments) {
    deptRemaining.set(quota.departmentId, quota.maxTotal);
    for (const cap of quota.familyCaps) {
      familyRemaining.set(familyKey(quota.departmentId, cap.familyId), cap.max);
    }
  }
  for (const frozen of snapshot.frozenAssignments) {
    const demand = snapshot.demands[demandIndex.get(frozen.demandId)!]!;
    demandRemaining[demandIndex.get(frozen.demandId)!]! -= 1;
    deptRemaining.set(demand.departmentId, (deptRemaining.get(demand.departmentId) ?? 0) - 1);
    const fKey = familyKey(demand.departmentId, demand.familyId);
    familyRemaining.set(fKey, (familyRemaining.get(fKey) ?? 0) - 1);
  }

  // Lexicographic weights, exact in bigint. Each tier outweighs anything
  // the lower tiers could possibly contribute.
  const employeeCount = snapshot.employees.length;
  const moveWeight = 1n;
  const scoreWeight = BigInt(employeeCount + 1);
  const lowWeight = BigInt(employeeCount) * 100n * scoreWeight + BigInt(employeeCount) + 1n;
  const mediumWeight = BigInt(employeeCount + 1) * lowWeight;
  const highWeight = BigInt(employeeCount + 1) * mediumWeight;
  const priorityWeight: Record<Priority, bigint> = {
    high: highWeight,
    medium: mediumWeight,
    low: lowWeight,
  };

  // Graph layout: source, employees, demands, (dept, family) nodes, dept nodes, sink.
  const source = 0;
  const employeeBase = 1;
  const demandBase = employeeBase + snapshot.employees.length;
  const familyBase = demandBase + snapshot.demands.length;
  const familyNodeKeys: string[] = [];
  const familyNodeIndex = new Map<string, number>();
  for (const demand of snapshot.demands) {
    const key = familyKey(demand.departmentId, demand.familyId);
    if (!familyNodeIndex.has(key)) {
      familyNodeIndex.set(key, familyNodeKeys.length);
      familyNodeKeys.push(key);
    }
  }
  const deptBase = familyBase + familyNodeKeys.length;
  const deptNodeIndex = new Map<string, number>();
  const deptKeys: string[] = [];
  for (const demand of snapshot.demands) {
    if (!deptNodeIndex.has(demand.departmentId)) {
      deptNodeIndex.set(demand.departmentId, deptKeys.length);
      deptKeys.push(demand.departmentId);
    }
  }
  const sink = deptBase + deptKeys.length;

  const flow = new MinCostFlow(sink + 1);
  const infinite = Number.MAX_SAFE_INTEGER;

  // Current (adjustable) assignment per employee, for the stay-put bonus.
  const currentDemandOf = new Map<string, string>();
  for (const assignment of snapshot.currentAssignments) {
    if (!frozenPairs.has(pairKey(assignment))) {
      currentDemandOf.set(assignment.employeeId, assignment.demandId);
    }
  }

  for (const employee of snapshot.employees) {
    if (frozenEmployees.has(employee.id)) continue;
    flow.addEdge(source, employeeBase + employeeIndex.get(employee.id)!, 1, 0n);
  }

  // Candidate edges carry the negated objective benefit. Keeping one's
  // current demand earns a move discount; every currently assigned
  // employee contributes a constant baseline move, so employees who end
  // up elsewhere or unassigned are counted exactly once.
  const bestScore = new Map<string, number>();
  for (const candidate of snapshot.candidates) {
    const key = pairKey(candidate);
    bestScore.set(key, Math.max(bestScore.get(key) ?? -1, candidate.score));
  }
  const candidateHandles: { handle: number; employeeId: string; demandId: string }[] = [];
  for (const [key, score] of bestScore) {
    const [employeeId, demandId] = splitPairKey(key);
    if (frozenEmployees.has(employeeId)) continue;
    const eIdx = employeeIndex.get(employeeId);
    const dIdx = demandIndex.get(demandId);
    if (eIdx === undefined || dIdx === undefined) continue;
    const demand = snapshot.demands[dIdx]!;
    let benefit = priorityWeight[demand.priority] + BigInt(score) * scoreWeight;
    if (currentDemandOf.get(employeeId) === demandId) benefit += moveWeight;
    const handle = flow.addEdge(
      employeeBase + eIdx,
      demandBase + dIdx,
      1,
      -benefit,
    );
    candidateHandles.push({ handle, employeeId, demandId });
  }

  snapshot.demands.forEach((demand, i) => {
    const familyNode = familyBase + familyNodeIndex.get(familyKey(demand.departmentId, demand.familyId))!;
    flow.addEdge(demandBase + i, familyNode, Math.max(0, demandRemaining[i]!), 0n);
  });
  for (const [key, nodeIdx] of familyNodeIndex) {
    const deptId = key.slice(0, key.indexOf('::'));
    const deptNode = deptBase + deptNodeIndex.get(deptId)!;
    const cap = familyRemaining.get(key) ?? infinite;
    flow.addEdge(familyBase + nodeIdx, deptNode, Math.max(0, cap), 0n);
  }
  for (const [deptId, nodeIdx] of deptNodeIndex) {
    const cap = deptRemaining.get(deptId) ?? infinite;
    flow.addEdge(deptBase + nodeIdx, sink, Math.max(0, cap), 0n);
  }

  flow.minimizeCost(source, sink);

  const assignments: Assignment[] = snapshot.frozenAssignments.map((a) => ({ ...a }));
  for (const { handle, employeeId, demandId } of candidateHandles) {
    if (flow.flowOn(handle) === 1) assignments.push({ employeeId, demandId });
  }
  return { assignments };
}

/** Computes the lexicographic objective breakdown of a plan. */
export function evaluatePlan(snapshot: PlanningSnapshot, plan: AllocationPlan): PlanStats {
  const demandById = new Map(snapshot.demands.map((d) => [d.id, d]));
  const scoreByPair = new Map<string, number>();
  for (const candidate of snapshot.candidates) {
    const key = pairKey(candidate);
    scoreByPair.set(key, Math.max(scoreByPair.get(key) ?? -1, candidate.score));
  }

  const stats: PlanStats = { highFilled: 0, mediumFilled: 0, lowFilled: 0, totalScore: 0, moves: 0 };
  const plannedDemandOf = new Map<string, string>();
  for (const assignment of plan.assignments) {
    const demand = demandById.get(assignment.demandId);
    if (!demand) throw new Error(`plan references unknown demand ${assignment.demandId}`);
    const score = scoreByPair.get(pairKey(assignment));
    if (score === undefined) {
      throw new Error(`plan pairs ${assignment.employeeId} with ${assignment.demandId} without a candidate pair`);
    }
    if (demand.priority === 'high') stats.highFilled += 1;
    else if (demand.priority === 'medium') stats.mediumFilled += 1;
    else stats.lowFilled += 1;
    stats.totalScore += score;
    plannedDemandOf.set(assignment.employeeId, assignment.demandId);
  }
  for (const current of snapshot.currentAssignments) {
    if (plannedDemandOf.get(current.employeeId) !== current.demandId) stats.moves += 1;
  }
  return stats;
}

function validateSnapshot(snapshot: PlanningSnapshot): void {
  const employeeIds = new Set(snapshot.employees.map((e) => e.id));
  const demandIds = new Set(snapshot.demands.map((d) => d.id));
  const demandById = new Map(snapshot.demands.map((d) => [d.id, d]));
  for (const demand of snapshot.demands) {
    if (!Number.isInteger(demand.headcount) || demand.headcount < 0) {
      throw new Error(`demand ${demand.id} has invalid headcount ${demand.headcount}`);
    }
  }
  for (const candidate of snapshot.candidates) {
    if (!employeeIds.has(candidate.employeeId)) throw new Error(`candidate references unknown employee ${candidate.employeeId}`);
    if (!demandIds.has(candidate.demandId)) throw new Error(`candidate references unknown demand ${candidate.demandId}`);
    if (!Number.isInteger(candidate.score) || candidate.score < 0 || candidate.score > 100) {
      throw new Error(`candidate score must be an integer in [0, 100], got ${candidate.score}`);
    }
  }
  const currentKeys = new Set(snapshot.currentAssignments.map(pairKey));
  for (const frozen of snapshot.frozenAssignments) {
    if (!currentKeys.has(pairKey(frozen))) {
      throw new Error(`frozen assignment ${frozen.employeeId}->${frozen.demandId} is not a current assignment`);
    }
    const demand = demandById.get(frozen.demandId);
    if (!demand) throw new Error(`frozen assignment references unknown demand ${frozen.demandId}`);
  }
}

function pairKey(pair: { employeeId: string; demandId: string }): string {
  return `${pair.employeeId}::${pair.demandId}`;
}

function splitPairKey(key: string): [string, string] {
  const sep = key.indexOf('::');
  return [key.slice(0, sep), key.slice(sep + 2)];
}

function familyKey(departmentId: string, familyId: string): string {
  return `${departmentId}::${familyId}`;
}

export { PRIORITY_ORDER };
