export interface TimeWindow {
  /** Local "HH:mm", inclusive. */
  start: string;
  /** Local "HH:mm", exclusive; "24:00" allowed. */
  end: string;
}

export interface BusinessCalendar {
  /** IANA time zone name, e.g. "America/New_York". */
  timeZone: string;
  /** Weekly windows keyed by weekday, 0 = Sunday .. 6 = Saturday. */
  weekly: { [weekday: number]: TimeWindow[] };
  /** Whole-day overrides keyed by local "YYYY-MM-DD"; [] means closed. */
  exceptions?: { [localDate: string]: TimeWindow[] };
}

export interface LeadInspection {
  /** Business milliseconds accumulated before the effective stop instant. */
  elapsedMs: number;
  /** Whether the lead has ever exceeded the SLA budget as of `asOf`. */
  timedOut: boolean;
}
