/** Probe conclusion for a single site, as reported by the caller. */
export type ProbeStatus = "online" | "offline";

/** Milliseconds in one day; a "day" is fixed at 24 hours. */
export const DAY_MS = 86_400_000;

/** A probe conclusion stays valid for at most this long after completion. */
export const CONCLUSION_TTL_MS = 600_000;

/** Statistics for one query window. All durations are milliseconds. */
export interface WindowStats {
  onlineMs: number;
  offlineMs: number;
  unknownMs: number;
  /**
   * onlineMs / (onlineMs + offlineMs), or null when the denominator is
   * zero (no usable ratio; never reported as 0 or 1).
   */
  uptimeRatio: number | null;
}

/** Statistics for one site across the three fixed windows. */
export interface SiteStats {
  siteId: string;
  last24h: WindowStats;
  last7d: WindowStats;
  last30d: WindowStats;
}
