import type { Device, MaintenanceGroup } from './types.js';

export interface SolveOutput {
  feasible: boolean;
  groups: MaintenanceGroup[];
  totalDowntimeHours: number;
}

const INF = 1_000_000_000;
const UNCOMPUTED = -1;

interface SlotGroup {
  /** 组内设备的位掩码 */
  mask: number;
  /** 组停机时长 = 组内最长检修时长 */
  downtime: number;
  /** 选中的隔离资源 */
  resourceId: string;
}

/**
 * 精确求解：覆盖全部设备、总停机时长最小的维护组划分与时点分配。
 * 设备需已按 id 排序；候选时点需已按时刻升序排序。
 *
 * 状态 (mask, slot)：用 slot 及其之后的候选时点覆盖 mask 中设备的最小总停机时长。
 * 每个时点要么空置，要么安排一个包含 mask 最低位设备的可行维护组。
 */
export function solve(devices: Device[], slots: number[]): SolveOutput {
  const deviceCount = devices.length;
  const slotCount = slots.length;
  const fullMask = (1 << deviceCount) - 1;

  // 每台设备按排序后的资源列表保存，保证资源选择与输入顺序无关。
  const sortedResources = devices.map((device) => [...device.resourceIds].sort());

  // groupsBySlotDevice[s][i]：在时点 s 开始、包含设备 i 的全部可行维护组。
  const groupsBySlotDevice: SlotGroup[][][] = [];
  // 每台设备是否至少能在一个候选时点单独检修（快速不可行判定）。
  const deviceCoverable = new Array<boolean>(deviceCount).fill(false);

  for (let s = 0; s < slotCount; s += 1) {
    const slotTime = slots[s]!;
    // 该时点可单独检修的设备集合。
    const eligible: number[] = [];
    for (let i = 0; i < deviceCount; i += 1) {
      const device = devices[i]!;
      if (slotTime >= device.windowStart && slotTime + device.duration <= device.windowEnd) {
        eligible.push(i);
        deviceCoverable[i] = true;
      }
    }
    const perDevice: SlotGroup[][] = Array.from({ length: deviceCount }, () => []);
    const emit = (mask: number): void => {
      let downtime = 0;
      let common: string[] | null = null;
      for (let i = 0; i < deviceCount; i += 1) {
        if ((mask & (1 << i)) === 0) continue;
        const device = devices[i]!;
        if (device.duration > downtime) downtime = device.duration;
        common = common === null
          ? sortedResources[i]!
          : common.filter((id) => sortedResources[i]!.includes(id));
      }
      if (common === null || common.length === 0) return;
      const group: SlotGroup = { mask, downtime, resourceId: common[0]! };
      for (let i = 0; i < deviceCount; i += 1) {
        if (mask & (1 << i)) perDevice[i]!.push(group);
      }
    };
    for (const i of eligible) {
      emit(1 << i);
    }
    for (let a = 0; a < eligible.length; a += 1) {
      for (let b = a + 1; b < eligible.length; b += 1) {
        emit((1 << eligible[a]!) | (1 << eligible[b]!));
        for (let c = b + 1; c < eligible.length; c += 1) {
          emit((1 << eligible[a]!) | (1 << eligible[b]!) | (1 << eligible[c]!));
        }
      }
    }
    groupsBySlotDevice.push(perDevice);
  }

  for (let i = 0; i < deviceCount; i += 1) {
    if (!deviceCoverable[i]) {
      return { feasible: false, groups: [], totalDowntimeHours: 0 };
    }
  }
  if (deviceCount === 0) {
    return { feasible: true, groups: [], totalDowntimeHours: 0 };
  }

  // 记忆表与决策表：索引 mask * (slotCount + 1) + slot。
  const stride = slotCount + 1;
  const tableSize = (fullMask + 1) * stride;
  const memo = new Int32Array(tableSize).fill(UNCOMPUTED);
  // choice：0 = 该时点空置；否则为所选维护组的设备掩码。
  const choice = new Int32Array(tableSize);

  const dp = (mask: number, slot: number): number => {
    if (mask === 0) return 0;
    if (slot >= slotCount) return INF;
    const key = mask * stride + slot;
    const cached = memo[key]!;
    if (cached !== UNCOMPUTED) return cached;

    let best = dp(mask, slot + 1);
    let bestGroup = 0;

    // 最低位设备必须被某个组覆盖，只需枚举包含它的组。
    const lowest = mask & (-mask);
    const deviceIndex = 31 - Math.clz32(lowest);
    for (const group of groupsBySlotDevice[slot]![deviceIndex]!) {
      if ((group.mask & mask) !== group.mask) continue;
      const rest = dp(mask ^ group.mask, slot + 1);
      const total = group.downtime + rest;
      if (total < best) {
        best = total;
        bestGroup = group.mask;
      }
    }

    memo[key] = best >= INF ? INF : best;
    choice[key] = bestGroup;
    return best;
  };

  const optimum = dp(fullMask, 0);
  if (optimum >= INF) {
    return { feasible: false, groups: [], totalDowntimeHours: 0 };
  }

  // 依决策表重建计划。
  const groups: MaintenanceGroup[] = [];
  let mask = fullMask;
  let slot = 0;
  while (mask !== 0) {
    const key = mask * stride + slot;
    const groupMask = choice[key]!;
    if (groupMask === 0) {
      slot += 1;
      continue;
    }
    const slotGroups = groupsBySlotDevice[slot]!;
    let chosen: SlotGroup | undefined;
    for (const candidate of slotGroups.flat()) {
      if (candidate.mask === groupMask) {
        chosen = candidate;
        break;
      }
    }
    const deviceIds: string[] = [];
    for (let i = 0; i < deviceCount; i += 1) {
      if (groupMask & (1 << i)) deviceIds.push(devices[i]!.id);
    }
    groups.push({
      deviceIds,
      start: slots[slot]!,
      resourceId: chosen!.resourceId,
      downtimeHours: chosen!.downtime,
    });
    mask ^= groupMask;
    slot += 1;
  }

  return { feasible: true, groups, totalDowntimeHours: optimum };
}
