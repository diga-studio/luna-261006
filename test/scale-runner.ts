/**
 * Runs one large-scale mode in its own process (each mode is measured
 * against its own 60 s / 512 MiB budget). Usage:
 *   node scale-runner.js <bulk|daily> <dbPath> <reportPath>
 * Prints a JSON stats line on stdout.
 */
import { writeFileSync } from 'node:fs';
import { RevenueLedger } from '../src/index';
import { PrepaidItem, RangeReport, Refund } from '../src/types';
import { formatDate } from '../src/dateutil';
import {
  BASE, ITEMS, LAST_DAY, REFUNDS, TOTAL_DAYS, Timer,
  dbFileSize, itemParams, refundParams, rssPeakSoFar, sampleRss, toItemRecord, toRefundRecord,
} from './scale-data';

function runBulk(ledger: RevenueLedger, timer: Timer): void {
  const BATCH = 25000;
  for (let lo = 0; lo < ITEMS; lo += BATCH) {
    const batch: PrepaidItem[] = [];
    for (let i = lo; i < Math.min(lo + BATCH, ITEMS); i++) batch.push(toItemRecord(itemParams(i)));
    timer.time(() => ledger.ingestItems(batch));
    sampleRss();
  }
  for (let lo = 0; lo < REFUNDS; lo += BATCH) {
    const batch: Refund[] = [];
    for (let j = lo; j < Math.min(lo + BATCH, REFUNDS); j++) batch.push(toRefundRecord(refundParams(j)));
    timer.time(() => ledger.ingestRefunds(batch));
    sampleRss();
  }
  timer.time(() => ledger.closeTo(formatDate(LAST_DAY)));
}

function runDaily(ledger: RevenueLedger, timer: Timer): void {
  // Bucket indexes by registration day (data generation, not timed).
  const itemBuckets: number[][] = new Array(TOTAL_DAYS);
  for (let i = 0; i < ITEMS; i++) {
    const p = itemParams(i);
    (itemBuckets[p.startDay - BASE] ??= []).push(i);
  }
  const refundBuckets: number[][] = new Array(TOTAL_DAYS);
  for (let j = 0; j < REFUNDS; j++) {
    const r = refundParams(j);
    const it = itemParams(j % ITEMS);
    // Registered ahead of the effective date, never before the item exists.
    const reg = Math.max(it.startDay, r.day - 1 - (j % 31));
    (refundBuckets[reg - BASE] ??= []).push(j);
  }
  sampleRss();

  for (let d = 0; d < TOTAL_DAYS; d++) {
    const itemIdx = itemBuckets[d];
    if (itemIdx) {
      const batch = itemIdx.map((i) => toItemRecord(itemParams(i)));
      timer.time(() => ledger.ingestItems(batch));
    }
    const refundIdx = refundBuckets[d];
    if (refundIdx) {
      const batch = refundIdx.map((j) => toRefundRecord(refundParams(j)));
      timer.time(() => ledger.ingestRefunds(batch));
    }
    timer.time(() => ledger.closeTo(formatDate(BASE + d)));
    if (d % 365 === 0) sampleRss();
  }
}

function main(): void {
  const [, , mode, dbPath, reportPath] = process.argv;
  const timer = new Timer();
  const ledger = new RevenueLedger(dbPath);
  if (mode === 'bulk') runBulk(ledger, timer);
  else if (mode === 'daily') runDaily(ledger, timer);
  else throw new Error(`unknown mode: ${mode}`);
  sampleRss();
  const report: RangeReport = ledger.exportRange(formatDate(BASE), formatDate(LAST_DAY));
  sampleRss();
  ledger.close();

  const stats = {
    mode,
    elapsedMs: Math.round(timer.elapsedMs),
    rssPeak: rssPeakSoFar(),
    dbSize: dbFileSize(dbPath),
  };
  writeFileSync(reportPath, JSON.stringify(report, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)));
  console.log(JSON.stringify(stats));
}

main();
