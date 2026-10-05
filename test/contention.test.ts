import test from 'node:test';
import assert from 'node:assert/strict';
import { planMaintenance, COST_PER_HOUR, type Device } from '../src/index.js';
import { assertPlanValid, bruteForceMinDowntime, shuffled } from './helpers.js';

/**
 * 场景：多个维护组争用候选时点。
 * C 只能在时点 0 检修（窗口 [0,3]，时长 3）。
 * A、B 若单独在时点 0 合并（局部最省：2 小时），C 将无处可去，
 * 只能退而求其次总耗时 5 小时；全局最优是三台同组，共 3 小时。
 */
const devices: Device[] = [
  { id: 'A', windowStart: 0, windowEnd: 20, duration: 1, resourceIds: ['R1'] },
  { id: 'B', windowStart: 0, windowEnd: 20, duration: 2, resourceIds: ['R1'] },
  { id: 'C', windowStart: 0, windowEnd: 3, duration: 3, resourceIds: ['R1'] },
];
const slots = [0, 8];

test('争用候选时点时返回全局最优而非局部最省', () => {
  const result = planMaintenance({ devices, candidateSlots: slots });
  assertPlanValid(result, devices, slots);
  // 全局最优：{A,B,C} 在时点 0，停机 3 小时。
  assert.equal(result.totalDowntimeHours, 3);
  assert.equal(result.totalCost, 3 * COST_PER_HOUR);
  assert.equal(result.groups.length, 1);
});

test('返回费用与独立暴力核验的全局最优一致', () => {
  const cases: Array<{ devices: Device[]; slots: number[] }> = [
    { devices, slots },
    {
      // 更复杂的争用：5 台设备、3 个时点、资源两种。
      devices: [
        { id: 'D1', windowStart: 0, windowEnd: 30, duration: 4, resourceIds: ['R1', 'R2'] },
        { id: 'D2', windowStart: 0, windowEnd: 30, duration: 2, resourceIds: ['R1'] },
        { id: 'D3', windowStart: 0, windowEnd: 30, duration: 3, resourceIds: ['R1', 'R2'] },
        { id: 'D4', windowStart: 0, windowEnd: 9, duration: 5, resourceIds: ['R2'] },
        { id: 'D5', windowStart: 8, windowEnd: 30, duration: 1, resourceIds: ['R1'] },
        { id: 'D6', windowStart: 16, windowEnd: 24, duration: 6, resourceIds: ['R2'] },
      ],
      slots: [0, 8, 16],
    },
    {
      // 不可行：设备窗口都只在时点 0，4 台设备超过单组上限。
      devices: [1, 2, 3, 4].map((i) => ({
        id: `N${i}`,
        windowStart: 0,
        windowEnd: 4,
        duration: 2,
        resourceIds: ['R1'],
      })),
      slots: [0, 8],
    },
  ];
  for (const { devices: ds, slots: ss } of cases) {
    const result = planMaintenance({ devices: ds, candidateSlots: ss });
    const optimum = bruteForceMinDowntime(ds, ss);
    if (optimum === null) {
      assert.equal(result.feasible, false);
    } else {
      assertPlanValid(result, ds, ss);
      assert.equal(result.totalDowntimeHours, optimum);
    }
  }
});

test('设备与时点输入顺序不影响最优费用与可行性', () => {
  const ds: Device[] = [
    { id: 'D1', windowStart: 0, windowEnd: 30, duration: 4, resourceIds: ['R1', 'R2'] },
    { id: 'D2', windowStart: 0, windowEnd: 30, duration: 2, resourceIds: ['R1'] },
    { id: 'D3', windowStart: 0, windowEnd: 30, duration: 3, resourceIds: ['R1', 'R2'] },
    { id: 'D4', windowStart: 0, windowEnd: 9, duration: 5, resourceIds: ['R2'] },
    { id: 'D5', windowStart: 8, windowEnd: 30, duration: 1, resourceIds: ['R1'] },
    { id: 'D6', windowStart: 16, windowEnd: 24, duration: 6, resourceIds: ['R2'] },
  ];
  const ss = [0, 8, 16];
  const base = planMaintenance({ devices: ds, candidateSlots: ss });
  for (const seed of [1, 7, 42, 2024]) {
    const result = planMaintenance({
      devices: shuffled(ds, seed),
      candidateSlots: shuffled(ss, seed + 1),
    });
    assert.equal(result.feasible, base.feasible);
    assert.equal(result.totalCost, base.totalCost);
  }
});
