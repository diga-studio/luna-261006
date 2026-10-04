/** UTC epoch milliseconds. */
export type TimestampMs = number;

/** Conclusion of a single finished probe, supplied by the caller. */
export interface ProbeResult {
  siteId: string;
  /** UTC ms when the probe finished. */
  finishedAt: TimestampMs;
  /** true = online, false = offline. */
  online: boolean;
}

/** Accumulated durations inside one query window. All values in ms. */
export interface WindowStats {
  onlineMs: number;
  offlineMs: number;
  unknownMs: number;
  /** onlineMs / (onlineMs + offlineMs); null when the denominator is zero. */
  onlineRatio: number | null;
}

/** Statistics for one site across the three fixed windows. */
export interface SiteStats {
  siteId: string;
  hours24: WindowStats;
  days7: WindowStats;
  days30: WindowStats;
}
