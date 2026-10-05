import { parseDate, formatDate } from '../src/dateutil';
import { DailyResult, PrepaidItem, Refund } from '../src/types';

/**
 * Independent reference implementation: literal per-item, per-day
 * evaluation of the recognition formula. Used as the ground truth for
 * small-scale tests and for spot checks in the large-scale test.
 */

export interface RefItem {
  amount: bigint;
  startDay: number;
  endDay: number;
}

export interface RefRefund {
  day: number;
  amount: bigint;
}

/** Cumulative recognized amount for one item as of `day`. */
export function recognizedAt(item: RefItem, refunded: bigint, day: number): bigint {
  const days = item.endDay - item.startDay;
  const k = Math.min(Math.max(day - item.startDay + 1, 0), days);
  if (k === 0) return 0n;
  const net = item.amount - refunded;
  if (k === days) return net;
  return (net / BigInt(days)) * BigInt(k);
}

export function refundedAt(refunds: ReadonlyArray<RefRefund>, day: number): bigint {
  let total = 0n;
  for (const r of refunds) {
    if (r.day <= day) total += r.amount;
  }
  return total;
}

/** Daily revenue and deferred balance for one item on `day`. */
export function itemDay(
  item: RefItem,
  refunds: ReadonlyArray<RefRefund>,
  day: number
): { revenue: bigint; deferred: bigint } {
  const refunded = refundedAt(refunds, day);
  const recognized = recognizedAt(item, refunded, day);
  const prevRefunded = refundedAt(refunds, day - 1);
  const prevRecognized = recognizedAt(item, prevRefunded, day - 1);
  const revenue = recognized - prevRecognized;
  const effective = day >= item.startDay ? item.amount - refunded : 0n;
  return { revenue, deferred: effective - recognized };
}

/** Aggregate daily results for a set of items over [fromDay, toDay]. */
export function referenceRange(
  items: ReadonlyArray<{ item: RefItem; refunds: RefRefund[] }>,
  fromDay: number,
  toDay: number
): DailyResult[] {
  const out: DailyResult[] = [];
  for (let d = fromDay; d <= toDay; d++) {
    let revenue = 0n;
    let deferred = 0n;
    for (const { item, refunds } of items) {
      const r = itemDay(item, refunds, d);
      revenue += r.revenue;
      deferred += r.deferred;
    }
    out.push({ date: formatDate(d), revenue, deferred });
  }
  return out;
}

export function toRefItem(item: PrepaidItem): RefItem {
  return { amount: item.amount, startDay: parseDate(item.startDate), endDay: parseDate(item.endDate) };
}

export function toRefRefund(refund: Refund): RefRefund {
  return { day: parseDate(refund.date), amount: refund.amount };
}
