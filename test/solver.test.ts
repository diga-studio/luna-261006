import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generatePlan,
  evaluatePlan,
  type AllocationPlan,
  type PlanningSnapshot,
  type PlanStats,
  type Priority,
} from '../src/index.js';

// ---------- helpers ----------

function makeSnapshot(overrides: Partial<PlanningSnapshot>): PlanningSnapshot {
  return {
    employees: [],
    demands: [],
    candidates: [],
    currentAssignments: [],
    frozenAssignments: [],
    departments: [],
    ...overrides,
  };
}

function assignmentOf(plan: AllocationPlan, employeeId: string): string | undefined {
  return plan.assignments.find((a) => a.employeeId === employeeId)?.demandId;
}

function assertFeasible(snapshot: PlanningSnapshot, plan: AllocationPlan): void {
  const candidateKeys = new Set(snapshot.candidates.map((c) => `${c.employeeId}::${c.demandId}`));
  const demandById = new Map(snapshot.demands.map((d) => [d.id, d]));
  const perEmployee = new Map<string, number>();
  const perDemand = new Map<string, number>();
  const perDept = new Map<string, number>();
  const perFamily = new Map<string, number>();
  for (const assignment of plan.assignments) {
    assert.ok(
      candidateKeys.has(`${assignment.employeeId}::${assignment.demandId}`),
      `assignment ${assignment.employeeId}->${assignment.demandId} is not a candidate pair`,
    );
    perEmployee.set(assignment.employeeId, (perEmployee.get(assignment.employeeId) ?? 0) + 1);
    perDemand.set(assignment.demandId, (perDemand.get(assignment.demandId) ?? 0) + 1);
    const demand = demandById.get(assignment.demandId)!;
    perDept.set(demand.departmentId, (perDept.get(demand.departmentId) ?? 0) + 1);
    const fKey = `${demand.departmentId}::${demand.familyId}`;
    perFamily.set(fKey, (perFamily.get(fKey) ?? 0) + 1);
  }
  for (const [employeeId, count] of perEmployee) {
    assert.ok(count <= 1, `employee ${employeeId} assigned ${count} times`);
  }
  for (const [demandId, count] of perDemand) {
    assert.ok(count <= demandById.get(demandId)!.headcount, `demand ${demandId} overfilled`);
  }
  for (const quota of snapshot.departments) {
    const used = perDept.get(quota.departmentId) ?? 0;
    assert.ok(used <= quota.maxTotal, `department ${quota.departmentId} over cap`);
    for (const cap of quota.familyCaps) {
      const familyUsed = perFamily.get(`${quota.departmentId}::${cap.familyId}`) ?? 0;
      assert.ok(familyUsed <= cap.max, `family ${cap.familyId} in ${quota.departmentId} over cap`);
    }
  }
  for (const frozen of snapshot.frozenAssignments) {
    assert.equal(assignmentOf(plan, frozen.employeeId), frozen.demandId, 'frozen assignment moved');
  }
}

/** Lexicographic comparison: positive means a is better. */
function compareStats(a: PlanStats, b: PlanStats): number {
  if (a.highFilled !== b.highFilled) return a.highFilled - b.highFilled;
  if (a.mediumFilled !== b.mediumFilled) return a.mediumFilled - b.mediumFilled;
  if (a.lowFilled !== b.lowFilled) return a.lowFilled - b.lowFilled;
  if (a.totalScore !== b.totalScore) return a.totalScore - b.totalScore;
  return b.moves - a.moves;
}

/** Exhaustive search for the optimal objective vector over all feasible plans. */
function bruteForceBest(snapshot: PlanningSnapshot): PlanStats {
  const frozenEmployees = new Set(snapshot.frozenAssignments.map((a) => a.employeeId));
  const adjustable = snapshot.employees.filter((e) => !frozenEmployees.has(e.id));
  const optionsByEmployee = adjustable.map((e) => [
    null as string | null,
    ...snapshot.candidates.filter((c) => c.employeeId === e.id).map((c) => c.demandId),
  ]);
  const demandById = new Map(snapshot.demands.map((d) => [d.id, d]));

  let best: PlanStats | null = null;
  const chosen: (string | null)[] = new Array(adjustable.length).fill(null);

  const visit = (i: number): void => {
    if (i === adjustable.length) {
      const assignments = [
        ...snapshot.frozenAssignments,
        ...chosen.flatMap((demandId, idx) =>
          demandId === null ? [] : [{ employeeId: adjustable[idx]!.id, demandId }],
        ),
      ];
      if (!isFeasible(assignments)) return;
      const stats = evaluatePlan(snapshot, { assignments });
      if (best === null || compareStats(stats, best) > 0) best = stats;
      return;
    }
    for (const option of optionsByEmployee[i]!) {
      chosen[i] = option;
      visit(i + 1);
    }
  };

  const isFeasible = (assignments: { employeeId: string; demandId: string }[]): boolean => {
    const perDemand = new Map<string, number>();
    const perDept = new Map<string, number>();
    const perFamily = new Map<string, number>();
    for (const a of assignments) {
      const demand = demandById.get(a.demandId)!;
      perDemand.set(a.demandId, (perDemand.get(a.demandId) ?? 0) + 1);
      perDept.set(demand.departmentId, (perDept.get(demand.departmentId) ?? 0) + 1);
      const fKey = `${demand.departmentId}::${demand.familyId}`;
      perFamily.set(fKey, (perFamily.get(fKey) ?? 0) + 1);
    }
    for (const [demandId, count] of perDemand) {
      if (count > demandById.get(demandId)!.headcount) return false;
    }
    for (const quota of snapshot.departments) {
      if ((perDept.get(quota.departmentId) ?? 0) > quota.maxTotal) return false;
      for (const cap of quota.familyCaps) {
        if ((perFamily.get(`${quota.departmentId}::${cap.familyId}`) ?? 0) > cap.max) return false;
      }
    }
    return true;
  };

  visit(0);
  return best!;
}

// ---------- scenario 1: multi-skill employee must yield to the unique candidate ----------

test('fills both demands even when the flexible employee scores higher on the contested one', () => {
  const snapshot = makeSnapshot({
    employees: [{ id: '甲' }, { id: '乙' }],
    demands: [
      { id: 'D1', departmentId: 'dept', familyId: 'fam', headcount: 1, priority: 'high' },
      { id: 'D2', departmentId: 'dept', familyId: 'fam', headcount: 1, priority: 'high' },
    ],
    candidates: [
      { employeeId: '甲', demandId: 'D1', score: 95 },
      { employeeId: '甲', demandId: 'D2', score: 60 },
      { employeeId: '乙', demandId: 'D1', score: 70 },
    ],
    departments: [{ departmentId: 'dept', maxTotal: 10, familyCaps: [{ familyId: 'fam', max: 10 }] }],
  });

  const plan = generatePlan(snapshot);
  assertFeasible(snapshot, plan);
  assert.equal(assignmentOf(plan, '甲'), 'D2');
  assert.equal(assignmentOf(plan, '乙'), 'D1');
  const stats = evaluatePlan(snapshot, plan);
  assert.deepEqual(stats, { highFilled: 2, mediumFilled: 0, lowFilled: 0, totalScore: 130, moves: 0 });
});

// ---------- scenario 2: quotas + frozen assignments ----------

test('frozen assignments stay put and dept/family caps block further filling', () => {
  const snapshot = makeSnapshot({
    employees: [{ id: 'e0' }, { id: 'e1' }, { id: 'e2' }, { id: 'e3' }],
    demands: [
      { id: 'X', departmentId: 'D1', familyId: 'F1', headcount: 1, priority: 'high' },
      { id: 'Y', departmentId: 'D1', familyId: 'F2', headcount: 1, priority: 'high' },
      { id: 'Z', departmentId: 'D2', familyId: 'F1', headcount: 1, priority: 'high' },
      { id: 'W', departmentId: 'D3', familyId: 'F3', headcount: 2, priority: 'medium' },
    ],
    candidates: [
      { employeeId: 'e0', demandId: 'X', score: 80 },
      { employeeId: 'e1', demandId: 'X', score: 90 },
      { employeeId: 'e1', demandId: 'Y', score: 85 },
      { employeeId: 'e2', demandId: 'Y', score: 88 },
      { employeeId: 'e2', demandId: 'Z', score: 70 },
      { employeeId: 'e3', demandId: 'Z', score: 65 },
      { employeeId: 'e3', demandId: 'W', score: 60 },
    ],
    currentAssignments: [{ employeeId: 'e0', demandId: 'X' }],
    frozenAssignments: [{ employeeId: 'e0', demandId: 'X' }],
    departments: [
      { departmentId: 'D1', maxTotal: 1, familyCaps: [{ familyId: 'F1', max: 1 }, { familyId: 'F2', max: 1 }] },
      { departmentId: 'D2', maxTotal: 5, familyCaps: [{ familyId: 'F1', max: 1 }] },
      { departmentId: 'D3', maxTotal: 5, familyCaps: [{ familyId: 'F3', max: 1 }] },
    ],
  });

  const plan = generatePlan(snapshot);
  assertFeasible(snapshot, plan);

  // Frozen person consumes X and D1's only slot: Y stays vacant despite candidates.
  assert.equal(assignmentOf(plan, 'e0'), 'X');
  assert.equal(assignmentOf(plan, 'e1'), undefined);
  assert.equal(assignmentOf(plan, 'e2'), 'Z');
  // Family cap on F3 in D3 allows only one of W's two headcounts.
  assert.equal(assignmentOf(plan, 'e3'), 'W');

  const stats = evaluatePlan(snapshot, plan);
  assert.deepEqual(stats, { highFilled: 2, mediumFilled: 1, lowFilled: 0, totalScore: 210, moves: 0 });
});

// ---------- snapshot immutability ----------

test('generatePlan does not mutate the snapshot', () => {
  const snapshot = makeSnapshot({
    employees: [{ id: 'e1' }, { id: 'e2' }],
    demands: [{ id: 'A', departmentId: 'D', familyId: 'F', headcount: 1, priority: 'low' }],
    candidates: [
      { employeeId: 'e1', demandId: 'A', score: 50 },
      { employeeId: 'e2', demandId: 'A', score: 90 },
    ],
    currentAssignments: [{ employeeId: 'e1', demandId: 'A' }],
  });
  const before = JSON.parse(JSON.stringify(snapshot));
  const plan = generatePlan(snapshot);
  assert.deepEqual(snapshot, before);
  // Higher score wins when fill counts tie.
  assert.equal(assignmentOf(plan, 'e2'), 'A');
  assert.equal(evaluatePlan(snapshot, plan).moves, 1);
});

// ---------- move minimization ----------

test('prefers keeping current assignments when other objectives tie', () => {
  const snapshot = makeSnapshot({
    employees: [{ id: 'e1' }, { id: 'e2' }],
    demands: [
      { id: 'A', departmentId: 'D', familyId: 'F', headcount: 1, priority: 'medium' },
      { id: 'B', departmentId: 'D', familyId: 'F', headcount: 1, priority: 'medium' },
    ],
    candidates: [
      { employeeId: 'e1', demandId: 'A', score: 50 },
      { employeeId: 'e1', demandId: 'B', score: 50 },
      { employeeId: 'e2', demandId: 'A', score: 50 },
      { employeeId: 'e2', demandId: 'B', score: 50 },
    ],
    currentAssignments: [{ employeeId: 'e1', demandId: 'A' }],
    departments: [{ departmentId: 'D', maxTotal: 2, familyCaps: [{ familyId: 'F', max: 2 }] }],
  });
  const plan = generatePlan(snapshot);
  assertFeasible(snapshot, plan);
  assert.equal(evaluatePlan(snapshot, plan).moves, 0);
  assert.equal(assignmentOf(plan, 'e1'), 'A');
});

// ---------- brute-force cross-check on randomized small instances ----------

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomSnapshot(rand: () => number): PlanningSnapshot {
  const pick = <T>(items: T[]): T => items[Math.floor(rand() * items.length)]!;
  const employeeCount = 2 + Math.floor(rand() * 3);
  const demandCount = 2 + Math.floor(rand() * 3);
  const deptIds = ['D1', 'D2'];
  const familyIds = ['F1', 'F2'];
  const priorities: Priority[] = ['high', 'medium', 'low'];

  const employees = Array.from({ length: employeeCount }, (_, i) => ({ id: `e${i}` }));
  const demands = Array.from({ length: demandCount }, (_, i) => ({
    id: `d${i}`,
    departmentId: pick(deptIds),
    familyId: pick(familyIds),
    headcount: 1 + Math.floor(rand() * 2),
    priority: pick(priorities),
  }));
  const candidates = employees.flatMap((e) =>
    demands
      .filter(() => rand() < 0.6)
      .map((d) => ({ employeeId: e.id, demandId: d.id, score: Math.floor(rand() * 101) })),
  );
  const departments = deptIds.map((deptId) => ({
    departmentId: deptId,
    maxTotal: 1 + Math.floor(rand() * 3),
    familyCaps: familyIds.map((familyId) => ({ familyId, max: 1 + Math.floor(rand() * 2) })),
  }));

  // Build a feasible current assignment greedily, then freeze a subset.
  const currentAssignments: { employeeId: string; demandId: string }[] = [];
  const usedEmployees = new Set<string>();
  const demandLoad = new Map<string, number>();
  const deptLoad = new Map<string, number>();
  const familyLoad = new Map<string, number>();
  for (const candidate of [...candidates].sort(() => rand() - 0.5)) {
    if (usedEmployees.has(candidate.employeeId)) continue;
    if (rand() < 0.4) continue;
    const demand = demands.find((d) => d.id === candidate.demandId)!;
    if ((demandLoad.get(demand.id) ?? 0) >= demand.headcount) continue;
    const quota = departments.find((q) => q.departmentId === demand.departmentId)!;
    if ((deptLoad.get(demand.departmentId) ?? 0) >= quota.maxTotal) continue;
    const fKey = `${demand.departmentId}::${demand.familyId}`;
    const fCap = quota.familyCaps.find((c) => c.familyId === demand.familyId)!;
    if ((familyLoad.get(fKey) ?? 0) >= fCap.max) continue;
    currentAssignments.push({ employeeId: candidate.employeeId, demandId: candidate.demandId });
    usedEmployees.add(candidate.employeeId);
    demandLoad.set(demand.id, (demandLoad.get(demand.id) ?? 0) + 1);
    deptLoad.set(demand.departmentId, (deptLoad.get(demand.departmentId) ?? 0) + 1);
    familyLoad.set(fKey, (familyLoad.get(fKey) ?? 0) + 1);
  }
  const frozenAssignments = currentAssignments.filter(() => rand() < 0.5);
  return makeSnapshot({ employees, demands, candidates, currentAssignments, frozenAssignments, departments });
}

test('moving to a different demand counts as one move', () => {
  const snapshot = makeSnapshot({
    employees: [{ id: 'e1' }],
    demands: [
      { id: 'A', departmentId: 'D', familyId: 'F', headcount: 1, priority: 'low' },
      { id: 'B', departmentId: 'D', familyId: 'F', headcount: 1, priority: 'high' },
    ],
    candidates: [
      { employeeId: 'e1', demandId: 'A', score: 90 },
      { employeeId: 'e1', demandId: 'B', score: 10 },
    ],
    currentAssignments: [{ employeeId: 'e1', demandId: 'A' }],
    departments: [{ departmentId: 'D', maxTotal: 1, familyCaps: [{ familyId: 'F', max: 1 }] }],
  });
  const plan = generatePlan(snapshot);
  assertFeasible(snapshot, plan);
  // High priority outranks everything: e1 must move to B despite the score drop.
  assert.equal(assignmentOf(plan, 'e1'), 'B');
  assert.deepEqual(evaluatePlan(snapshot, plan), {
    highFilled: 1,
    mediumFilled: 0,
    lowFilled: 0,
    totalScore: 10,
    moves: 1,
  });
});

test('becoming unassigned counts as a move', () => {
  const snapshot = makeSnapshot({
    employees: [{ id: 'e1' }, { id: 'e2' }],
    demands: [
      { id: 'A', departmentId: 'D', familyId: 'F', headcount: 1, priority: 'low' },
      { id: 'B', departmentId: 'D', familyId: 'F', headcount: 1, priority: 'high' },
    ],
    candidates: [
      { employeeId: 'e1', demandId: 'A', score: 90 },
      { employeeId: 'e2', demandId: 'B', score: 10 },
    ],
    currentAssignments: [{ employeeId: 'e1', demandId: 'A' }],
    departments: [{ departmentId: 'D', maxTotal: 1, familyCaps: [{ familyId: 'F', max: 1 }] }],
  });
  const plan = generatePlan(snapshot);
  assertFeasible(snapshot, plan);
  // Department cap 1: filling high-priority B forces e1 out.
  assert.equal(assignmentOf(plan, 'e1'), undefined);
  assert.equal(assignmentOf(plan, 'e2'), 'B');
  assert.deepEqual(evaluatePlan(snapshot, plan), {
    highFilled: 1,
    mediumFilled: 0,
    lowFilled: 0,
    totalScore: 10,
    moves: 1,
  });
});

test('matches brute-force optimum on randomized small snapshots', () => {
  const rand = lcg(20261006);
  for (let i = 0; i < 300; i++) {
    const snapshot = randomSnapshot(rand);
    const plan = generatePlan(snapshot);
    assertFeasible(snapshot, plan);
    const actual = evaluatePlan(snapshot, plan);
    const optimal = bruteForceBest(snapshot);
    assert.equal(
      compareStats(actual, optimal),
      0,
      `case ${i}: got ${JSON.stringify(actual)}, optimal ${JSON.stringify(optimal)}`,
    );
  }
});
