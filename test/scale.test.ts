import test from 'node:test';
import assert from 'node:assert/strict';
import { planMaintenance, COST_PER_HOUR, type Device } from '../src/index.js';
import { assertPlanValid } from './helpers.js';

const TEN_SLOTS = Array.from({ length: 10 }, (_, i) => i * 8);
const MIB = 1024 * 1024;

function makeFullScaleDevices(): Device[] {
  // 9 台 4 小时 + 9 台 2 小时，全部共用 R1，窗口足够宽。
  const devices: Device[] = [];
  for (let i = 0; i < 18; i += 1) {
    devices.push({
      id: `EQ${String(i + 1).padStart(2, '0')}`,
      windowStart: 0,
      windowEnd: 48,
      duration: i < 9 ? 4 : 2,
      resourceIds: ['R1'],
    });
  }
  return devices;
}

test('18 台设备 10 个时点：返回合法且全局最优的计划', () => {
  const devices = makeFullScaleDevices();
  const start = performance.now();
  const result = planMaintenance({ devices, candidateSlots: TEN_SLOTS });
  const elapsedMs = performance.now() - start;

  assertPlanValid(result, devices, TEN_SLOTS);
  // 下界论证：9 台 4 小时设备至少占 3 组（各 4 小时），其余组至少 2 小时；
  // 18 台设备至少 6 组，总停机至少 3*4 + 3*2 = 18 小时，且可以达到。
  assert.equal(result.totalDowntimeHours, 18);
  assert.equal(result.totalCost, 18 * COST_PER_HOUR);
  assert.equal(result.groups.length, 6);
  assert.ok(elapsedMs < 10_000, `耗时 ${elapsedMs.toFixed(0)}ms 超过 10 秒`);
  assert.ok(process.memoryUsage().rss < 256 * MIB, '峰值内存超过 256 MiB');
});

test('18 台设备 10 个时点的复杂实例：性能与内存达标', () => {
  // 时长 1~8 小时、8 种资源随机分配、窗口交错的困难实例。
  let state = 12345;
  const rand = (n: number): number => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state % n;
  };
  const resources = Array.from({ length: 8 }, (_, i) => `RES${i}`);
  const devices: Device[] = Array.from({ length: 18 }, (_, i) => {
    const windowStart = rand(24);
    const windowLen = 24 + rand(25); // 24~48 小时
    const count = 1 + rand(8);
    const resourceIds = [...resources].sort(() => rand(3) - 1).slice(0, count);
    return {
      id: `DEV${i}`,
      windowStart,
      windowEnd: windowStart + windowLen,
      duration: 1 + rand(8),
      resourceIds,
    };
  });

  const start = performance.now();
  const result = planMaintenance({ devices, candidateSlots: TEN_SLOTS });
  const elapsedMs = performance.now() - start;

  if (result.feasible) {
    assertPlanValid(result, devices, TEN_SLOTS);
  }
  assert.ok(elapsedMs < 10_000, `耗时 ${elapsedMs.toFixed(0)}ms 超过 10 秒`);
  assert.ok(process.memoryUsage().rss < 256 * MIB, '峰值内存超过 256 MiB');
});

test('候选窗口不足：返回不可行结论而不是遗漏设备', () => {
  // 18 台设备都只能在时点 0/8/16/24 检修（时长 8，窗口 [0,36]），
  // 4 个可用时点最多容纳 4 组 * 3 台 = 12 台 < 18 台。
  const devices: Device[] = Array.from({ length: 18 }, (_, i) => ({
    id: `W${i}`,
    windowStart: 0,
    windowEnd: 36,
    duration: 8,
    resourceIds: ['R1'],
  }));
  const start = performance.now();
  const result = planMaintenance({ devices, candidateSlots: TEN_SLOTS });
  const elapsedMs = performance.now() - start;

  assert.equal(result.feasible, false);
  assert.equal(result.groups.length, 0);
  assert.equal(result.totalDowntimeHours, 0);
  assert.equal(result.totalCost, 0);
  assert.ok(elapsedMs < 10_000, `耗时 ${elapsedMs.toFixed(0)}ms 超过 10 秒`);
});
