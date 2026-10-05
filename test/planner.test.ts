import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  planMaintenance,
  ValidationError,
  COST_PER_HOUR,
} from "../src/index";
import type { DeviceInput, PlanRequest } from "../src/index";
import {
  assertLegalPlan,
  bruteForceMinHours,
  mulberry32,
  shuffled,
} from "./helpers";

function device(partial: Partial<DeviceInput> & { id: string }): DeviceInput {
  return {
    windowStart: 0,
    windowEnd: 24,
    duration: 2,
    resourceIds: ["R1"],
    ...partial,
  };
}

test("候选时点争用：局部最省的合并不是全局最省", () => {
  // A、B 时长最长，两两合并看似最省；但 C/D/E 各自只有一个可用时点，
  // 全局最优是把 A、B、C 合成三台一组，D、E 各占一个时点。
  const request: PlanRequest = {
    devices: [
      device({ id: "A", windowStart: 0, windowEnd: 16, duration: 6 }),
      device({ id: "B", windowStart: 0, windowEnd: 16, duration: 5 }),
      device({ id: "C", windowStart: 0, windowEnd: 1, duration: 1 }),
      device({ id: "D", windowStart: 8, windowEnd: 9, duration: 1 }),
      device({ id: "E", windowStart: 16, windowEnd: 17, duration: 1 }),
    ],
    candidateStarts: [0, 8, 16],
  };
  const result = planMaintenance(request);
  assertLegalPlan(request, result);
  const optimalHours = bruteForceMinHours(request);
  assert.equal(optimalHours, 8, "独立核验的全局最优应为 8 小时");
  assert.equal(result.totalDowntimeHours, optimalHours);
  assert.equal(result.totalCost, 8 * COST_PER_HOUR);
});

test("两两有共用资源但三者无共同资源，不能合成三台一组", () => {
  const request: PlanRequest = {
    devices: [
      device({ id: "A", resourceIds: ["R1", "R2"] }),
      device({ id: "B", resourceIds: ["R2", "R3"] }),
      device({ id: "C", resourceIds: ["R1", "R3"] }),
    ],
    candidateStarts: [0, 8],
  };
  const result = planMaintenance(request);
  assertLegalPlan(request, result);
  for (const group of result.groups) {
    assert.ok(group.deviceIds.length <= 2, "三者无共同资源，不允许三台一组");
  }
  // 最优为一个两人组 + 一个单人组，共 4 小时
  assert.equal(result.totalDowntimeHours, bruteForceMinHours(request));
  assert.equal(result.totalCost, 4 * COST_PER_HOUR);
});

test("完成时刻等于区间上界合法", () => {
  const request: PlanRequest = {
    devices: [device({ id: "A", windowStart: 0, windowEnd: 8, duration: 8 })],
    candidateStarts: [0],
  };
  const result = planMaintenance(request);
  assertLegalPlan(request, result);
  assert.equal(result.totalDowntimeHours, 8);
});

test("完成时刻超出区间上界 1 小时则不可用", () => {
  const request: PlanRequest = {
    devices: [device({ id: "A", windowStart: 0, windowEnd: 7, duration: 8 })],
    candidateStarts: [0],
  };
  const result = planMaintenance(request);
  assert.equal(result.feasible, false);
  assert.equal(result.groups.length, 0);
});

test("18 台设备 10 个候选时点：完整安排且费用最优", () => {
  // 18 台设备时长均为 4 小时，每组最多 3 台 => 至少 6 组、24 小时。
  const devices = Array.from({ length: 18 }, (_, i) =>
    device({ id: `D${i}`, windowStart: 0, windowEnd: 48, duration: 4 }),
  );
  const request: PlanRequest = {
    devices,
    candidateStarts: Array.from({ length: 10 }, (_, i) => i * 8),
  };
  const result = planMaintenance(request);
  assertLegalPlan(request, result);
  assert.equal(result.totalDowntimeHours, 24);
  assert.equal(result.totalCost, 24 * COST_PER_HOUR);
});

test("18 台设备但候选窗口不足：返回不可行", () => {
  const devices = Array.from({ length: 18 }, (_, i) =>
    device({ id: `D${i}`, windowStart: 0, windowEnd: 48, duration: 4 }),
  );
  // 5 个时点最多容纳 15 台设备
  const request: PlanRequest = {
    devices,
    candidateStarts: Array.from({ length: 5 }, (_, i) => i * 8),
  };
  const result = planMaintenance(request);
  assert.equal(result.feasible, false);
  assert.equal(result.groups.length, 0);
  assert.equal(result.totalCost, 0);
});

test("最大规模最坏情形：10 秒内完成且内存不超过 256 MiB", () => {
  // 所有设备在所有时点都可用、共享全部资源，使合法组数量最大化。
  const rand = mulberry32(42);
  const devices = Array.from({ length: 18 }, (_, i) =>
    device({
      id: `D${i}`,
      windowStart: 0,
      windowEnd: 48,
      duration: 1 + Math.floor(rand() * 8),
      resourceIds: ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"],
    }),
  );
  const request: PlanRequest = {
    devices,
    candidateStarts: Array.from({ length: 10 }, (_, i) => i * 8),
  };
  const memBefore = process.memoryUsage().rss;
  const startMs = Date.now();
  const result = planMaintenance(request);
  const elapsedMs = Date.now() - startMs;
  const memAfter = process.memoryUsage().rss;
  assertLegalPlan(request, result);
  assert.ok(elapsedMs < 10_000, `耗时 ${elapsedMs}ms 超过 10 秒`);
  assert.ok(
    memAfter - memBefore < 256 * 1024 * 1024,
    `内存增长 ${memAfter - memBefore} 字节超过 256 MiB`,
  );
});

test("输入顺序不影响最优费用与可行性结论", () => {
  const rand = mulberry32(7);
  const devices = Array.from({ length: 12 }, (_, i) =>
    device({
      id: `D${i}`,
      windowStart: Math.floor(rand() * 16),
      windowEnd: 24 + Math.floor(rand() * 24),
      duration: 1 + Math.floor(rand() * 8),
      resourceIds: rand() < 0.5 ? ["R1", "R2"] : ["R2", "R3"],
    }),
  );
  const candidateStarts = Array.from({ length: 8 }, (_, i) => i * 8);
  const base = planMaintenance({ devices, candidateStarts });
  for (let trial = 0; trial < 5; trial++) {
    const shuffledResult = planMaintenance({
      devices: shuffled(devices, rand),
      candidateStarts: shuffled(candidateStarts, rand),
    });
    assert.equal(shuffledResult.feasible, base.feasible);
    assert.equal(shuffledResult.totalCost, base.totalCost);
  }
});

test("随机小规模输入与暴力枚举的全局最优一致", () => {
  const rand = mulberry32(20261005);
  for (let instance = 0; instance < 200; instance++) {
    const n = 1 + Math.floor(rand() * 8);
    const slotCount = 1 + Math.floor(rand() * 5);
    const devices = Array.from({ length: n }, (_, i) => {
      const windowStart = Math.floor(rand() * 24);
      const length = 1 + Math.floor(rand() * 24);
      const pool = ["R1", "R2", "R3"].filter(() => rand() < 0.6);
      return device({
        id: `D${i}`,
        windowStart,
        windowEnd: windowStart + length,
        duration: 1 + Math.floor(rand() * 8),
        resourceIds: pool.length > 0 ? pool : ["R1"],
      });
    });
    const request: PlanRequest = {
      devices,
      candidateStarts: Array.from({ length: slotCount }, (_, i) => i * 8),
    };
    const result = planMaintenance(request);
    const optimalHours = bruteForceMinHours(request);
    if (optimalHours === null) {
      assert.equal(result.feasible, false, `实例 ${instance} 应不可行`);
    } else {
      assertLegalPlan(request, result);
      assert.equal(
        result.totalDowntimeHours,
        optimalHours,
        `实例 ${instance} 费用未达到暴力核验的全局最优`,
      );
    }
  }
});

test("非法输入抛出 ValidationError", () => {
  const valid: PlanRequest = {
    devices: [device({ id: "A" })],
    candidateStarts: [0],
  };
  assert.throws(() => planMaintenance({ ...valid, devices: [] }), ValidationError);
  assert.throws(
    () =>
      planMaintenance({
        ...valid,
        devices: [device({ id: "A" }), device({ id: "A" })],
      }),
    ValidationError,
  );
  assert.throws(
    () => planMaintenance({ ...valid, devices: [device({ id: "A", duration: 0 })] }),
    ValidationError,
  );
  assert.throws(
    () => planMaintenance({ ...valid, devices: [device({ id: "A", duration: 9 })] }),
    ValidationError,
  );
  assert.throws(
    () =>
      planMaintenance({
        ...valid,
        devices: [device({ id: "A", windowStart: 0, windowEnd: 49 })],
      }),
    ValidationError,
  );
  assert.throws(
    () => planMaintenance({ ...valid, candidateStarts: [0, 4] }),
    ValidationError,
  );
  assert.throws(
    () => planMaintenance({ ...valid, candidateStarts: [0, 0] }),
    ValidationError,
  );
  assert.throws(
    () =>
      planMaintenance({
        devices: Array.from({ length: 19 }, (_, i) => device({ id: `D${i}` })),
        candidateStarts: [0],
      }),
    ValidationError,
  );
  assert.throws(
    () =>
      planMaintenance({
        ...valid,
        candidateStarts: Array.from({ length: 11 }, (_, i) => i * 8),
      }),
    ValidationError,
  );
  assert.throws(
    () =>
      planMaintenance({
        ...valid,
        devices: [
          device({ id: "A", resourceIds: ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9"] }),
        ],
      }),
    ValidationError,
  );
});
