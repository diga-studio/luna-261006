import { test } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { DailyResult } from '../src/types';
import { formatDate } from '../src/dateutil';
import { recognizedAt } from './reference';
import {
  BASE, FILE_LIMIT, ITEMS, LAST_DAY, MODE_TIME_LIMIT_MS, RSS_LIMIT, TOTAL_DAYS,
  itemParams, refundParams, splitmix64,
} from './scale-data';

interface ModeStats {
  mode: string;
  elapsedMs: number;
  rssPeak: number;
  dbSize: number;
}

interface SerializedReport {
  from: string;
  to: string;
  totalRevenue: string;
  days: Array<{ date: string; revenue: string; deferred: string }>;
}

/** Each mode runs in its own process so its 60 s / 512 MiB budget is measured in isolation. */
function runMode(mode: string, tag: string): { stats: ModeStats; report: DailyResult[]; totalRevenue: bigint } {
  const dbPath = `/tmp/revledger-scale-${mode}-${tag}.db`;
  const reportPath = `/tmp/revledger-scale-${mode}-${tag}.json`;
  const runner = `${__dirname}/scale-runner.js`;
  const result = spawnSync(process.argv[0], ['--disable-warning=ExperimentalWarning', runner, mode, dbPath, reportPath], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.strictEqual(result.status, 0, `${mode} mode failed: ${result.stderr}`);
  const stats: ModeStats = JSON.parse(result.stdout.trim().split('\n').pop()!);
  const raw: SerializedReport = JSON.parse(readFileSync(reportPath, 'utf8'));
  const report: DailyResult[] = raw.days.map((d) => ({
    date: d.date,
    revenue: BigInt(d.revenue),
    deferred: BigInt(d.deferred),
  }));
  return { stats, report, totalRevenue: BigInt(raw.totalRevenue) };
}

/** Independent per-record recomputation of revenue and deferred for one day. */
function independentDay(day: number): { revenue: bigint; deferred: bigint } {
  let revenue = 0n;
  let deferred = 0n;
  for (let i = 0; i < ITEMS; i++) {
    const it = itemParams(i);
    let refunded = 0n;
    let prevRefunded = 0n;
    for (const j of [i, i + ITEMS]) {
      const r = refundParams(j);
      if (r.day <= day) refunded += r.amount;
      if (r.day <= day - 1) prevRefunded += r.amount;
    }
    const recognized = recognizedAt(it, refunded, day);
    const prevRecognized = recognizedAt(it, prevRefunded, day - 1);
    revenue += recognized - prevRecognized;
    if (day >= it.startDay) deferred += it.amount - refunded - recognized;
  }
  return { revenue, deferred };
}

test('large scale: bulk close and daily advance modes stay within limits and agree', () => {
  const tag = String(process.hrtime.bigint());
  const bulk = runMode('bulk', tag);
  console.log(
    `bulk mode:  ingest+close ${bulk.stats.elapsedMs} ms, peak RSS ${(bulk.stats.rssPeak / 1048576).toFixed(0)} MiB, db ${(bulk.stats.dbSize / 1048576).toFixed(1)} MiB`
  );
  assert.ok(bulk.stats.elapsedMs <= MODE_TIME_LIMIT_MS, `bulk mode exceeded ${MODE_TIME_LIMIT_MS} ms`);
  assert.ok(bulk.stats.rssPeak <= RSS_LIMIT, `bulk mode peak RSS exceeded 512 MiB: ${bulk.stats.rssPeak}`);
  assert.ok(bulk.stats.dbSize <= FILE_LIMIT, `bulk mode db files exceeded 512 MiB: ${bulk.stats.dbSize}`);

  const daily = runMode('daily', tag);
  console.log(
    `daily mode: ingest+close ${daily.stats.elapsedMs} ms, peak RSS ${(daily.stats.rssPeak / 1048576).toFixed(0)} MiB, db ${(daily.stats.dbSize / 1048576).toFixed(1)} MiB`
  );
  assert.ok(daily.stats.elapsedMs <= MODE_TIME_LIMIT_MS, `daily mode exceeded ${MODE_TIME_LIMIT_MS} ms`);
  assert.ok(daily.stats.rssPeak <= RSS_LIMIT, `daily mode peak RSS exceeded 512 MiB: ${daily.stats.rssPeak}`);
  assert.ok(daily.stats.dbSize <= FILE_LIMIT, `daily mode db files exceeded 512 MiB: ${daily.stats.dbSize}`);

  // The two modes must produce identical full daily reports.
  assert.strictEqual(bulk.report.length, TOTAL_DAYS);
  assert.strictEqual(daily.report.length, TOTAL_DAYS);
  assert.strictEqual(bulk.totalRevenue, daily.totalRevenue, 'range total revenue differs between modes');
  for (let d = 0; d < TOTAL_DAYS; d++) {
    const a = bulk.report[d];
    const b = daily.report[d];
    assert.strictEqual(a.date, b.date);
    assert.strictEqual(a.revenue, b.revenue, `revenue differs on ${a.date}`);
    assert.strictEqual(a.deferred, b.deferred, `deferred differs on ${a.date}`);
  }
  console.log(`full daily reports identical across modes; total revenue = ${bulk.totalRevenue}`);
  assert.ok(bulk.totalRevenue > 2n ** 53n, 'totals should exceed the JS safe integer range');

  // Spot-check sampled dates with an independent per-record calculation.
  const rnd = splitmix64(12345n);
  for (let s = 0; s < 40; s++) {
    const d = BASE + Number(rnd() % BigInt(TOTAL_DAYS));
    const expected = independentDay(d);
    const actual = bulk.report[d - BASE];
    assert.strictEqual(actual.date, formatDate(d));
    assert.strictEqual(actual.revenue, expected.revenue, `independent revenue mismatch on ${actual.date}`);
    assert.strictEqual(actual.deferred, expected.deferred, `independent deferred mismatch on ${actual.date}`);
  }
  console.log('40 spot-checked dates match independent per-record calculation');
});
