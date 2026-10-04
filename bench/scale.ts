/**
 * Scale verification for the uptime store.
 *
 * Scenario: 500 sites, 90 days of history, one probe result per site
 * every ~5 minutes (~13M records). Verifies:
 *  - 20 queries at distinct historical timestamps, each returning all
 *    500 sites x 3 windows, complete within 5 seconds in total;
 *  - peak RSS during the query phase stays below 256 MiB;
 *  - window durations are exact (spot-checked against a reference model
 *    regenerated from deterministic seeds);
 *  - after continued recording and cleanup, the database file shrinks
 *    back to a size proportional to the retained range.
 *
 * Usage: node bench/scale.ts [--fresh] [--db <path>]
 *
 * Import and query phases run in separate processes (the memory budget
 * applies to the query phase, not the initial import).
 */
import { existsSync, rmSync, statSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { UptimeStore, DAY_MS, type SiteStats, type WindowStats } from "../dist/src/index.js";

const SITE_COUNT = 500;
const HISTORY_DAYS = 90;
const AVG_INTERVAL_MS = 5 * 60_000;
const QUERY_POINTS = 20;
const QUERY_BUDGET_MS = 5_000;
const RSS_BUDGET = 256 * 1024 * 1024;

interface Rec {
  ts: number;
  online: boolean;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic per-site history; regenerated on demand for checks. */
function genSiteHistory(siteIndex: number, startTs: number, endTs: number): Rec[] {
  const rand = mulberry32(siteIndex * 2654435761 + 12345);
  const recs: Rec[] = [];
  let ts = startTs;
  while (ts < endTs) {
    recs.push({ ts, online: rand() < 0.97 });
    ts += Math.floor(AVG_INTERVAL_MS * (0.5 + rand()));
  }
  return recs;
}

function refWindow(records: Rec[], s: number, e: number): WindowStats {
  let onlineMs = 0;
  let offlineMs = 0;
  for (let i = 0; i < records.length; i++) {
    const segStart = records[i].ts;
    const next = i + 1 < records.length ? records[i + 1].ts : Infinity;
    const segEnd = Math.min(next, segStart + 600_000);
    const a = Math.max(segStart, s);
    const b = Math.min(segEnd, e);
    if (b > a) {
      if (records[i].online) onlineMs += b - a;
      else offlineMs += b - a;
    }
  }
  const known = onlineMs + offlineMs;
  return {
    onlineMs,
    offlineMs,
    unknownMs: e - s - onlineMs - offlineMs,
    uptimeRatio: known > 0 ? onlineMs / known : null,
  };
}

function dbSize(path: string): number {
  return statSync(path).size;
}

function fmtBytes(n: number): string {
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

function assertWindowSums(stats: SiteStats[]): void {
  const windows: Array<[keyof SiteStats, number]> = [
    ["last24h", DAY_MS],
    ["last7d", 7 * DAY_MS],
    ["last30d", 30 * DAY_MS],
  ];
  for (const site of stats) {
    for (const [key, len] of windows) {
      const w = site[key] as WindowStats;
      const sum = w.onlineMs + w.offlineMs + w.unknownMs;
      if (sum !== len) {
        throw new Error(
          `window sum mismatch for ${site.siteId} ${String(key)}: ${sum} != ${len}`,
        );
      }
      if (w.onlineMs + w.offlineMs === 0 && w.uptimeRatio !== null) {
        throw new Error(`ratio must be null when no known time: ${site.siteId}`);
      }
    }
  }
}

function parseArgs(argv: string[]) {
  const fresh = argv.includes("--fresh");
  const dbFlag = argv.indexOf("--db");
  const dbPath = resolve(dbFlag >= 0 ? argv[dbFlag + 1] : "bench/scale.db");
  return { fresh, dbPath, argv };
}

function importPhase(dbPath: string, now: number): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  const historyStart = now - HISTORY_DAYS * DAY_MS;
  const store = new UptimeStore(dbPath);
  const t0 = Date.now();
  let total = 0;
  for (let s = 0; s < SITE_COUNT; s++) {
    const recs = genSiteHistory(s, historyStart, now);
    store.recordBatch(
      recs.map((r) => ({
        siteId: `site-${String(s).padStart(4, "0")}`,
        completedAt: r.ts,
        status: (r.online ? "online" : "offline") as "online" | "offline",
      })),
    );
    total += recs.length;
    if ((s + 1) % 50 === 0) {
      console.log(`imported ${s + 1}/${SITE_COUNT} sites (${total} records)`);
    }
  }
  console.log(
    `import done: ${total} records in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
  store.close();
}

function queryPhase(dbPath: string, now: number): void {
  const historyStart = now - HISTORY_DAYS * DAY_MS;
  const store = new UptimeStore(dbPath);

  // ---- Phase 2: timed queries at 20 historical timestamps ----
  const rand = mulberry32(999);
  const queryPoints: number[] = [];
  for (let q = 0; q < QUERY_POINTS; q++) {
    const offsetDays = 1 + rand() * (HISTORY_DAYS - 31);
    queryPoints.push(Math.floor(now - offsetDays * DAY_MS + rand() * DAY_MS));
  }
  queryPoints.push(now);

  if (globalThis.gc) globalThis.gc();
  const rssBefore = process.memoryUsage().rss;
  let rssPeak = rssBefore;
  const t0 = performance.now();
  let lastStats: SiteStats[] = [];
  for (const t of queryPoints) {
    lastStats = store.query(t);
    if (lastStats.length !== SITE_COUNT) {
      throw new Error(`expected ${SITE_COUNT} sites, got ${lastStats.length}`);
    }
    assertWindowSums(lastStats);
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
  }
  const queryMs = performance.now() - t0;
  console.log(
    `queries: ${queryPoints.length} x ${SITE_COUNT} sites x 3 windows in ${queryMs.toFixed(0)}ms`,
  );
  console.log(
    `rss: before=${fmtBytes(rssBefore)} peak=${fmtBytes(rssPeak)} (budget ${fmtBytes(RSS_BUDGET)})`,
  );
  if (queryMs > QUERY_BUDGET_MS) {
    throw new Error(`query budget exceeded: ${queryMs.toFixed(0)}ms > ${QUERY_BUDGET_MS}ms`);
  }
  if (rssPeak > RSS_BUDGET) {
    throw new Error(`rss budget exceeded: ${fmtBytes(rssPeak)}`);
  }

  // ---- Phase 3: spot-check exactness against the reference model ----
  for (const s of [0, 250, 499]) {
    const siteId = `site-${String(s).padStart(4, "0")}`;
    const recs = genSiteHistory(s, historyStart, now);
    for (const t of queryPoints.slice(0, 5)) {
      const stats = store.query(t).find((x) => x.siteId === siteId)!;
      const expected = refWindow(recs, t - DAY_MS, t);
      if (
        stats.last24h.onlineMs !== expected.onlineMs ||
        stats.last24h.offlineMs !== expected.offlineMs ||
        stats.last24h.unknownMs !== expected.unknownMs
      ) {
        throw new Error(
          `reference mismatch for ${siteId} @${t}: ` +
            `${JSON.stringify(stats.last24h)} != ${JSON.stringify(expected)}`,
        );
      }
    }
  }
  console.log("reference spot-checks passed");

  // ---- Phase 4: continued recording + cleanup keeps size proportional ----
  const sizeBefore = dbSize(dbPath);
  const extraDays = 7;
  for (let s = 0; s < SITE_COUNT; s++) {
    const recs = genSiteHistory(s, now, now + extraDays * DAY_MS);
    store.recordBatch(
      recs.map((r) => ({
        siteId: `site-${String(s).padStart(4, "0")}`,
        completedAt: r.ts,
        status: (r.online ? "online" : "offline") as "online" | "offline",
      })),
    );
  }
  const now2 = now + extraDays * DAY_MS;
  store.cleanup(now2);
  store.close();
  const sizeAfter = dbSize(dbPath);
  console.log(
    `db size: before extra 7d=${fmtBytes(sizeBefore)} after record+cleanup=${fmtBytes(sizeAfter)}`,
  );
  if (sizeAfter > sizeBefore * 1.2) {
    throw new Error(
      `database kept growing after cleanup: ${fmtBytes(sizeBefore)} -> ${fmtBytes(sizeAfter)}`,
    );
  }

  // ---- Phase 5: reopen and confirm queries still work post-cleanup ----
  const reopened = new UptimeStore(dbPath);
  const stats = reopened.query(now2);
  assertWindowSums(stats);
  if (stats.length !== SITE_COUNT) {
    throw new Error(`expected ${SITE_COUNT} sites after reopen`);
  }
  reopened.close();
  console.log("reopen check passed");
  console.log("SCALE VERIFICATION OK");
}

function main(): void {
  const { fresh, dbPath, argv } = parseArgs(process.argv.slice(2));
  const now = 2_000 * DAY_MS; // fixed arbitrary "current" time

  if (argv.includes("--import")) {
    importPhase(dbPath, now);
    return;
  }
  if (argv.includes("--query")) {
    queryPhase(dbPath, now);
    return;
  }
  if (fresh) {
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}.imported`, { force: true });
  }
  const self = process.argv[1];
  const dbArgs = ["--db", dbPath];
  if (fresh || !existsSync(`${dbPath}.imported`)) {
    const imp = spawnSync(
      process.execPath,
      ["--expose-gc", self, "--import", ...dbArgs],
      { stdio: "inherit" },
    );
    if (imp.status !== 0) process.exit(imp.status ?? 1);
    const { writeFileSync } = require("node:fs") as typeof import("node:fs");
    writeFileSync(`${dbPath}.imported`, "ok");
  } else {
    console.log("import skipped (existing database); use --fresh to reimport");
  }
  const qry = spawnSync(
    process.execPath,
    ["--expose-gc", self, "--query", ...dbArgs],
    { stdio: "inherit" },
  );
  process.exit(qry.status ?? 1);
}

main();
