import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { UptimeStore } from '../src/index.js';
import type { SiteStats } from '../src/index.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const tempDirs: string[] = [];

function freshDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'uptime-store-'));
  tempDirs.push(dir);
  return join(dir, 'uptime.db');
}

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function onlySite(stats: SiteStats[], siteId: string): SiteStats {
  const found = stats.find((s) => s.siteId === siteId);
  assert.ok(found, `site ${siteId} missing from stats`);
  return found;
}

describe('acceptance case from the specification', () => {
  it('computes the exact 24h window durations', () => {
    const dbPath = freshDbPath();
    const store = new UptimeStore(dbPath);
    const S = 1_800_000_000_000; // arbitrary window start, UTC ms
    store.recordProbe({ siteId: 'site-1', finishedAt: S - 5 * MIN, online: true });
    store.recordProbe({ siteId: 'site-1', finishedAt: S + 2 * MIN, online: false });
    store.recordProbe({ siteId: 'site-1', finishedAt: S + 4 * MIN + 1, online: true });

    const stats = onlySite(store.getStats(S + DAY), 'site-1');
    assert.equal(stats.hours24.onlineMs, 720_000);
    assert.equal(stats.hours24.offlineMs, 120_001);
    assert.equal(stats.hours24.unknownMs, 85_559_999);
    assert.equal(
      stats.hours24.onlineMs + stats.hours24.offlineMs + stats.hours24.unknownMs,
      DAY,
    );
    store.close();
  });
});

describe('window semantics', () => {
  it('treats windows as start-inclusive and end-exclusive', () => {
    const dbPath = freshDbPath();
    const store = new UptimeStore(dbPath);
    const S = 1_800_000_000_000;
    // Online exactly at the window end must not count into that window.
    store.recordProbe({ siteId: 'edge', finishedAt: S + DAY, online: true });
    let stats = onlySite(store.getStats(S + DAY), 'edge');
    assert.equal(stats.hours24.onlineMs, 0);
    assert.equal(stats.hours24.unknownMs, DAY);
    // ...but it counts into the window that starts there.
    stats = onlySite(store.getStats(S + 2 * DAY), 'edge');
    assert.equal(stats.hours24.onlineMs, 10 * MIN);
    store.close();
  });

  it('returns a null ratio when no online/offline time is known', () => {
    const dbPath = freshDbPath();
    const store = new UptimeStore(dbPath);
    const S = 1_800_000_000_000;
    store.recordProbe({ siteId: 'brief', finishedAt: S, online: true });
    const stats = onlySite(store.getStats(S + DAY), 'brief');
    assert.equal(stats.hours24.onlineRatio, 10 * MIN / (10 * MIN));
    // 30d window: only 10 minutes known, ratio still defined; but a window
    // with zero known time must yield null, not 0 or 1.
    const far = onlySite(store.getStats(S + 40 * DAY), 'brief');
    assert.equal(far.hours24.onlineRatio, null);
    assert.equal(far.hours24.unknownMs, DAY);
    store.close();
  });

  it('sums to the window length for all three windows', () => {
    const dbPath = freshDbPath();
    const store = new UptimeStore(dbPath);
    const base = 1_800_000_000_000;
    // 40 days of alternating probes every 5 minutes for one site.
    for (let i = 0; i < 40 * 288; i += 1) {
      store.recordProbe({
        siteId: 'busy',
        finishedAt: base + i * 5 * MIN,
        online: i % 3 !== 0,
      });
    }
    const end = base + 40 * DAY;
    const stats = onlySite(store.getStats(end), 'busy');
    for (const win of [stats.hours24, stats.days7, stats.days30]) {
      const length =
        win === stats.hours24 ? DAY : win === stats.days7 ? 7 * DAY : 30 * DAY;
      assert.equal(win.onlineMs + win.offlineMs + win.unknownMs, length);
      assert.ok(win.onlineRatio !== null && win.onlineRatio > 0 && win.onlineRatio < 1);
    }
    store.close();
  });
});

describe('cleanup', () => {
  it('keeps a conclusion that starts before the horizon effective after it', () => {
    const dbPath = freshDbPath();
    const store = new UptimeStore(dbPath);
    const now = 1_800_000_000_000;
    const horizon = now - 90 * DAY;
    // Last probe before the horizon: online, still valid 5 minutes past it.
    store.recordProbe({ siteId: 's', finishedAt: horizon - 5 * MIN, online: true });
    store.recordProbe({ siteId: 's', finishedAt: horizon + 30 * MIN, online: false });

    const before = onlySite(store.getStats(horizon + DAY), 's');
    assert.equal(before.hours24.onlineMs, 5 * MIN);
    store.cleanup(now);
    const afterCleanup = onlySite(store.getStats(horizon + DAY), 's');
    assert.deepEqual(afterCleanup, before);
    store.close();
  });

  it('produces identical results before/after cleanup and across reopen', () => {
    const dbPath = freshDbPath();
    const store = new UptimeStore(dbPath);
    const now = 1_800_000_000_000;
    const horizon = now - 90 * DAY;
    // History older than the horizon plus recent data, two sites.
    for (let i = 0; i < 200; i += 1) {
      store.recordProbe({
        siteId: 'old',
        finishedAt: horizon - 200 * HOUR + i * HOUR,
        online: i % 2 === 0,
      });
    }
    for (let i = 0; i < 500; i += 1) {
      store.recordProbe({
        siteId: 'old',
        finishedAt: horizon + i * HOUR,
        online: i % 2 === 0,
      });
      store.recordProbe({
        siteId: 'new',
        finishedAt: horizon + i * HOUR,
        online: i % 5 !== 0,
      });
    }

    // All three windows of these ends lie fully inside the retained range.
    const ends = [horizon + 30 * DAY, horizon + 45 * DAY, now - 1];
    const before = ends.map((end) => store.getStats(end));
    store.cleanup(now);
    const afterCleanup = ends.map((end) => store.getStats(end));
    assert.deepEqual(afterCleanup, before);

    store.close();
    const reopened = new UptimeStore(dbPath);
    const afterReopen = ends.map((end) => reopened.getStats(end));
    assert.deepEqual(afterReopen, before);
    reopened.close();
  });

  it('only moves the horizon forward', () => {
    const dbPath = freshDbPath();
    const store = new UptimeStore(dbPath);
    const now = 1_800_000_000_000;
    const horizon = now - 90 * DAY;
    store.recordProbe({ siteId: 's', finishedAt: horizon - MIN, online: true });
    store.recordProbe({ siteId: 's', finishedAt: horizon + MIN, online: true });
    store.cleanup(now);
    // A cleanup with an earlier "now" must not resurrect deleted detail.
    store.cleanup(now - 10 * DAY);
    const stats = onlySite(store.getStats(horizon + DAY), 's');
    assert.equal(stats.hours24.onlineMs, 11 * MIN);
    store.close();
  });
});
