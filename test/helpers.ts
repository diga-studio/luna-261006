import * as assert from "node:assert/strict";
import { COST_PER_HOUR } from "../src/index";
import type {
  DeviceInput,
  PlanRequest,
  PlanResult,
} from "../src/index";

/** 可种子化的伪随机数发生器（mulberry32），保证测试可复现。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 用 Fisher-Yates 打乱数组（返回新数组）。 */
export function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

function hasCommonResource(devices: readonly DeviceInput[]): boolean {
  const counts = new Map<string, number>();
  for (const d of devices) {
    for (const r of d.resourceIds) counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  for (const c of counts.values()) {
    if (c === devices.length) return true;
  }
  return false;
}

/**
 * 暴力枚举全部合法方案，返回全局最小总停机时长；不可行返回 null。
 * 仅用于小规模输入的独立核验。
 */
export function bruteForceMinHours(request: PlanRequest): number | null {
  const devices = request.devices;
  const starts = [...request.candidateStarts].sort((a, b) => a - b);
  let best = Infinity;
  const rec = (k: number, remaining: readonly DeviceInput[], cost: number): void => {
    if (remaining.length === 0) {
      if (cost < best) best = cost;
      return;
    }
    if (k >= starts.length || cost >= best) return;
    // 空置该时点
    rec(k + 1, remaining, cost);
    const start = starts[k] as number;
    const avail = remaining.filter(
      (d) => start >= d.windowStart && start + d.duration <= d.windowEnd,
    );
    // 枚举该时点上大小为 1..3 的全部合法组
    for (let size = 1; size <= 3 && size <= avail.length; size++) {
      const pick = (from: number, chosen: DeviceInput[]): void => {
        if (chosen.length === size) {
          if (!hasCommonResource(chosen)) return;
          const hours = Math.max(...chosen.map((d) => d.duration));
          const rest = remaining.filter((d) => !chosen.includes(d));
          rec(k + 1, rest, cost + hours);
          return;
        }
        for (let i = from; i < avail.length; i++) {
          pick(i + 1, [...chosen, avail[i] as DeviceInput]);
        }
      };
      pick(0, []);
    }
  };
  rec(0, devices, 0);
  return best === Infinity ? null : best;
}

/** 校验返回计划的合法性（不校验最优性）。 */
export function assertLegalPlan(request: PlanRequest, result: PlanResult): void {
  assert.equal(result.feasible, true, "应返回可行计划");
  const seen = new Set<string>();
  const usedStarts = new Set<number>();
  let totalHours = 0;
  const byId = new Map(request.devices.map((d) => [d.id, d]));
  for (const group of result.groups) {
    assert.ok(group.deviceIds.length >= 1 && group.deviceIds.length <= 3,
      `组大小必须在 1..3，实际 ${group.deviceIds.length}`);
    assert.ok(request.candidateStarts.includes(group.start),
      `开始时点 ${group.start} 必须来自候选时点`);
    assert.ok(!usedStarts.has(group.start), `时点 ${group.start} 被重复使用`);
    usedStarts.add(group.start);
    let hours = 0;
    const resourceCount = new Map<string, number>();
    for (const id of group.deviceIds) {
      assert.ok(!seen.has(id), `设备 ${id} 被重复安排`);
      seen.add(id);
      const d = byId.get(id);
      assert.ok(d, `未知设备 ${id}`);
      assert.ok(group.start >= (d as DeviceInput).windowStart,
        `设备 ${id} 开始时刻早于区间下界`);
      assert.ok(group.start + (d as DeviceInput).duration <= (d as DeviceInput).windowEnd,
        `设备 ${id} 完成时刻晚于区间上界`);
      assert.ok((d as DeviceInput).resourceIds.includes(group.resourceId),
        `设备 ${id} 不允许使用资源 ${group.resourceId}`);
      hours = Math.max(hours, (d as DeviceInput).duration);
    }
    assert.equal(group.duration, hours, "组停机时长应等于组内最长检修时长");
    totalHours += hours;
  }
  assert.equal(seen.size, request.devices.length, "计划必须覆盖全部设备");
  assert.equal(result.totalDowntimeHours, totalHours, "总停机时长不一致");
  assert.equal(result.totalCost, totalHours * COST_PER_HOUR, "总费用不一致");
}
