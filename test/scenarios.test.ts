import assert from 'node:assert/strict';
import test from 'node:test';
import { solveSnapshot, type PlanningSnapshot } from '../src/index.js';
import {
  bruteForceBestMetrics,
  compareMetrics,
  feasibilityErrors,
  metricsOf,
} from './helpers.js';

test('多技能员工让位：甲去第二处、乙去第一处，两处都补满', () => {
  const snapshot: PlanningSnapshot = {
    employees: [{ id: '甲' }, { id: '乙' }],
    demands: [
      { id: '需求一', departmentId: '部门A', familyId: '职族X', headcount: 1, priority: 'high' },
      { id: '需求二', departmentId: '部门A', familyId: '职族X', headcount: 1, priority: 'high' },
    ],
    candidates: [
      { employeeId: '甲', demandId: '需求一', score: 95 },
      { employeeId: '甲', demandId: '需求二', score: 60 },
      { employeeId: '乙', demandId: '需求一', score: 80 },
    ],
    departments: [{ id: '部门A', capacity: 10 }],
    familyCapacities: [{ departmentId: '部门A', familyId: '职族X', capacity: 10 }],
    currentAssignments: [],
    frozenAssignments: [],
  };

  const plan = solveSnapshot(snapshot);
  assert.deepEqual(feasibilityErrors(snapshot, plan.assignments), []);

  const assignedTo = new Map(plan.assignments.map((a) => [a.employeeId, a.demandId]));
  assert.equal(assignedTo.get('甲'), '需求二');
  assert.equal(assignedTo.get('乙'), '需求一');

  // 独立核算全部目标的最优值。
  const best = bruteForceBestMetrics(snapshot);
  assert.deepEqual(best, {
    highFilled: 2,
    mediumFilled: 0,
    lowFilled: 0,
    totalScore: 140,
    moves: 0,
  });
  assert.equal(compareMetrics(plan.metrics, best), 0);
  assert.deepEqual(plan.metrics, metricsOf(snapshot, plan.assignments));
});

test('部门与职族额度争用 + 冻结分配：冻结不动、额度不突破', () => {
  // 部门A 总额度 2，职族X 额度 1；冻结占用 需求一 的 1 人（已占满职族X 与部门A 各 1 额度）。
  // 需求二（高职族X）因职族X 已满无法再补人；需求三（中职族Y）还能补 1 人。
  const snapshot: PlanningSnapshot = {
    employees: [{ id: '冻结员' }, { id: '员工一' }, { id: '员工二' }],
    demands: [
      { id: '需求一', departmentId: '部门A', familyId: '职族X', headcount: 1, priority: 'high' },
      { id: '需求二', departmentId: '部门A', familyId: '职族X', headcount: 1, priority: 'high' },
      { id: '需求三', departmentId: '部门A', familyId: '职族Y', headcount: 1, priority: 'medium' },
    ],
    candidates: [
      { employeeId: '冻结员', demandId: '需求一', score: 70 },
      { employeeId: '员工一', demandId: '需求二', score: 90 },
      { employeeId: '员工一', demandId: '需求三', score: 50 },
      { employeeId: '员工二', demandId: '需求二', score: 85 },
      { employeeId: '员工二', demandId: '需求三', score: 55 },
    ],
    departments: [{ id: '部门A', capacity: 2 }],
    familyCapacities: [
      { departmentId: '部门A', familyId: '职族X', capacity: 1 },
      { departmentId: '部门A', familyId: '职族Y', capacity: 1 },
    ],
    currentAssignments: [{ employeeId: '冻结员', demandId: '需求一' }],
    frozenAssignments: [{ employeeId: '冻结员', demandId: '需求一' }],
  };

  const plan = solveSnapshot(snapshot);
  assert.deepEqual(feasibilityErrors(snapshot, plan.assignments), []);

  // 冻结人员保持原位。
  const assignedTo = new Map(plan.assignments.map((a) => [a.employeeId, a.demandId]));
  assert.equal(assignedTo.get('冻结员'), '需求一');
  // 职族X 额度被冻结占满，需求二不能再补人；两名员工都去争需求三，只有 1 人能去。
  assert.equal(assignedTo.has('员工一') && assignedTo.get('员工一') === '需求二', false);
  assert.equal(assignedTo.has('员工二') && assignedTo.get('员工二') === '需求二', false);
  const filledThree =
    (assignedTo.get('员工一') === '需求三' ? 1 : 0) +
    (assignedTo.get('员工二') === '需求三' ? 1 : 0);
  assert.equal(filledThree, 1);

  // 独立核算全部目标的最优值：高 1（冻结）、中 1、低 0；需求三补分更高者（员工二，55 分）。
  const best = bruteForceBestMetrics(snapshot);
  assert.deepEqual(best, {
    highFilled: 1,
    mediumFilled: 1,
    lowFilled: 0,
    totalScore: 125,
    moves: 0,
  });
  assert.equal(compareMetrics(plan.metrics, best), 0);
  assert.deepEqual(plan.metrics, metricsOf(snapshot, plan.assignments));
});

test('生成方案不修改输入快照', () => {
  const snapshot: PlanningSnapshot = {
    employees: [{ id: '甲' }],
    demands: [
      { id: '需求一', departmentId: '部门A', familyId: '职族X', headcount: 1, priority: 'low' },
    ],
    candidates: [{ employeeId: '甲', demandId: '需求一', score: 10 }],
    departments: [{ id: '部门A', capacity: 1 }],
    familyCapacities: [],
    currentAssignments: [],
    frozenAssignments: [],
  };
  const before = JSON.stringify(snapshot);
  solveSnapshot(snapshot);
  assert.equal(JSON.stringify(snapshot), before);
});
