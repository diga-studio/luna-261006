import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reallocateSeats } from '../src/index.js';
import type { Device, LicensePool } from '../src/index.js';

const pool = (
  poolId: string,
  totalSeats: number,
  allowedDepartments: string[],
  expiresOn = '2099-12-31',
): LicensePool => ({ poolId, totalSeats, expiresOn, allowedDepartments });

const device = (
  deviceId: string,
  department: string,
  previousPoolId?: string,
): Device => ({ deviceId, department, previousPoolId });

test('重叠许可池：为覆盖最大化主动迁移旧绑定，不产生虚假缺口', () => {
  // 池A 支持甲、乙两部门（1席），池B 仅支持甲（1席）。
  // 甲部门设备原占池A，乙部门设备新加入：
  // 必须迁移甲设备到池B，让乙设备使用池A，两台都覆盖。
  const result = reallocateSeats(
    [device('dev-jia', '甲', 'pool-A'), device('dev-yi', '乙')],
    [pool('pool-A', 1, ['甲', '乙']), pool('pool-B', 1, ['甲'])],
    '2026-10-05',
  );

  assert.equal(result.coveredCount, 2);
  assert.deepEqual(result.uncoveredDeviceIds, []);
  const binding = new Map(result.assignments.map((a) => [a.deviceId, a.poolId]));
  assert.equal(binding.get('dev-yi'), 'pool-A');
  assert.equal(binding.get('dev-jia'), 'pool-B');
  assert.equal(result.preservedCount, 0);
});

test('覆盖数相同则优先保留原绑定', () => {
  const result = reallocateSeats(
    [device('dev-1', '甲', 'pool-A'), device('dev-2', '甲')],
    [pool('pool-A', 1, ['甲']), pool('pool-B', 1, ['甲'])],
    '2026-10-05',
  );

  assert.equal(result.coveredCount, 2);
  assert.equal(result.preservedCount, 1);
  const binding = new Map(result.assignments.map((a) => [a.deviceId, a.poolId]));
  assert.equal(binding.get('dev-1'), 'pool-A');
});

test('池缩容后部分旧绑定必须让位，覆盖数仍为最优', () => {
  // pool-A 从 2 席缩到 1 席，两台设备原都绑在 pool-A：
  // 一台保留，另一台必须迁到 pool-B，不能整批卡在 pool-A 上。
  const result = reallocateSeats(
    [device('dev-1', '甲', 'pool-A'), device('dev-2', '甲', 'pool-A')],
    [pool('pool-A', 1, ['甲']), pool('pool-B', 1, ['甲'])],
    '2026-10-05',
  );

  assert.equal(result.coveredCount, 2);
  assert.equal(result.preservedCount, 1);
  const perPool = new Map<string, number>();
  for (const a of result.assignments) {
    perPool.set(a.poolId, (perPool.get(a.poolId) ?? 0) + 1);
  }
  assert.equal(perPool.get('pool-A'), 1);
  assert.equal(perPool.get('pool-B'), 1);
});

test('席位不足时返回最优部分覆盖而非整批失败', () => {
  const result = reallocateSeats(
    [device('dev-1', '甲'), device('dev-2', '甲'), device('dev-3', '甲')],
    [pool('pool-A', 2, ['甲'])],
    '2026-10-05',
  );

  assert.equal(result.coveredCount, 2);
  assert.equal(result.uncoveredDeviceIds.length, 1);
  assert.equal(result.assignments.length, 2);
});

test('到期日当天仍有效，早于核算日的池不能分配', () => {
  const result = reallocateSeats(
    [device('dev-1', '甲'), device('dev-2', '甲')],
    [
      pool('pool-expired', 1, ['甲'], '2026-10-04'),
      pool('pool-today', 1, ['甲'], '2026-10-05'),
    ],
    '2026-10-05',
  );

  assert.equal(result.coveredCount, 1);
  assert.equal(result.assignments[0].poolId, 'pool-today');
  assert.equal(result.uncoveredDeviceIds.length, 1);
});

test('原绑定因到期失效后重新分配并正确统计保留数', () => {
  const result = reallocateSeats(
    [device('dev-1', '甲', 'pool-old'), device('dev-2', '甲', 'pool-new')],
    [pool('pool-old', 1, ['甲'], '2026-01-01'), pool('pool-new', 2, ['甲'])],
    '2026-10-05',
  );

  assert.equal(result.coveredCount, 2);
  assert.equal(result.preservedCount, 1);
  const binding = new Map(result.assignments.map((a) => [a.deviceId, a.poolId]));
  assert.equal(binding.get('dev-1'), 'pool-new');
  assert.equal(binding.get('dev-2'), 'pool-new');
});

test('部门不在池覆盖范围内的设备不能绑定该池', () => {
  const result = reallocateSeats(
    [device('dev-1', '丙')],
    [pool('pool-A', 5, ['甲', '乙'])],
    '2026-10-05',
  );

  assert.equal(result.coveredCount, 0);
  assert.deepEqual(result.uncoveredDeviceIds, ['dev-1']);
});

test('原先无绑定的设备不计入保留数', () => {
  const result = reallocateSeats(
    [device('dev-1', '甲'), device('dev-2', '甲', 'pool-A')],
    [pool('pool-A', 2, ['甲'])],
    '2026-10-05',
  );

  assert.equal(result.coveredCount, 2);
  assert.equal(result.preservedCount, 1);
});

test('空输入返回空结果', () => {
  const result = reallocateSeats([], [], '2026-10-05');
  assert.deepEqual(result, {
    assignments: [],
    uncoveredDeviceIds: [],
    coveredCount: 0,
    preservedCount: 0,
  });
});

test('每池绑定设备数不超过席位总数', () => {
  const result = reallocateSeats(
    [device('dev-1', '甲'), device('dev-2', '甲'), device('dev-3', '乙')],
    [pool('pool-A', 1, ['甲', '乙']), pool('pool-B', 1, ['甲'])],
    '2026-10-05',
  );

  assert.equal(result.coveredCount, 2);
  const perPool = new Map<string, number>();
  for (const a of result.assignments) {
    perPool.set(a.poolId, (perPool.get(a.poolId) ?? 0) + 1);
  }
  assert.ok((perPool.get('pool-A') ?? 0) <= 1);
  assert.ok((perPool.get('pool-B') ?? 0) <= 1);
});
