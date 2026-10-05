import { existsSync, statSync } from 'node:fs';
import { formatDate, parseDate } from '../src/dateutil';
import { PrepaidItem, Refund } from '../src/types';

// 30 years of consecutive business dates: 2024-01-01 .. 2053-12-31.
export const BASE = parseDate('2024-01-01');
export const TOTAL_DAYS = 10958;
export const LAST_DAY = BASE + TOTAL_DAYS - 1;
export const ITEMS = 300000;
export const LONG_ITEMS = 240000;
export const REFUNDS = 600000;
export const POST_SERVICE_REFUND_SPAN = 365;

export const MODE_TIME_LIMIT_MS = 60000;
export const RSS_LIMIT = 512 * 1024 * 1024;
export const FILE_LIMIT = 512 * 1024 * 1024;

export function splitmix64(seed: bigint): () => bigint {
  let state = seed;
  return () => {
    state = (state + 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & 0xffffffffffffffffn;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & 0xffffffffffffffffn;
    return z ^ (z >> 31n);
  };
}

export interface ItemParams {
  id: string;
  amount: bigint;
  startDay: number;
  endDay: number;
}

/** Deterministic per-index item generator (test data generation, never timed). */
export function itemParams(i: number): ItemParams {
  const rnd = splitmix64(BigInt(i) * 0x9e3779b97f4a7c15n + 1n);
  const days = i < LONG_ITEMS ? 3650 : 1 + Number(rnd() % 3649n);
  const maxOffset = TOTAL_DAYS - POST_SERVICE_REFUND_SPAN - days;
  const offset = Number(rnd() % BigInt(maxOffset + 1));
  const amount = 1000n + (rnd() % (10n ** 18n - 1000n));
  return { id: `item-${i}`, amount, startDay: BASE + offset, endDay: BASE + offset + days };
}

/** Deterministic per-index refund generator; refunds j and j+ITEMS belong to item j. */
export function refundParams(j: number): { itemId: string; amount: bigint; day: number } {
  const i = j % ITEMS;
  const it = itemParams(i);
  const rnd = splitmix64(BigInt(j) * 0xbf58476d1ce4e5b9n + 7n);
  const pct = 1n + (rnd() % 40n);
  const amount = (it.amount * pct) / 100n;
  let day: number;
  if (j < ITEMS) {
    day = it.startDay + Number(rnd() % BigInt(it.endDay - it.startDay));
  } else {
    day = it.endDay + Number(rnd() % BigInt(POST_SERVICE_REFUND_SPAN));
  }
  return { itemId: it.id, amount, day };
}

export function toItemRecord(p: ItemParams): PrepaidItem {
  return { id: p.id, amount: p.amount, startDate: formatDate(p.startDay), endDate: formatDate(p.endDay) };
}

export function toRefundRecord(r: { itemId: string; amount: bigint; day: number }): Refund {
  return { itemId: r.itemId, amount: r.amount, date: formatDate(r.day) };
}

export class Timer {
  elapsedMs = 0;
  time<T>(fn: () => T): T {
    const start = process.hrtime.bigint();
    try {
      return fn();
    } finally {
      this.elapsedMs += Number(process.hrtime.bigint() - start) / 1e6;
    }
  }
}

let rssPeak = 0;
export function sampleRss(): void {
  const rss = process.memoryUsage().rss;
  if (rss > rssPeak) rssPeak = rss;
}
export function rssPeakSoFar(): number {
  sampleRss();
  return rssPeak;
}

export function dbFileSize(path: string): number {
  let total = 0;
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    if (existsSync(path + suffix)) total += statSync(path + suffix).size;
  }
  return total;
}
