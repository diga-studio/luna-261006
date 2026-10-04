/** 种子中的一期：剩余本金（整数美分）与到期时刻（UTC 整数秒）。 */
export interface SeedInstallment {
  principal: number;
  dueAt: number;
}

/** 首次创建计划时的种子。 */
export interface PlanSeed {
  startAt: number;
  installments: SeedInstallment[];
}

/** 已确认的一笔到账。 */
export interface Confirmation {
  requestId: string;
  paidAt: number;
  amount: number;
}

/** 单期余额快照。 */
export interface InstallmentBalance {
  /** 期次序号，从 0 开始，按 dueAt 递增。 */
  index: number;
  dueAt: number;
  principalRemaining: number;
  feeRemaining: number;
}

/** 一笔确认资金的归账去向。 */
export interface ConfirmationAllocation {
  requestId: string;
  paidAt: number;
  amount: number;
  /** 净本金抵扣总额。 */
  toPrincipal: number;
  /** 净费用抵扣总额。 */
  toFee: number;
  /** 未分配余额。 */
  unallocated: number;
}

/** inspect() 的只读结果。 */
export interface Inspection {
  startAt: number;
  now: number;
  installments: InstallmentBalance[];
  /** 计划内未分配余额总额。 */
  unallocated: number;
  /** 逐笔资金去向，按 (paidAt, requestId) 排序。 */
  allocations: ConfirmationAllocation[];
}
