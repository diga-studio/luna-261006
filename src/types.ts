/** Local calendar date in the camp session time zone, ISO `YYYY-MM-DD`. */
export type LocalDate = string;
/** Local wall-clock time of day, `HH:MM` (24h, minute precision). */
export type LocalTime = string;
/** UTC instant, ISO 8601 string (e.g. `2025-03-09T07:30:00.000Z`). */
export type UtcInstant = string;
/** IANA time zone name, e.g. `America/New_York`. */
export type TimeZone = string;

/** A camp session: local dates in [startDate, endDate). */
export interface CampSession {
  timeZone: TimeZone;
  /** Inclusive local start date. */
  startDate: LocalDate;
  /** Exclusive local end date. */
  endDate: LocalDate;
}

/** One version of a medication order. */
export interface OrderVersion {
  /** Unique within the order. */
  versionId: string;
  /** Daily administration times (local wall clock, minute precision). */
  times: readonly LocalTime[];
  /** Inclusive UTC start of this version's validity. */
  validFromUtc: UtcInstant;
  /** Exclusive UTC end of this version's validity. */
  validToUtc: UtcInstant;
}

/** A reviewed medication order to load. Immutable once loaded. */
export interface ReviewedOrder {
  orderId: string;
  camperId: string;
  session: CampSession;
  /** Non-overlapping UTC validity ranges. */
  versions: readonly OrderVersion[];
}

/** Stable identity of a single scheduled dose. */
export interface DoseIdentity {
  orderId: string;
  versionId: string;
  /** Original local date the dose was scheduled for. */
  localDate: LocalDate;
  /** Original local time of day the dose was scheduled for. */
  localTime: LocalTime;
}

export type DoseStatus = "administered" | "overdue" | "pending";

export interface ScheduledDose extends DoseIdentity {
  camperId: string;
  /** Planned UTC instant of this dose. */
  scheduledUtc: UtcInstant;
  /** Actual administration UTC instant, if recorded. */
  administeredUtc: UtcInstant | null;
  status: DoseStatus;
}
