import type { DeviceInput, MaintenanceGroup } from "./types";

/** 一个可安排在某候选时点的维护组（内部表示）。 */
interface SlotGroup {
  /** 组内设备的位掩码 */
  readonly mask: number;
  /** 组停机时长 = 组内最长检修时长 */
  readonly hours: number;
  /** 所选隔离资源编号 */
  readonly resourceId: string;
}

export interface SolveResult {
  readonly feasible: boolean;
  readonly groups: MaintenanceGroup[];
  readonly totalDowntimeHours: number;
}

/**
 * 精确求解：在候选时点上为维护组（1-3 台设备、共同资源、区间约束）
 * 选择安排，使总停机时长最小。设备与候选时点须已排序。
 */
export function solve(
  devices: readonly DeviceInput[],
  candidateStarts: readonly number[],
): SolveResult {
  const n = devices.length;
  const fullMask = (1 << n) - 1;

  // 每台设备可使用的资源集合（按资源编号排序后取交集，保证确定性）。
  const deviceResources: readonly (readonly string[])[] = devices.map((d) =>
    [...d.resourceIds].sort(),
  );

  // 预先计算：每个候选时点可安排的全部合法维护组。
  const slotCount = candidateStarts.length;
  const slotGroups: SlotGroup[][] = [];

  for (let k = 0; k < slotCount; k++) {
    const start = candidateStarts[k] as number;
    // 该时点可检修的设备：start >= windowStart 且 start + duration <= windowEnd。
    const available: number[] = [];
    for (let i = 0; i < n; i++) {
      const d = devices[i] as DeviceInput;
      if (start >= d.windowStart && start + d.duration <= d.windowEnd) {
        available.push(i);
      }
    }
    const groups: SlotGroup[] = [];
    const addGroup = (members: number[]): void => {
      // 共同资源：逐台求交集。
      let common: readonly string[] = deviceResources[members[0] as number] as readonly string[];
      for (let m = 1; m < members.length && common.length > 0; m++) {
        const other = new Set(deviceResources[members[m] as number] as readonly string[]);
        common = common.filter((r) => other.has(r));
      }
      if (common.length === 0) return;
      let mask = 0;
      let hours = 0;
      for (const i of members) {
        mask |= 1 << i;
        hours = Math.max(hours, (devices[i] as DeviceInput).duration);
      }
      groups.push({ mask, hours, resourceId: common[0] as string });
    };
    for (let a = 0; a < available.length; a++) {
      const i = available[a] as number;
      addGroup([i]);
      for (let b = a + 1; b < available.length; b++) {
        const j = available[b] as number;
        addGroup([i, j]);
        for (let c = b + 1; c < available.length; c++) {
          addGroup([i, j, available[c] as number]);
        }
      }
    }
    slotGroups.push(groups);
  }

  // DP：dp[mask] = 已处理的候选时点内，恰好覆盖 mask 中设备的最小总停机时长。
  // 每个时点可空置或安排一个组；组的成员可以分布在任意后续时点，
  // 因此必须枚举该时点全部合法组中与 mask 不相交的每一个。
  let dp = new Float64Array(1 << n).fill(Infinity);
  dp[0] = 0;
  // choice[k][mask]：第 k 个时点如何得到该掩码（-1 = 空置该时点，>=0 = 组下标）。
  const choices: Int32Array[] = [];

  for (let k = 0; k < slotCount; k++) {
    const groups = slotGroups[k] as SlotGroup[];
    const next = Float64Array.from(dp);
    const choice = new Int32Array(1 << n).fill(-1);
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi] as SlotGroup;
      const complement = fullMask & ~g.mask;
      // 枚举 complement 的全部子掩码 m（即与该组不相交的已覆盖集合）。
      let m = complement;
      for (;;) {
        const base = dp[m] as number;
        if (base !== Infinity) {
          const target = m | g.mask;
          const cost = base + g.hours;
          if (cost < (next[target] as number)) {
            next[target] = cost;
            choice[target] = gi;
          }
        }
        if (m === 0) break;
        m = (m - 1) & complement;
      }
    }
    dp = next;
    choices.push(choice);
  }

  const totalHours = dp[fullMask] as number;
  if (totalHours === Infinity) {
    return { feasible: false, groups: [], totalDowntimeHours: 0 };
  }

  // 回溯构造计划。
  const result: MaintenanceGroup[] = [];
  let mask = fullMask;
  for (let k = slotCount - 1; k >= 0; k--) {
    const c = (choices[k] as Int32Array)[mask] as number;
    if (c < 0) continue;
    const g = (slotGroups[k] as SlotGroup[])[c] as SlotGroup;
    const deviceIds: string[] = [];
    for (let i = 0; i < n; i++) {
      if (g.mask & (1 << i)) deviceIds.push((devices[i] as DeviceInput).id);
    }
    result.push({
      deviceIds,
      start: candidateStarts[k] as number,
      resourceId: g.resourceId,
      duration: g.hours,
    });
    mask ^= g.mask;
  }
  result.reverse();
  return { feasible: true, groups: result, totalDowntimeHours: totalHours };
}
