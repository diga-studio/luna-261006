/** 营地营期：IANA 时区 + 当地日期区间 [startDate, endDate)，日期格式 YYYY-MM-DD。 */
export interface CampSession {
  id: string;
  timeZone: string;
  startDate: string;
  endDate: string;
}

/** 药单版本：每日服药时刻集合（"HH:MM"，当地时间）+ 左闭右开 UTC 有效区间（epoch ms）。 */
export interface OrderVersion {
  validFromUtcMs: number;
  validToUtcMs: number;
  /** 每日服药时刻，格式 "HH:MM"（24 小时制，精确到分钟）。 */
  times: string[];
}

/** 已审核药单，装载后不可修改。 */
export interface MedicationOrder {
  id: string;
  sessionId: string;
  camperId: string;
  /** 版本按 validFromUtcMs 升序，有效区间互不重叠。 */
  versions: OrderVersion[];
}

export type DoseStatus = "administered" | "overdue" | "pending";

/** 查询返回的剂次视图。 */
export interface DoseView {
  doseId: string;
  orderId: string;
  camperId: string;
  /** 原定当地日期 YYYY-MM-DD 与时刻 "HH:MM"。 */
  originalDate: string;
  originalTime: string;
  scheduledUtcMs: number;
  status: DoseStatus;
  administeredUtcMs: number | null;
}

export interface DoseQuery {
  /** 左闭右开计划 UTC 区间。 */
  fromUtcMs: number;
  toUtcMs: number;
  /** 观察时刻（epoch ms）。 */
  observedAtUtcMs: number;
  camperId?: string;
  orderId?: string;
}
