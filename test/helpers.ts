import assert from 'node:assert/strict';
import type { Device, PlanResult } from '../src/index.js';
import { COST_PER_HOUR } from '../src/index.js';

/**
 * 独立的暴力核验器：枚举全部“设备划分 + 时点分配”方案，返回最小总停机时长；
 * 不可行时返回 null。仅用于小规模用例的交叉验证，与求解器实现无关。
 */
export function bruteForceMinDowntime(devices: Device[], slots: number[]): number | null {
  const n = devices.length;
  const fullMask = (1 << n) - 1;
  let best = Number.POSITIVE_INFINITY;

  const feasibleAt = (mask: number, slotTime: number): { downtime: number } | null => {
    let downtime = 0;
    let common: Set<string> | null = null;
    for (let i = 0; i < n; i += 1) {
      if ((mask & (1 << i)) === 0) continue;
      const d = devices[i]!;
      if (slotTime < d.windowStart || slotTime + d.duration > d.windowEnd) return null;
      downtime = Math.max(downtime, d.duration);
      if (common === null) {
        common = new Set(d.resourceIds);
      } else {
        const kept = new Set<string>();
        for (const r of common) {
          if (d.resourceIds.includes(r)) kept.add(r);
        }
        common = kept;
      }
    }
    if (common === null || common.size === 0) return null;
    return { downtime };
  };

  const rec = (mask: number, usedSlots: number, cost: number): void => {
    if (mask === 0) {
      best = Math.min(best, cost);
      return;
    }
    if (cost >= best) return;
    let lowest = 0;
    while (!(mask & (1 << lowest))) lowest += 1;
    for (let s = 0; s < slots.length; s += 1) {
      if (usedSlots & (1 << s)) continue;
      // 枚举包含 lowest 的 1~3 台设备子集。
      const others: number[] = [];
      for (let i = 0; i < n; i += 1) {
        if (i !== lowest && mask & (1 << i)) others.push(i);
      }
      const subsets: number[] = [1 << lowest];
      for (const a of others) {
        subsets.push((1 << lowest) | (1 << a));
        for (const b of others) {
          if (b > a) subsets.push((1 << lowest) | (1 << a) | (1 << b));
        }
      }
      for (const sub of subsets) {
        const fit = feasibleAt(sub, slots[s]!);
        if (!fit) continue;
        rec(mask ^ sub, usedSlots | (1 << s), cost + fit.downtime);
      }
    }
  };
  rec(fullMask, 0, 0);
  return best === Number.POSITIVE_INFINITY ? null : best;
}

/** 校验返回计划在业务规则下完全合法，且与输入自洽。 */
export function assertPlanValid(
  result: PlanResult,
  devices: Device[],
  slots: number[],
): void {
  assert.equal(result.feasible, true);
  const byId = new Map(devices.map((d) => [d.id, d]));

  // 每台设备恰好出现一次。
  const seen = new Set<string>();
  for (const group of result.groups) {
    assert.ok(group.deviceIds.length >= 1 && group.deviceIds.length <= 3, 'group size 1..3');
    for (const id of group.deviceIds) {
      assert.ok(byId.has(id), `unknown device ${id}`);
      assert.ok(!seen.has(id), `device ${id} appears twice`);
      seen.add(id);
    }
  }
  assert.equal(seen.size, devices.length, 'all devices covered exactly once');

  // 每个候选时点最多一个组；时点必须来自候选集合。
  const usedSlots = new Set<number>();
  let total = 0;
  for (const group of result.groups) {
    assert.ok(slots.includes(group.start), `start ${group.start} not a candidate slot`);
    assert.ok(!usedSlots.has(group.start), `slot ${group.start} used twice`);
    usedSlots.add(group.start);

    let maxDuration = 0;
    for (const id of group.deviceIds) {
      const device = byId.get(id)!;
      assert.ok(group.start >= device.windowStart, `${id} starts before window`);
      assert.ok(group.start + device.duration <= device.windowEnd, `${id} ends after window`);
      assert.ok(device.resourceIds.includes(group.resourceId), `${id} cannot use ${group.resourceId}`);
      maxDuration = Math.max(maxDuration, device.duration);
    }
    assert.equal(group.downtimeHours, maxDuration, 'group downtime = max duration');
    total += group.downtimeHours;
  }
  assert.equal(result.totalDowntimeHours, total);
  assert.equal(result.totalCost, total * COST_PER_HOUR);
}

/** 确定性洗牌（固定种子），用于顺序无关性测试。 */
export function shuffled<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let state = seed;
  const rand = (): number => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
