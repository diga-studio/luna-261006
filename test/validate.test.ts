import test from 'node:test';
import assert from 'node:assert/strict';
import { planMaintenance, type Device, type PlantInput } from '../src/index.js';

const validDevice: Device = {
  id: 'A',
  windowStart: 0,
  windowEnd: 24,
  duration: 2,
  resourceIds: ['R1'],
};

function expectThrow(input: PlantInput, pattern: RegExp): void {
  assert.throws(() => planMaintenance(input), pattern);
}

test('设备编号重复被拒绝', () => {
  expectThrow(
    { devices: [validDevice, { ...validDevice }], candidateSlots: [0] },
    /duplicate device id/,
  );
});

test('可检修区间超过 48 小时被拒绝', () => {
  expectThrow(
    { devices: [{ ...validDevice, windowEnd: 49 }], candidateSlots: [0] },
    /longer than 48/,
  );
});

test('检修时长超出 1~8 小时被拒绝', () => {
  expectThrow(
    { devices: [{ ...validDevice, duration: 0 }], candidateSlots: [0] },
    /duration/,
  );
  expectThrow(
    { devices: [{ ...validDevice, duration: 9 }], candidateSlots: [0] },
    /duration/,
  );
});

test('非整点时刻被拒绝', () => {
  expectThrow(
    { devices: [{ ...validDevice, windowStart: 0.5 }], candidateSlots: [0] },
    /integers/,
  );
  expectThrow(
    { devices: [validDevice], candidateSlots: [1.5] },
    /integers/,
  );
});

test('候选时点间距小于 8 小时被拒绝', () => {
  expectThrow(
    { devices: [validDevice], candidateSlots: [0, 7] },
    /closer than 8/,
  );
  expectThrow(
    { devices: [validDevice], candidateSlots: [0, 0] },
    /duplicate candidate slot/,
  );
});

test('超过规模上限被拒绝', () => {
  const many = Array.from({ length: 19 }, (_, i) => ({ ...validDevice, id: `D${i}` }));
  expectThrow({ devices: many, candidateSlots: [0] }, /too many devices/);
  const manySlots = Array.from({ length: 11 }, (_, i) => i * 8);
  expectThrow({ devices: [validDevice], candidateSlots: manySlots }, /too many candidate slots/);
  const manyResources = Array.from({ length: 9 }, (_, i) => `R${i}`);
  expectThrow(
    { devices: [{ ...validDevice, resourceIds: manyResources }], candidateSlots: [0] },
    /too many resources/,
  );
});

test('空设备列表返回可行的空计划', () => {
  const result = planMaintenance({ devices: [], candidateSlots: [0, 8] });
  assert.equal(result.feasible, true);
  assert.equal(result.groups.length, 0);
  assert.equal(result.totalCost, 0);
});
