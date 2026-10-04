/** 一期计划：剩余本金（整数美分）与到期时刻（UTC 整数秒）。 */
export interface InstallmentSeed {
  /** 剩余本金，整数美分，>= 0 */
  principal: number;
  /** 到期时刻，UTC 整数秒，必须晚于 startAt，按递增排列 */
  dueAt: number;
}

/** openPlan 首次创建时使用的种子。 */
export interface PlanSeed {
  /** 计划起始时刻，UTC 整数秒；观察时刻初始值 */
  startAt: number;
  /** 各期（首期已结算，不在其中），按 dueAt 递增 */
  installments: InstallmentSeed[];
}

/** 单笔确认的资金去向分解（整数美分）。 */
export interface Allocation {
  requestId: string;
  paidAt: number;
  amount: number;
  /** 净费用抵扣 */
  feesPaid: number;
  /** 净本金抵扣 */
  principalPaid: number;
  /** 进入未分配余额的部分 */
  unallocated: number;
}

/** 某一期的当前余额。 */
export interface InstallmentBalance {
  /** 期次序号（0 起，对应 seed.installments 的顺序） */
  index: number;
  dueAt: number;
  /** 未偿本金 */
  principalOutstanding: number;
  /** 未偿费用 */
  feeOutstanding: number;
  /** 该期是否已计提过费用 */
  feeCharged: boolean;
}

/** inspect() 的只读快照。 */
export interface PlanSnapshot {
  now: number;
  installments: InstallmentBalance[];
  /** 计划内未分配余额 */
  unallocated: number;
  /** 逐笔资金归账结果，按 (paidAt, requestId) 排序 */
  allocations: Allocation[];
  /** 计划累计已计提费用（含已支付部分，占用 1500 上限） */
  totalFeesCharged: number;
}

/** 计划句柄。 */
export interface Plan {
  confirm(requestId: string, paidAt: number, amount: number): void;
  advanceTo(now: number): void;
  inspect(): PlanSnapshot;
  close(): void;
}
