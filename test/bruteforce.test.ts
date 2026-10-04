import assert from 'node:assert/strict';
import test from 'node:test';
import { solveSnapshot, type PlanningSnapshot, type Priority } from '../src/index.js';
import {
  bruteForceBestMetrics,
  compareMetrics,
  feasibilityErrors,
  metricsOf,
} from './helpers.js';

/** 可复现的伪随机数生成器。 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomSnapshot(rand: () => number): PlanningSnapshot {
  const pick = <T>(items: T[]): T => items[Math.floor(rand() * items.length)];
  const int = (max: number): number => Math.floor(rand() * (max + 1));

  const departmentIds = ['部门A', '部门B'];
  const familyIds = ['职族X', '职族Y'];
  const priorities: Priority[] = ['high', 'medium', 'low'];

  const demandCount = 1 + int(3);
  const demands = Array.from({ length: demandCount }, (_, i) => ({
    id: `需求${i}`,
    departmentId: pick(departmentIds),
    familyId: pick(familyIds),
    headcount: int(2),
    priority: pick(priorities),
  }));
  const employeeCount = 1 + int(5);
  const employees = Array.from({ length: employeeCount }, (_, i) => ({ id: `员工${i}` }));

  const candidates = employees.flatMap((employee) =>
    demands
      .filter(() => rand() < 0.6)
      .map((demand) => ({
        employeeId: employee.id,
        demandId: demand.id,
        score: int(100),
      })),
  );

  const departments = departmentIds.map((id) => ({ id, capacity: int(3) }));
  const familyCapacities = departmentIds.flatMap((departmentId) =>
    familyIds
      .filter(() => rand() < 0.8)
      .map((familyId) => ({ departmentId, familyId, capacity: int(3) })),
  );

  // 构造一个保证可行的当前分配：贪心地在剩余额度内安排。
  const headcountUsed = new Map<string, number>();
  const familyUsed = new Map<string, number>();
  const departmentUsed = new Map<string, number>();
  const familyCapOf = new Map(
    familyCapacities.map((fc) => [`${fc.departmentId}|${fc.familyId}`, fc.capacity]),
  );
  const deptCapOf = new Map(departments.map((d) => [d.id, d.capacity]));
  const currentAssignments: PlanningSnapshot['currentAssignments'] = [];
  for (const employee of [...employees].sort(() => rand() - 0.5)) {
    const options = candidates.filter((c) => c.employeeId === employee.id);
    for (const option of options.sort(() => rand() - 0.5)) {
      const demand = demands.find((d) => d.id === option.demandId)!;
      const familyKey = `${demand.departmentId}|${demand.familyId}`;
      const familyCap = familyCapOf.get(familyKey) ?? Number.MAX_SAFE_INTEGER;
      if ((headcountUsed.get(demand.id) ?? 0) >= demand.headcount) continue;
      if ((familyUsed.get(familyKey) ?? 0) >= familyCap) continue;
      if ((departmentUsed.get(demand.departmentId) ?? 0) >= deptCapOf.get(demand.departmentId)!) {
        continue;
      }
      currentAssignments.push({ employeeId: employee.id, demandId: demand.id });
      headcountUsed.set(demand.id, (headcountUsed.get(demand.id) ?? 0) + 1);
      familyUsed.set(familyKey, (familyUsed.get(familyKey) ?? 0) + 1);
      departmentUsed.set(
        demand.departmentId,
        (departmentUsed.get(demand.departmentId) ?? 0) + 1,
      );
      break;
    }
  }
  const frozenAssignments = currentAssignments.filter(() => rand() < 0.4);

  return {
    employees,
    demands,
    candidates,
    departments,
    familyCapacities,
    currentAssignments,
    frozenAssignments,
  };
}

test('随机小规模案例：求解结果与暴力枚举的字典序最优值一致', () => {
  const caseCount = 300;
  for (let seed = 1; seed <= caseCount; seed++) {
    const snapshot = randomSnapshot(makeRandom(seed));
    const before = JSON.stringify(snapshot);

    const plan = solveSnapshot(snapshot);

    assert.deepEqual(
      feasibilityErrors(snapshot, plan.assignments),
      [],
      `seed=${seed} 方案不可行`,
    );
    assert.deepEqual(
      plan.metrics,
      metricsOf(snapshot, plan.assignments),
      `seed=${seed} 指标与方案不一致`,
    );
    const best = bruteForceBestMetrics(snapshot);
    assert.equal(
      compareMetrics(plan.metrics, best),
      0,
      `seed=${seed} 未达到最优: 得到 ${JSON.stringify(plan.metrics)}, 期望 ${JSON.stringify(best)}`,
    );
    assert.equal(JSON.stringify(snapshot), before, `seed=${seed} 快照被修改`);
  }
});
