import { test } from 'node:test';
import * as assert from 'node:assert';
import { RevenueLedger } from '../src/index';
import { PrepaidItem, Refund } from '../src/types';
import { parseDate } from '../src/dateutil';
import { referenceRange, toRefItem, toRefRefund } from './reference';

let counter = 0;
function freshDb(): string {
  counter += 1;
  return `/tmp/revledger-small-${process.hrtime.bigint()}-${counter}.db`;
}

function openLedger(): { ledger: RevenueLedger; path: string } {
  const path = freshDb();
  return { ledger: new RevenueLedger(path), path };
}

function checkAgainstReference(
  ledger: RevenueLedger,
  items: PrepaidItem[],
  refunds: Refund[],
  from: string,
  to: string
): void {
  const report = ledger.exportRange(from, to);
  const expected = referenceRange(
    items.map((it) => ({ item: toRefItem(it), refunds: refunds.filter((r) => r.itemId === it.id).map(toRefRefund) })),
    parseDate(from),
    parseDate(to)
  );
  assert.strictEqual(report.days.length, expected.length);
  let sum = 0n;
  for (let i = 0; i < expected.length; i++) {
    assert.strictEqual(report.days[i].date, expected[i].date);
    assert.strictEqual(report.days[i].revenue, expected[i].revenue, `revenue on ${expected[i].date}`);
    assert.strictEqual(report.days[i].deferred, expected[i].deferred, `deferred on ${expected[i].date}`);
    sum += expected[i].revenue;
  }
  assert.strictEqual(report.totalRevenue, sum, 'range total revenue');
}

test('tail remainder lands on the last service day', () => {
  const { ledger } = openLedger();
  ledger.ingestItems([{ id: 'a', amount: 100n, startDate: '2024-03-01', endDate: '2024-03-04' }]);
  ledger.closeTo('2024-03-10');
  const report = ledger.exportRange('2024-03-01', '2024-03-06');
  assert.deepStrictEqual(
    report.days.map((d) => d.revenue),
    [33n, 33n, 34n, 0n, 0n, 0n]
  );
  assert.strictEqual(report.days[2].deferred, 0n);
  ledger.close();
});

test('out-of-order and same-day split refunds match the reference', () => {
  const { ledger } = openLedger();
  const items: PrepaidItem[] = [
    { id: 'a', amount: 1000n, startDate: '2024-01-01', endDate: '2024-02-01' },
    { id: 'b', amount: 7n, startDate: '2023-12-15', endDate: '2024-01-15' },
  ];
  ledger.ingestItems(items);
  const refunds: Refund[] = [
    { itemId: 'a', amount: 100n, date: '2024-01-20' },
    { itemId: 'a', amount: 50n, date: '2024-01-10' },
    { itemId: 'a', amount: 60n, date: '2024-01-10' },
    { itemId: 'a', amount: 200n, date: '2024-03-01' },
    { itemId: 'b', amount: 3n, date: '2024-01-01' },
    { itemId: 'b', amount: 4n, date: '2024-02-01' },
  ];
  // Deliberately shuffled, split across batches, same-day refunds in different batches.
  ledger.ingestRefunds([refunds[0], refunds[3]]);
  ledger.ingestRefunds([refunds[5]]);
  ledger.ingestRefunds([refunds[2], refunds[4]]);
  ledger.ingestRefunds([refunds[1]]);
  ledger.closeTo('2024-03-15');
  checkAgainstReference(ledger, items, refunds, '2023-12-15', '2023-12-31');
  checkAgainstReference(ledger, items, refunds, '2024-01-01', '2024-03-15');
  ledger.close();
});

test('full refund after service end only cuts revenue, never creates deferred balance', () => {
  const { ledger } = openLedger();
  const items: PrepaidItem[] = [{ id: 'a', amount: 500n, startDate: '2024-01-01', endDate: '2024-01-11' }];
  const refunds: Refund[] = [{ itemId: 'a', amount: 500n, date: '2024-02-01' }];
  ledger.ingestItems(items);
  ledger.ingestRefunds(refunds);
  ledger.closeTo('2024-02-05');
  const report = ledger.exportRange('2024-01-01', '2024-02-05');
  const refundDay = report.days.find((d) => d.date === '2024-02-01')!;
  assert.strictEqual(refundDay.revenue, -500n);
  assert.strictEqual(refundDay.deferred, 0n);
  for (const d of report.days) {
    assert.ok(d.deferred >= 0n, `deferred never negative: ${d.date}`);
  }
  checkAgainstReference(ledger, items, refunds, '2024-01-01', '2024-02-05');
  ledger.close();
});

test('prepaid minus refunds equals cumulative revenue plus deferred, every day', () => {
  const { ledger } = openLedger();
  const items: PrepaidItem[] = [
    { id: 'a', amount: 999999999999999999n, startDate: '2024-01-01', endDate: '2025-01-01' },
    { id: 'b', amount: 12345n, startDate: '2024-06-01', endDate: '2024-06-11' },
    { id: 'c', amount: 5n, startDate: '2024-06-05', endDate: '2024-06-06' },
  ];
  const refunds: Refund[] = [
    { itemId: 'a', amount: 99999999999999999n, date: '2024-07-01' },
    { itemId: 'b', amount: 2345n, date: '2024-06-03' },
    { itemId: 'b', amount: 10000n, date: '2024-07-01' },
    { itemId: 'c', amount: 5n, date: '2024-06-05' },
  ];
  ledger.ingestItems(items);
  ledger.ingestRefunds(refunds);
  ledger.closeTo('2024-12-31');
  const report = ledger.exportRange('2024-01-01', '2024-12-31');
  let cumulativeRevenue = 0n;
  for (const d of report.days) {
    cumulativeRevenue += d.revenue;
    const day = parseDate(d.date);
    let prepaidMinusRefunds = 0n;
    for (const it of items) {
      if (parseDate(it.startDate) <= day) prepaidMinusRefunds += it.amount;
    }
    for (const r of refunds) {
      if (parseDate(r.date) <= day) prepaidMinusRefunds -= r.amount;
    }
    assert.strictEqual(prepaidMinusRefunds, cumulativeRevenue + d.deferred, `identity on ${d.date}`);
  }
  ledger.close();
});

test('one-shot close and multi-step close produce identical daily results', () => {
  const items: PrepaidItem[] = [
    { id: 'a', amount: 100000n, startDate: '2024-01-01', endDate: '2025-01-01' },
    { id: 'b', amount: 777n, startDate: '2024-03-01', endDate: '2024-04-01' },
    { id: 'c', amount: 42n, startDate: '2024-02-15', endDate: '2024-02-16' },
  ];
  const refunds: Refund[] = [
    { itemId: 'a', amount: 30000n, date: '2024-05-01' },
    { itemId: 'a', amount: 20000n, date: '2024-02-01' },
    { itemId: 'b', amount: 111n, date: '2024-03-20' },
    { itemId: 'b', amount: 111n, date: '2024-05-01' },
    { itemId: 'c', amount: 40n, date: '2024-02-15' },
  ];

  // Ledger 1: everything in one batch, single close.
  const one = openLedger();
  one.ledger.ingestItems(items);
  one.ledger.ingestRefunds(refunds);
  one.ledger.closeTo('2024-12-31');

  // Ledger 2: shuffled batches, irregular close steps.
  const two = openLedger();
  two.ledger.ingestItems([items[2]]);
  two.ledger.ingestItems([items[0], items[1]]);
  two.ledger.ingestRefunds([refunds[1], refunds[4]]);
  two.ledger.closeTo('2024-01-31');
  two.ledger.ingestRefunds([refunds[3]]);
  two.ledger.closeTo('2024-02-29');
  two.ledger.ingestRefunds([refunds[0], refunds[2]]);
  for (const date of ['2024-03-31', '2024-04-30', '2024-05-31', '2024-06-30']) {
    two.ledger.closeTo(date);
  }
  two.ledger.closeTo('2024-12-31');

  const r1 = one.ledger.exportRange('2024-01-01', '2024-12-31');
  const r2 = two.ledger.exportRange('2024-01-01', '2024-12-31');
  assert.strictEqual(r1.totalRevenue, r2.totalRevenue);
  assert.strictEqual(r1.days.length, r2.days.length);
  for (let i = 0; i < r1.days.length; i++) {
    assert.strictEqual(r1.days[i].revenue, r2.days[i].revenue, `revenue on ${r1.days[i].date}`);
    assert.strictEqual(r1.days[i].deferred, r2.days[i].deferred, `deferred on ${r1.days[i].date}`);
  }
  checkAgainstReference(one.ledger, items, refunds, '2024-01-01', '2024-12-31');
  one.ledger.close();
  two.ledger.close();
});

test('validation rejects invalid input and retroactive events', () => {
  const { ledger } = openLedger();
  const item: PrepaidItem = { id: 'a', amount: 100n, startDate: '2024-01-01', endDate: '2024-01-11' };
  ledger.ingestItems([item]);
  assert.throws(() => ledger.ingestItems([item]), /duplicate/);
  assert.throws(() =>
    ledger.ingestItems([{ id: 'x', amount: 0n, startDate: '2024-01-01', endDate: '2024-01-02' }]), /amount/);
  assert.throws(() =>
    ledger.ingestItems([{ id: 'x', amount: 10n ** 18n + 1n, startDate: '2024-01-01', endDate: '2024-01-02' }]), /amount/);
  assert.throws(() =>
    ledger.ingestItems([{ id: 'x', amount: 1n, startDate: '2024-01-02', endDate: '2024-01-02' }]), /service/);
  assert.throws(() =>
    ledger.ingestItems([{ id: 'x', amount: 1n, startDate: '2024-01-01', endDate: '2035-01-01' }]), /service/);
  assert.throws(() => ledger.ingestRefunds([{ itemId: 'nope', amount: 1n, date: '2024-01-05' }]), /unknown/);
  assert.throws(() => ledger.ingestRefunds([{ itemId: 'a', amount: 1n, date: '2023-12-31' }]), /before service start/);
  assert.throws(() => ledger.ingestRefunds([{ itemId: 'a', amount: 101n, date: '2024-01-05' }]), /exceed/);
  ledger.ingestRefunds([{ itemId: 'a', amount: 60n, date: '2024-01-05' }]);
  assert.throws(() => ledger.ingestRefunds([{ itemId: 'a', amount: 41n, date: '2024-01-06' }]), /exceed/);
  ledger.closeTo('2024-01-10');
  assert.throws(() => ledger.closeTo('2024-01-09'), /backwards/);
  assert.throws(() => ledger.ingestRefunds([{ itemId: 'a', amount: 1n, date: '2024-01-10' }]), /frontier/);
  assert.throws(() =>
    ledger.ingestItems([{ id: 'y', amount: 1n, startDate: '2024-01-10', endDate: '2024-02-01' }]), /frontier/);
  assert.throws(() => ledger.exportRange('2024-01-01', '2024-01-11'), /not fully closed/);
  assert.throws(() => ledger.exportRange('2024-01-05', '2024-01-01'), /invalid range/);
  // Future refunds remain allowed after closing earlier dates.
  ledger.ingestRefunds([{ itemId: 'a', amount: 40n, date: '2024-06-01' }]);
  ledger.close();
});

test('closed results survive reopen and the frontier keeps moving forward', () => {
  const { ledger, path } = openLedger();
  ledger.ingestItems([{ id: 'a', amount: 1000n, startDate: '2024-01-01', endDate: '2024-02-01' }]);
  ledger.ingestRefunds([{ itemId: 'a', amount: 300n, date: '2024-01-20' }]);
  ledger.closeTo('2024-01-31');
  const before = ledger.exportRange('2024-01-01', '2024-01-31');
  ledger.close();

  const reopened = new RevenueLedger(path);
  const after = reopened.exportRange('2024-01-01', '2024-01-31');
  assert.deepStrictEqual(after, before);
  reopened.ingestRefunds([{ itemId: 'a', amount: 100n, date: '2024-03-01' }]);
  reopened.closeTo('2024-03-15');
  const tail = reopened.exportRange('2024-02-01', '2024-03-15');
  const refundDay = tail.days.find((d) => d.date === '2024-03-01')!;
  assert.strictEqual(refundDay.revenue, -100n);
  assert.strictEqual(refundDay.deferred, 0n);
  assert.strictEqual(tail.totalRevenue, -100n);
  reopened.close();
});
