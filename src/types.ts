/** 单台设备的检修需求。所有时刻为同一时间基准下的整点（小时）。 */
export interface DeviceInput {
  /** 设备唯一编号 */
  readonly id: string;
  /** 可检修区间下界（含） */
  readonly windowStart: number;
  /** 可检修区间上界（含），完成时刻等于上界合法；区间长度最长 48 小时 */
  readonly windowEnd: number;
  /** 检修时长（小时），1 至 8 */
  readonly duration: number;
  /** 可使用的停机隔离资源编号集合 */
  readonly resourceIds: readonly string[];
}

/** 一次厂区规划请求。 */
export interface PlanRequest {
  /** 设备列表，最多 18 台 */
  readonly devices: readonly DeviceInput[];
  /** 候选停机开始时点列表，最多 10 个，相邻时点至少相隔 8 小时 */
  readonly candidateStarts: readonly number[];
}

/** 一个维护组：同组设备同时开始检修，共用一种隔离资源。 */
export interface MaintenanceGroup {
  /** 组内设备编号（1 至 3 台） */
  readonly deviceIds: readonly string[];
  /** 开始时点（取自候选时点） */
  readonly start: number;
  /** 所选隔离资源编号 */
  readonly resourceId: string;
  /** 组停机时长 = 组内最长检修时长 */
  readonly duration: number;
}

/** 规划结果。 */
export interface PlanResult {
  /** 是否存在覆盖全部设备的合法计划 */
  readonly feasible: boolean;
  /** 维护组列表（不可行时为空） */
  readonly groups: readonly MaintenanceGroup[];
  /** 总停机时长（小时） */
  readonly totalDowntimeHours: number;
  /** 总停产费用（美元），每小时 15000 */
  readonly totalCost: number;
}

/** 每小时停产费用（美元）。 */
export const COST_PER_HOUR = 15000;
