import { DatabaseSync } from 'node:sqlite';
import {
  DAY_MS,
  getCleanupHorizon,
  openDatabase,
  RETENTION_MS,
  setCleanupHorizon,
  VALIDITY_MS,
} from './db.js';
import type { ProbeResult, SiteStats, WindowStats } from './types.js';

const WINDOWS: ReadonlyArray<{ key: 'hours24' | 'days7' | 'days30'; lengthMs: number }> = [
  { key: 'hours24', lengthMs: DAY_MS },
  { key: 'days7', lengthMs: 7 * DAY_MS },
  { key: 'days30', lengthMs: 30 * DAY_MS },
];

function makeWindowStats(
  lengthMs: number,
  onlineMs: number,
  offlineMs: number,
): WindowStats {
  const knownMs = onlineMs + offlineMs;
  return {
    onlineMs,
    offlineMs,
    unknownMs: lengthMs - knownMs,
    onlineRatio: knownMs === 0 ? null : onlineMs / knownMs,
  };
}

interface LastSegment {
  id: number;
  end: number;
  state: number;
}

/**
 * Uptime accounting store backed by a local SQLite database.
 * Assumes serial callers and per-site strictly increasing probe timestamps.
 */
export class UptimeStore {
  private readonly db: DatabaseSync;
  private readonly stmtInsertProbe;
  private readonly stmtLastSegment;
  private readonly stmtUpdateSegmentEnd;
  private readonly stmtInsertSegment;
  private readonly stmtInsertSite;
  private readonly stmtSiteIds;
  private readonly stmtWindowSums;
  private readonly stmtDeleteExpiredProbes;
  private readonly stmtDeleteExpiredSegments;
  private readonly lastSegments = new Map<string, LastSegment>();

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
    this.stmtInsertProbe = this.db.prepare(
      'INSERT INTO probes (site_id, ts, online) VALUES (?, ?, ?)',
    );
    this.stmtLastSegment = this.db.prepare(
      'SELECT id, end, state FROM segments ' +
        'WHERE site_id = ? ORDER BY start DESC LIMIT 1',
    );
    this.stmtUpdateSegmentEnd = this.db.prepare(
      'UPDATE segments SET end = ? WHERE id = ?',
    );
    this.stmtInsertSegment = this.db.prepare(
      'INSERT INTO segments (site_id, start, end, state) VALUES (?, ?, ?, ?)',
    );
    this.stmtInsertSite = this.db.prepare(
      'INSERT OR IGNORE INTO sites (site_id) VALUES (?)',
    );
    this.stmtSiteIds = this.db.prepare('SELECT site_id FROM sites ORDER BY site_id');
    // One scan of the 30d segment range per site; each window's overlap is
    // clipped with scalar MIN/MAX and filtered by a CASE guard.
    const windowSum = (state: number, prefix: string) =>
      WINDOWS.map(
        (w) =>
          `SUM(CASE WHEN state = ${state} AND start < ? AND end > ? ` +
          `THEN MIN(end, ?) - MAX(start, ?) ELSE 0 END) AS ${prefix}_${w.key}`,
      ).join(', ');
    this.stmtWindowSums = this.db.prepare(
      `SELECT ${windowSum(1, 'on')}, ${windowSum(0, 'off')} FROM segments ` +
        'WHERE site_id = ? AND start < ? AND end > ?',
    );
    // Keep, per site, the latest probe below the horizon: its conclusion may
    // still be in effect inside the retained range.
    this.stmtDeleteExpiredProbes = this.db.prepare(
      'DELETE FROM probes WHERE ts < ? AND (site_id, ts) NOT IN ' +
        '(SELECT site_id, MAX(ts) FROM probes WHERE ts < ? GROUP BY site_id)',
    );
    this.stmtDeleteExpiredSegments = this.db.prepare(
      'DELETE FROM segments WHERE end <= ?',
    );
  }

  /** Ingest one finished probe result. */
  recordProbe(result: ProbeResult): void {
    const { siteId, finishedAt, online } = result;
    const state = online ? 1 : 0;
    this.stmtInsertProbe.run(siteId, finishedAt, state);

    let last = this.lastSegments.get(siteId);
    if (last === undefined) {
      this.stmtInsertSite.run(siteId);
      const row = this.stmtLastSegment.get(siteId) as
        | { id: number; end: number; state: number }
        | undefined;
      if (row !== undefined) {
        last = { id: Number(row.id), end: Number(row.end), state: Number(row.state) };
        this.lastSegments.set(siteId, last);
      }
    }
    const tentativeEnd = finishedAt + VALIDITY_MS;
    if (last === undefined) {
      const info = this.stmtInsertSegment.run(siteId, finishedAt, tentativeEnd, state);
      this.lastSegments.set(siteId, {
        id: Number(info.lastInsertRowid),
        end: tentativeEnd,
        state,
      });
      return;
    }
    // The previous segment's stored end is tentative (start + validity);
    // the new probe caps it at `finishedAt` if that comes first.
    const cappedEnd = Math.min(last.end, finishedAt);
    if (cappedEnd === finishedAt && last.state === state) {
      // Contiguous same state: extend the existing segment instead.
      this.stmtUpdateSegmentEnd.run(tentativeEnd, last.id);
      last.end = tentativeEnd;
      return;
    }
    if (cappedEnd !== last.end) {
      this.stmtUpdateSegmentEnd.run(cappedEnd, last.id);
    }
    const info = this.stmtInsertSegment.run(siteId, finishedAt, tentativeEnd, state);
    this.lastSegments.set(siteId, {
      id: Number(info.lastInsertRowid),
      end: tentativeEnd,
      state,
    });
  }

  /** Ingest a batch of probe results inside a single transaction. */
  recordProbes(results: Iterable<ProbeResult>): void {
    this.db.exec('BEGIN');
    try {
      for (const result of results) {
        this.recordProbe(result);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Statistics for every known site over the 24h / 7d / 30d windows
   * ending at `endAt` (start-inclusive, end-exclusive).
   */
  getStats(endAt: number): SiteStats[] {
    const siteIds = (this.stmtSiteIds.all() as Array<{ site_id: string }>).map(
      (row) => row.site_id,
    );
    const result: SiteStats[] = [];
    for (const siteId of siteIds) {
      const starts = WINDOWS.map((w) => endAt - w.lengthMs);
      const windowParams = starts.flatMap((start) => [endAt, start, endAt, start]);
      const row = this.stmtWindowSums.get(
        ...windowParams,
        ...windowParams,
        siteId,
        endAt,
        starts[2],
      ) as Record<string, number | null>;
      const stats: SiteStats = { siteId } as SiteStats;
      for (const w of WINDOWS) {
        stats[w.key] = makeWindowStats(
          w.lengthMs,
          Number(row[`on_${w.key}`] ?? 0),
          Number(row[`off_${w.key}`] ?? 0),
        );
      }
      result.push(stats);
    }
    return result;
  }

  /**
   * Delete probe details older than `now - 90 days`. The boundary only
   * moves forward; state influence on the retained range is preserved.
   */
  cleanup(now: number): void {
    const previous = getCleanupHorizon(this.db);
    const horizon = now - RETENTION_MS;
    if (horizon <= previous) {
      return; // The boundary only moves forward.
    }
    this.db.exec('BEGIN');
    try {
      this.stmtDeleteExpiredProbes.run(horizon, horizon);
      this.stmtDeleteExpiredSegments.run(horizon);
      setCleanupHorizon(this.db, horizon);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.db.exec('PRAGMA incremental_vacuum');
  }

  /** Flush and close the database. */
  close(): void {
    this.db.close();
  }
}
