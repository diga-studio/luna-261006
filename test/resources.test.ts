import test from 'node:test';
import assert from 'node:assert/strict';
import { planMaintenance, COST_PER_HOUR, type Device } from '../src/index.js';
import { assertPlanValid } from './helpers.js';

test('两两有共用资源但三者无共同资源，不能合成三台一组', () => {
  // AB 共用 R1，BC 共用 R2，AC 共用 R3，但 {A,B,C} 没有共同资源。
  const devices: Device[] = [
    { id: 'A', windowStart: 0, windowEnd: 40, duration: 2, resourceIds: ['R1', 'R3'] },
    { id: 'B', windowStart: 0, windowEnd: 40, duration: 2, resourceIds: ['R1', 'R2'] },
    { id: 'C', windowStart: 0, windowEnd: 40, duration: 2, resourceIds: ['R2', 'R3'] },
  ];
  const slots = [0, 8];
  const result = planMaintenance({ devices, candidateSlots: slots });
  assertPlanValid(result, devices, slots);
  // 最优：一个两人组 + 一个单人组，共 4 小时；若能三台同组则只需 2 小时。
  assert.equal(result.totalDowntimeHours, 4);
  assert.equal(result.totalCost, 4 * COST_PER_HOUR);
  assert.equal(result.groups.length, 2);
  for (const group of result.groups) {
    assert.ok(group.deviceIds.length <= 2, '三人组不应出现');
  }
});

test('检修恰好在区间上界完成是合法的', () => {
  const devices: Device[] = [
    { id: 'A', windowStart: 0, windowEnd: 10, duration: 2, resourceIds: ['R1'] },
  ];
  // 时点 8 开始，10 完成，完成时刻等于上界。
  const result = planMaintenance({ devices, candidateSlots: [8] });
  assertPlanValid(result, devices, [8]);
  assert.equal(result.groups[0]!.start, 8);
  assert.equal(result.totalDowntimeHours, 2);
});

test('超出区间上界 1 小时的安排不可用', () => {
  const devices: Device[] = [
    { id: 'A', windowStart: 0, windowEnd: 10, duration: 3, resourceIds: ['R1'] },
  ];
  // 时点 8 开始则 11 完成，超出上界 1 小时；无其他时点 → 不可行。
  const result = planMaintenance({ devices, candidateSlots: [8] });
  assert.equal(result.feasible, false);
  assert.equal(result.groups.length, 0);
});

test('开始时刻早于区间下界不可用', () => {
  const devices: Device[] = [
    { id: 'A', windowStart: 10, windowEnd: 20, duration: 2, resourceIds: ['R1'] },
  ];
  const result = planMaintenance({ devices, candidateSlots: [0] });
  assert.equal(result.feasible, false);
});

test('不同维护组可以重复使用同一个资源', () => {
  const devices: Device[] = [
    { id: 'A', windowStart: 0, windowEnd: 40, duration: 4, resourceIds: ['R1'] },
    { id: 'B', windowStart: 0, windowEnd: 40, duration: 4, resourceIds: ['R1'] },
    { id: 'C', windowStart: 0, windowEnd: 40, duration: 4, resourceIds: ['R1'] },
    { id: 'D', windowStart: 0, windowEnd: 40, duration: 4, resourceIds: ['R1'] },
  ];
  const slots = [0, 8];
  const result = planMaintenance({ devices, candidateSlots: slots });
  assertPlanValid(result, devices, slots);
  // 4 台设备、2 个时点：两个两人组，都用 R1。
  assert.equal(result.groups.length, 2);
  assert.ok(result.groups.every((g) => g.resourceId === 'R1'));
  assert.equal(result.totalDowntimeHours, 8);
});
