/** 一台需要安排检修的设备。所有时刻为同一时间基准下的整点（小时）。 */
export interface Device {
  /** 唯一编号 */
  id: string;
  /** 可检修区间下界（含） */
  windowStart: number;
  /** 可检修区间上界（含），完成时刻等于上界合法 */
  windowEnd: number;
  /** 检修时长（小时），1 至 8 */
  duration: number;
  /** 可使用的停机隔离资源编号集合 */
  resourceIds: string[];
}

/** 一次厂区规划的输入。 */
export interface PlantInput {
  devices: Device[];
  /** 候选停机开始时点（整点），相邻至少相隔 8 小时 */
  candidateSlots: number[];
}

/** 一个维护组：同组设备同时开始检修。 */
export interface MaintenanceGroup {
  deviceIds: string[];
  /** 开始时点（取自候选时点） */
  start: number;
  /** 组内每台设备都允许使用的隔离资源 */
  resourceId: string;
  /** 组停机时长 = 组内最长检修时长 */
  downtimeHours: number;
}

/** 规划结果。 */
export interface PlanResult {
  feasible: boolean;
  groups: MaintenanceGroup[];
  /** 所有维护组停机时长之和 */
  totalDowntimeHours: number;
  /** 总停产费用 = 总停机时长 * 15000 */
  totalCost: number;
}

export const COST_PER_HOUR = 15000;
