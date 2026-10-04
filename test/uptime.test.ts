import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  CONCLUSION_TTL_MS,
  DAY_MS,
  UptimeStore,
  type ProbeStatus,
  type WindowStats,
} from "../src/index.js";

interface Rec {
  ts: number;
  status: ProbeStatus;
}

function makeDbPath(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "uptime-test-"));
  return { dir, file: join(dir, "uptime.db") };
}

/** Naive reference: walks the full in-memory history for window [s, e). */
function refWindow(records: Rec[], s: number, e: number): WindowStats {
  let onlineMs = 0;
  let offlineMs = 0;
  for (let i = 0; i < records.length; i++) {
    const segStart = records[i].ts;
    const next = i + 1 < records.length ? records[i + 1].ts : Infinity;
    const segEnd = Math.min(next, segStart + CONCLUSION_TTL_MS);
    const a = Math.max(segStart, s);
    const b = Math.min(segEnd, e);
    if (b > a) {
      if (records[i].status === "online") onlineMs += b - a;
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

function assertWindowClose(actual: WindowStats, expected: WindowStats, ctx: string) {
  assert.equal(actual.onlineMs, expected.onlineMs, `${ctx} onlineMs`);
  assert.equal(actual.offlineMs, expected.offlineMs, `${ctx} offlineMs`);
  assert.equal(actual.unknownMs, expected.unknownMs, `${ctx} unknownMs`);
  if (expected.uptimeRatio === null) {
    assert.equal(actual.uptimeRatio, null, `${ctx} uptimeRatio`);
  } else {
    assert.ok(actual.uptimeRatio !== null, `${ctx} uptimeRatio not null`);
    assert.ok(
      Math.abs(actual.uptimeRatio - expected.uptimeRatio) < 1e-12,
      `${ctx} uptimeRatio ${actual.uptimeRatio} != ${expected.uptimeRatio}`,
    );
  }
}

test("acceptance: three results produce exact millisecond durations", () => {
  const { dir, file } = makeDbPath();
  try {
    const store = new UptimeStore(file);
    const now = 100 * DAY_MS;
    const s = now - DAY_MS; // 24h window start
    store.record("site-a", s - 5 * 60_000, "online");
    store.record("site-a", s + 2 * 60_000, "offline");
    store.record("site-a", s + 4 * 60_000 + 1, "online");
    const stats = store.query(now);
    assert.equal(stats.length, 1);
    assert.equal(stats[0].siteId, "site-a");
    assert.deepEqual(stats[0].last24h, {
      onlineMs: 720_000,
      offlineMs: 120_001,
      unknownMs: 85_559_999,
      uptimeRatio: 720_000 / 840_001,
    });
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown before first result and after expiry; ratio null without known time", () => {
  const { dir, file } = makeDbPath();
  try {
    const store = new UptimeStore(file);
    const t0 = 50 * DAY_MS;
    store.record("site-a", t0, "online");
    // conclusion expires at t0 + 10min; nothing afterwards
    const stats = store.query(t0 + DAY_MS);
    const w = stats[0].last24h;
    assert.equal(w.onlineMs, CONCLUSION_TTL_MS);
    assert.equal(w.offlineMs, 0);
    assert.equal(w.unknownMs, DAY_MS - CONCLUSION_TTL_MS);
    assert.equal(w.onlineMs + w.offlineMs + w.unknownMs, DAY_MS);
    assert.equal(w.uptimeRatio, 1);

    const store2 = new UptimeStore(file);
    store2.record("only-unknown-never-probed", 0, "offline");
    store2.close();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ratio is null when no online or offline time in window", () => {
  const { dir, file } = makeDbPath();
  try {
    const store = new UptimeStore(file);
    const t0 = 10 * DAY_MS;
    store.record("site-a", t0, "online");
    // query a window long after the conclusion expired
    const stats = store.query(t0 + 30 * DAY_MS);
    assert.equal(stats[0].last24h.uptimeRatio, null);
    assert.equal(stats[0].last24h.onlineMs, 0);
    assert.equal(stats[0].last24h.offlineMs, 0);
    assert.equal(stats[0].last24h.unknownMs, DAY_MS);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Builds a deterministic pseudo-random history per site. */
function genHistory(seed: number, count: number, startTs: number): Rec[] {
  let state = seed >>> 0;
  const rand = () => {
    state = (state * 1103515245 + 12345) >>> 0;
    return state / 0xffffffff;
  };
  const recs: Rec[] = [];
  let ts = startTs;
  for (let i = 0; i < count; i++) {
    ts += 60_000 + Math.floor(rand() * 29 * 60_000); // 1..30 min gaps
    recs.push({ ts, status: rand() < 0.8 ? "online" : "offline" });
  }
  return recs;
}

test("random histories match the reference model across windows", () => {
  const { dir, file } = makeDbPath();
  try {
    const store = new UptimeStore(file);
    const sites = new Map<string, Rec[]>();
    const base = 200 * DAY_MS;
    for (let s = 0; s < 8; s++) {
      const recs = genHistory(s + 1, 400, base);
      sites.set(`site-${s}`, recs);
      for (const r of recs) store.record(`site-${s}`, r.ts, r.status);
    }
    const lastTs = Math.max(
      ...[...sites.values()].map((r) => r[r.length - 1].ts),
    );
    for (let q = 0; q < 10; q++) {
      const now = base + Math.floor(((q + 1) / 10) * (lastTs - base));
      const stats = store.query(now);
      assert.equal(stats.length, sites.size);
      for (const siteStats of stats) {
        const recs = sites.get(siteStats.siteId)!;
        const ctx = `${siteStats.siteId} @${now}`;
        assertWindowClose(siteStats.last24h, refWindow(recs, now - DAY_MS, now), `${ctx} 24h`);
        assertWindowClose(siteStats.last7d, refWindow(recs, now - 7 * DAY_MS, now), `${ctx} 7d`);
        assertWindowClose(siteStats.last30d, refWindow(recs, now - 30 * DAY_MS, now), `${ctx} 30d`);
      }
    }
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanup keeps retained-range queries identical, incl. boundary-crossing conclusion", () => {
  const { dir, file } = makeDbPath();
  try {
    const store = new UptimeStore(file);
    const base = 1_000 * DAY_MS;
    // site-a: dense history; its last record before the cleanup boundary
    // lands 3 minutes before it and stays in effect across the boundary.
    const recsA: Rec[] = [];
    for (let t = base; t < base + 100 * DAY_MS; t += 5 * 60_000) {
      recsA.push({ ts: t, status: t % (20 * 60_000) === 0 ? "offline" : "online" });
    }
    const now = base + 100 * DAY_MS;
    const cutoff = now - 90 * DAY_MS;
    // ensure a record exactly 3 minutes before the boundary, then a gap
    recsA.push({ ts: cutoff - 3 * 60_000, status: "online" });
    recsA.push({ ts: cutoff + 20 * 60_000, status: "offline" });
    recsA.sort((a, b) => a.ts - b.ts);
    for (const r of recsA) store.record("site-a", r.ts, r.status);

    // site-b: sparse history, long unknown gaps
    const recsB: Rec[] = [
      { ts: base + 95 * DAY_MS, status: "offline" },
      { ts: base + 99 * DAY_MS, status: "online" },
    ];
    for (const r of recsB) store.record("site-b", r.ts, r.status);

    const histories = new Map<string, Rec[]>([
      ["site-a", recsA],
      ["site-b", recsB],
    ]);

    // queries fully inside the retained range [cutoff, now]
    const queryPoints: number[] = [];
    for (let q = 0; q < 8; q++) {
      queryPoints.push(cutoff + 30 * DAY_MS + q * 7 * DAY_MS + 123_456);
    }
    queryPoints.push(now);

    const before = queryPoints.map((t) => store.query(t));
    store.cleanup(now);
    const after = queryPoints.map((t) => store.query(t));

    for (let q = 0; q < queryPoints.length; q++) {
      const t = queryPoints[q];
      assert.ok(t - 30 * DAY_MS >= cutoff, "test window must stay in retained range");
      for (const siteStats of after[q]) {
        const recs = histories.get(siteStats.siteId)!;
        const ctx = `${siteStats.siteId} @${t} post-cleanup`;
        assertWindowClose(siteStats.last24h, refWindow(recs, t - DAY_MS, t), `${ctx} 24h`);
        assertWindowClose(siteStats.last7d, refWindow(recs, t - 7 * DAY_MS, t), `${ctx} 7d`);
        assertWindowClose(siteStats.last30d, refWindow(recs, t - 30 * DAY_MS, t), `${ctx} 30d`);
      }
      assert.deepEqual(after[q], before[q], `query @${t} unchanged by cleanup`);
    }

    // expired probe detail is actually deleted; only boundary records remain
    const raw = new DatabaseSync(file);
    const leftover = raw
      .prepare("SELECT COUNT(*) AS n FROM probe WHERE ts < ?")
      .get(cutoff) as { n: number };
    assert.ok(
      Number(leftover.n) <= 2,
      `expected only boundary records below cutoff, got ${leftover.n}`,
    );
    const dailyLeft = raw
      .prepare("SELECT COUNT(*) AS n FROM daily WHERE day_start < ?")
      .get(cutoff) as { n: number };
    assert.equal(Number(dailyLeft.n), 0, "expired daily aggregates deleted");
    raw.close();

    // close + reopen preserves query semantics
    store.close();
    const reopened = new UptimeStore(file);
    const afterReopen = queryPoints.map((t) => reopened.query(t));
    assert.deepEqual(afterReopen, after, "reopen preserves results");

    // cleanup boundary never moves backwards
    reopened.cleanup(now - 10 * DAY_MS);
    const afterBackward = queryPoints.map((t) => reopened.query(t));
    assert.deepEqual(afterBackward, after, "backward cleanup is a no-op");
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("record rejects timestamps older than the cleanup boundary", () => {
  const { dir, file } = makeDbPath();
  try {
    const store = new UptimeStore(file);
    const now = 200 * DAY_MS;
    store.record("site-a", now - 60_000, "online");
    store.cleanup(now);
    assert.throws(
      () => store.record("site-a", now - 91 * DAY_MS, "online"),
      /cleanup boundary/,
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
