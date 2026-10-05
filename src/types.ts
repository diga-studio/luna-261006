/** 一条已确认的工时记录：[startUtc, endUtc)，UTC 纪元秒，含起点不含终点。 */
export interface WorkRecord {
  employeeId: string;
  startUtc: number;
  endUtc: number;
}

/** 一条调薪记录：从 effectiveUtc 瞬间起使用新费率（整数分/小时）。 */
export interface RateChange {
  employeeId: string;
  effectiveUtc: number;
  centsPerHour: number;
}

/** 精确有理数金额（单位：分），不舍入。 */
export interface RationalValue {
  /** 分子（已约分） */
  readonly numerator: bigint;
  /** 分母（正整数，已约分） */
  readonly denominator: bigint;
}

/** 单个员工一次结算的核算结果。 */
export interface SettlementResult {
  employeeId: string;
  /** 区间内有效工时的基础工资（分，精确值） */
  basePay: RationalValue;
  /** 区间内加班工时的补差（分，精确值） */
  overtimePremium: RationalValue;
  /** basePay + overtimePremium 合计后四舍五入到分（半分向上） */
  totalRoundedCents: bigint;
}

/** 结算区间：本地日期 [startLocalDate, endLocalDate)，含起点不含终点。 */
export interface SettlementPeriod {
  /** 本地起始日期，格式 YYYY-MM-DD */
  startLocalDate: string;
  /** 本地结束日期（不含），格式 YYYY-MM-DD */
  endLocalDate: string;
}
