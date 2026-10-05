/** A confirmed work-time record. [startUtc, endUtc) in UTC epoch seconds. */
export interface TimeRecord {
  employeeId: string;
  startUtc: number;
  endUtc: number;
}

/** A pay-rate change. Rate in integer cents per hour, effective from effectiveUtc. */
export interface RateChange {
  employeeId: string;
  effectiveUtc: number;
  centsPerHour: number;
}

/** Settlement window in local dates, inclusive of start, exclusive of end. */
export interface SettlementPeriod {
  /** Local date "YYYY-MM-DD", boundary at local midnight. */
  startDate: string;
  endDate: string;
}

/** Exact rational amount in cents; denominator is always positive. */
export interface Rational {
  numerator: bigint;
  denominator: bigint;
}

export interface EmployeeSettlement {
  employeeId: string;
  /** Base pay for effective seconds in the period, rounded half-up to cents. */
  basePayCents: number;
  /** Overtime premium (0.5x weekly average rate on OT seconds), rounded half-up. */
  overtimePremiumCents: number;
  /** Exact base + exact premium, rounded half-up once. */
  totalCents: number;
  /** Unrounded exact amounts (additivity-safe across adjacent periods). */
  exactBasePay: Rational;
  exactOvertimePremium: Rational;
  exactTotal: Rational;
}
