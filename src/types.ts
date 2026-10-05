/** 已付项目录入输入。日期为 UTC 整日，格式 YYYY-MM-DD；endDate 不含。 */
export interface ItemInput {
  id: string;
  /** 原金额，整数分，1 .. 10^18 */
  amount: bigint;
  /** 服务起日（含） */
  startDate: string;
  /** 服务止日（不含），服务期 1..3650 天 */
  endDate: string;
}

/** 退款录入输入。 */
export interface RefundInput {
  /** 关联的已付项目标识 */
  itemId: string;
  /** 退款金额，整数分，>= 1 */
  amount: bigint;
  /** 生效日期（UTC 整日），不得早于服务起日 */
  effectiveDate: string;
}

/** 单日封账结果。 */
export interface DayResult {
  date: string;
  /** 当日确认收入（分），可为负 */
  revenue: bigint;
  /** 当日期末递延余额（分） */
  deferred: bigint;
}

/** 区间导出结果。 */
export interface RangeReport {
  from: string;
  to: string;
  days: DayResult[];
  /** 区间收入合计（分） */
  totalRevenue: bigint;
}
