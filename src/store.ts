import { DatabaseSync, StatementSync } from "node:sqlite";
import { openDatabase } from "./schema.js";
import {
  CONCLUSION_TTL_MS,
  DAY_MS,
  type ProbeStatus,
  type SiteStats,
  type WindowStats,
} from "./types.js";

const RETENTION_DAYS = 90;
const HOUR_MS = 3_600_000;
const STATUS_ONLINE = 1;
const STATUS_OFFLINE = 0;

interface ProbeRow {
  ts: number;
  status: number;
}

interface Durations {
  onlineMs: number;
  offlineMs: number;
}

/**
 * Uptime accounting store for a fleet of WordPress sites.
 *
 * Assumptions (guaranteed by the caller):
 * - calls are serialized (no concurrent access),
 * - results for a given site arrive with strictly increasing timestamps,
 * - results older than the current cleanup boundary are never submitted.
 *
 * Storage layout: raw probe records are kept for the whole retention
 * range; closed conclusion intervals are additionally folded into hourly
 * and daily aggregate buckets as they are recorded. A window query sums
 * whole days from `daily`, whole hours at the day edges from `hourly`,
 * and the sub-hour edges from raw `probe` rows, so arbitrary
 * millisecond-aligned windows stay exact without scanning much history.
 */
export class UptimeStore {
  private readonly db: DatabaseSync;
  private readonly sitePks = new Map<string, number>();
  private readonly stmtSiteInsert: StatementSync;
  private readonly stmtSites: StatementSync;
  private readonly stmtInsertProbe: StatementSync;
  private readonly stmtPrevProbe: StatementSync;
  private readonly stmtLatest: StatementSync;
  private readonly stmtUpsertDaily: StatementSync;
  private readonly stmtUpsertHourly: StatementSync;
  private readonly stmtCover: StatementSync;
  private readonly stmtRange: StatementSync;
  private readonly stmtSumDaily: StatementSync;
  private readonly stmtSumHourly: StatementSync;
  private readonly stmtGetMeta: StatementSync;
  private readonly stmtSetMeta: StatementSync;
  private readonly stmtDeleteExpired: StatementSync;
  private readonly stmtDeleteDaily: StatementSync;
  private readonly stmtDeleteHourly: StatementSync;
  private cutoff: number;

  constructor(path: string) {
    this.db = openDatabase(path);
    this.stmtSiteInsert = this.db.prepare(
      "INSERT INTO site (site_id) VALUES (?) ON CONFLICT (site_id) DO NOTHING",
    );
    this.stmtSites = this.db.prepare(
      "SELECT id, site_id FROM site ORDER BY site_id",
    );
    this.stmtInsertProbe = this.db.prepare(
      "INSERT INTO probe (site_pk, ts, status) VALUES (?, ?, ?)",
    );
    this.stmtPrevProbe = this.db.prepare(
      "SELECT ts, status FROM probe WHERE site_pk = ? AND ts < ? ORDER BY ts DESC LIMIT 1",
    );
    this.stmtLatest = this.db.prepare(
      "SELECT ts, status FROM probe WHERE site_pk = ? ORDER BY ts DESC LIMIT 1",
    );
    this.stmtUpsertDaily = this.db.prepare(
      `INSERT INTO daily (site_pk, day_start, online_ms, offline_ms)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (site_pk, day_start) DO UPDATE SET
         online_ms = online_ms + excluded.online_ms,
         offline_ms = offline_ms + excluded.offline_ms`,
    );
    this.stmtUpsertHourly = this.db.prepare(
      `INSERT INTO hourly (site_pk, hour_start, online_ms, offline_ms)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (site_pk, hour_start) DO UPDATE SET
         online_ms = online_ms + excluded.online_ms,
         offline_ms = offline_ms + excluded.offline_ms`,
    );
    this.stmtCover = this.db.prepare(
      "SELECT ts, status FROM probe WHERE site_pk = ? AND ts <= ? ORDER BY ts DESC LIMIT 1",
    );
    this.stmtRange = this.db.prepare(
      "SELECT ts, status FROM probe WHERE site_pk = ? AND ts > ? AND ts < ? ORDER BY ts",
    );
    this.stmtSumDaily = this.db.prepare(
      `SELECT COALESCE(SUM(online_ms), 0) AS online_ms,
              COALESCE(SUM(offline_ms), 0) AS offline_ms
       FROM daily WHERE site_pk = ? AND day_start >= ? AND day_start < ?`,
    );
    this.stmtSumHourly = this.db.prepare(
      `SELECT COALESCE(SUM(online_ms), 0) AS online_ms,
              COALESCE(SUM(offline_ms), 0) AS offline_ms
       FROM hourly WHERE site_pk = ? AND hour_start >= ? AND hour_start < ?`,
    );
    this.stmtGetMeta = this.db.prepare("SELECT value FROM meta WHERE key = ?");
    this.stmtSetMeta = this.db.prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    );
    this.stmtDeleteExpired = this.db.prepare(
      `DELETE FROM probe WHERE ts < ? AND rowid NOT IN (
         SELECT MAX(rowid) FROM probe WHERE ts < ? GROUP BY site_pk
       )`,
    );
    this.stmtDeleteDaily = this.db.prepare(
      "DELETE FROM daily WHERE day_start < ?",
    );
    this.stmtDeleteHourly = this.db.prepare(
      "DELETE FROM hourly WHERE hour_start < ?",
    );
    for (const row of this.stmtSites.all() as unknown as Array<{
      id: number;
      site_id: string;
    }>) {
      this.sitePks.set(row.site_id, Number(row.id));
    }
    const meta = this.stmtGetMeta.get("cutoff") as { value: number } | undefined;
    this.cutoff = meta ? Number(meta.value) : Number.MIN_SAFE_INTEGER;
  }

  /** Records one finished probe result. */
  record(siteId: string, completedAt: number, status: ProbeStatus): void {
    this.recordBatch([{ siteId, completedAt, status }]);
  }

  /**
   * Records many finished probe results in one transaction. Equivalent
   * to calling {@link record} for each entry in order; per site the
   * timestamps must be strictly increasing.
   */
  recordBatch(
    records: ReadonlyArray<{
      siteId: string;
      completedAt: number;
      status: ProbeStatus;
    }>,
  ): void {
    this.db.exec("BEGIN");
    try {
      for (const { siteId, completedAt, status } of records) {
        this.recordOne(siteId, completedAt, status);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private recordOne(
    siteId: string,
    completedAt: number,
    status: ProbeStatus,
  ): void {
    if (!Number.isSafeInteger(completedAt)) {
      throw new RangeError(
        "completedAt must be a safe integer millisecond timestamp",
      );
    }
    if (completedAt < this.cutoff) {
      throw new RangeError("completedAt is older than the cleanup boundary");
    }
    const sitePk = this.sitePk(siteId);
    const statusCode = status === "online" ? STATUS_ONLINE : STATUS_OFFLINE;
    const prev = this.stmtPrevProbe.get(sitePk, completedAt) as
      | ProbeRow
      | undefined;
    if (prev) {
      const until = Math.min(completedAt, Number(prev.ts) + CONCLUSION_TTL_MS);
      this.addToAggregates(sitePk, Number(prev.ts), until, Number(prev.status));
    }
    this.stmtInsertProbe.run(sitePk, completedAt, statusCode);
  }

  /**
   * Returns, for every known site, the online/offline/unknown durations
   * and uptime ratio for the 24h, 7d and 30d windows ending at `now`
   * (exclusive). The three durations of each window always sum to the
   * window length.
   */
  query(now: number): SiteStats[] {
    const result: SiteStats[] = [];
    for (const [siteId, sitePk] of this.sitePks) {
      const latestRow = this.stmtLatest.get(sitePk) as ProbeRow | undefined;
      const latest: ProbeRow = {
        ts: Number(latestRow!.ts),
        status: Number(latestRow!.status),
      };
      result.push({
        siteId,
        last24h: this.windowStats(sitePk, now - DAY_MS, now, latest),
        last7d: this.windowStats(sitePk, now - 7 * DAY_MS, now, latest),
        last30d: this.windowStats(sitePk, now - 30 * DAY_MS, now, latest),
      });
    }
    result.sort((a, b) => (a.siteId < b.siteId ? -1 : a.siteId > b.siteId ? 1 : 0));
    return result;
  }

  /**
   * Deletes probe detail older than `now - 90 days` while preserving the
   * state those records still imply for the retained range: the latest
   * record before the boundary is kept per site, so a conclusion that is
   * still in effect across the boundary is not lost. The boundary only
   * moves forward.
   */
  cleanup(now: number): void {
    const boundary = now - RETENTION_DAYS * DAY_MS;
    if (boundary <= this.cutoff) {
      return;
    }
    this.cutoff = boundary;
    this.db.exec("BEGIN");
    try {
      this.stmtSetMeta.run("cutoff", boundary);
      this.stmtDeleteExpired.run(boundary, boundary);
      this.stmtDeleteDaily.run(boundary);
      this.stmtDeleteHourly.run(boundary);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    this.db.exec("PRAGMA incremental_vacuum");
  }

  /** Flushes and closes the underlying database. */
  close(): void {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.db.close();
  }

  private sitePk(siteId: string): number {
    let pk = this.sitePks.get(siteId);
    if (pk === undefined) {
      this.stmtSiteInsert.run(siteId);
      const row = this.db
        .prepare("SELECT id FROM site WHERE site_id = ?")
        .get(siteId) as { id: number };
      pk = Number(row.id);
      this.sitePks.set(siteId, pk);
    }
    return pk;
  }

  /** Adds the interval [from, to) of `statusCode` into hourly/daily buckets. */
  private addToAggregates(
    sitePk: number,
    from: number,
    to: number,
    statusCode: number,
  ): void {
    let cursor = from;
    while (cursor < to) {
      const hourStart = Math.floor(cursor / HOUR_MS) * HOUR_MS;
      const segEnd = Math.min(to, hourStart + HOUR_MS);
      const len = segEnd - cursor;
      this.stmtUpsertHourly.run(
        sitePk,
        hourStart,
        statusCode === STATUS_ONLINE ? len : 0,
        statusCode === STATUS_OFFLINE ? len : 0,
      );
      cursor = segEnd;
    }
    cursor = from;
    while (cursor < to) {
      const dayStart = Math.floor(cursor / DAY_MS) * DAY_MS;
      const segEnd = Math.min(to, dayStart + DAY_MS);
      const len = segEnd - cursor;
      this.stmtUpsertDaily.run(
        sitePk,
        dayStart,
        statusCode === STATUS_ONLINE ? len : 0,
        statusCode === STATUS_OFFLINE ? len : 0,
      );
      cursor = segEnd;
    }
  }

  /**
   * Computes the three durations for the window [start, end).
   *
   * `latest` is the site's most recent probe record. Its effective
   * interval [ts, ts + TTL) is not yet reflected in the aggregates
   * (those only cover intervals closed by a successor), so its overlap
   * with the aggregated portion of the window is added separately.
   * Sub-hour edges are computed from raw probe records and already
   * include it.
   */
  private windowStats(
    sitePk: number,
    start: number,
    end: number,
    latest: ProbeRow,
  ): WindowStats {
    let onlineMs = 0;
    let offlineMs = 0;
    const add = (d: Durations) => {
      onlineMs += d.onlineMs;
      offlineMs += d.offlineMs;
    };
    const firstHour = Math.ceil(start / HOUR_MS) * HOUR_MS;
    const lastHour = Math.floor(end / HOUR_MS) * HOUR_MS;
    if (firstHour >= lastHour) {
      add(this.rangeDurations(sitePk, start, end));
    } else {
      add(this.rangeDurations(sitePk, start, firstHour));
      add(this.rangeDurations(sitePk, lastHour, end));
      add(this.aggregatedDurations(sitePk, firstHour, lastHour));
      const openStart = Math.max(latest.ts, firstHour);
      const openEnd = Math.min(latest.ts + CONCLUSION_TTL_MS, lastHour);
      if (openEnd > openStart) {
        if (latest.status === STATUS_ONLINE) {
          onlineMs += openEnd - openStart;
        } else {
          offlineMs += openEnd - openStart;
        }
      }
    }
    const total = end - start;
    const unknownMs = total - onlineMs - offlineMs;
    const known = onlineMs + offlineMs;
    return {
      onlineMs,
      offlineMs,
      unknownMs,
      uptimeRatio: known > 0 ? onlineMs / known : null,
    };
  }

  /**
   * Sums the aggregated range [from, to) (both hour-aligned) from the
   * daily table for whole days and the hourly table for the remaining
   * edge hours.
   */
  private aggregatedDurations(
    sitePk: number,
    from: number,
    to: number,
  ): Durations {
    let onlineMs = 0;
    let offlineMs = 0;
    const firstDay = Math.ceil(from / DAY_MS) * DAY_MS;
    const lastDay = Math.floor(to / DAY_MS) * DAY_MS;
    const hourRanges: Array<[number, number]> = [];
    if (firstDay < lastDay) {
      const days = this.stmtSumDaily.get(sitePk, firstDay, lastDay) as {
        online_ms: number;
        offline_ms: number;
      };
      onlineMs += Number(days.online_ms);
      offlineMs += Number(days.offline_ms);
      hourRanges.push([from, firstDay], [lastDay, to]);
    } else {
      hourRanges.push([from, to]);
    }
    for (const [a, b] of hourRanges) {
      if (b <= a) continue;
      const hours = this.stmtSumHourly.get(sitePk, a, b) as {
        online_ms: number;
        offline_ms: number;
      };
      onlineMs += Number(hours.online_ms);
      offlineMs += Number(hours.offline_ms);
    }
    return { onlineMs, offlineMs };
  }

  /**
   * Computes online/offline durations within [start, end) directly from
   * probe records. Used for the sub-hour edges of a window.
   */
  private rangeDurations(sitePk: number, start: number, end: number): Durations {
    const segments: ProbeRow[] = [];
    const cover = this.stmtCover.get(sitePk, start) as ProbeRow | undefined;
    if (cover) {
      segments.push({ ts: Number(cover.ts), status: Number(cover.status) });
    }
    const rows = this.stmtRange.all(sitePk, start, end) as unknown as ProbeRow[];
    for (const row of rows) {
      segments.push({ ts: Number(row.ts), status: Number(row.status) });
    }
    let onlineMs = 0;
    let offlineMs = 0;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const segStart = Math.max(seg.ts, start);
      const nextTs = i + 1 < segments.length ? segments[i + 1].ts : end;
      const segEnd = Math.min(seg.ts + CONCLUSION_TTL_MS, nextTs, end);
      if (segEnd > segStart) {
        if (seg.status === STATUS_ONLINE) {
          onlineMs += segEnd - segStart;
        } else {
          offlineMs += segEnd - segStart;
        }
      }
    }
    return { onlineMs, offlineMs };
  }
}
