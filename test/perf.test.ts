import test from "node:test";
import assert from "node:assert/strict";
import { AgingLedger } from "../src/index";
import { parseDate } from "../src/date";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY_ORIGIN = parseDate("2000-01-01");
const DAY_SPAN = parseDate("2099-12-31") - DAY_ORIGIN + 1;

function dayToString(day: number): string {
  return new Date(day * 86400000).toISOString().slice(0, 10);
}

const INVOICES = 50_000;
const PAY_EVENTS = 150_000;
const CURRENCIES = 25;
const MIXED_ROUNDS = 10_000;
const LOAD_BUDGET_MS = 60_000;
const MIXED_BUDGET_MS = 15_000;
const MEMORY_BUDGET_BYTES = 768 * 1024 * 1024;

test("scale: 50k invoices, 150k payments/reversals, 25 currencies, 200k+ revisions", () => {
  const rand = mulberry32(881006);
  const currencies: string[] = [];
  for (let i = 0; i < CURRENCIES; i++) {
    currencies.push(`C${i.toString().padStart(2, "0")}`);
  }
  const ledger = new AgingLedger();
  // Test-side bookkeeping to keep every invoice balance non-negative.
  const open = new Array<bigint>(INVOICES);
  const paid = new Array<bigint>(INVOICES).fill(0n);
  const invoiceIds = new Array<string>(INVOICES);

  const t0 = Date.now();
  // 50k revisions: one invoice each.
  for (let i = 0; i < INVOICES; i++) {
    const invoiceDay = DAY_ORIGIN + Math.floor(rand() * DAY_SPAN * 0.6);
    const dueDay = invoiceDay + Math.floor(rand() * 180);
    const units = BigInt(1 + Math.floor(rand() * 1_000_000_000));
    open[i] = units;
    invoiceIds[i] = `inv-${i}`;
    ledger.appendBatch({
      invoices: [
        {
          id: invoiceIds[i],
          currency: currencies[i % CURRENCIES],
          amount: `${units / 10000n}.${(units % 10000n).toString().padStart(4, "0")}`,
          invoiceDate: dayToString(invoiceDay),
          dueDate: dayToString(dueDay),
        },
      ],
    });
  }
  // 150k revisions: one payment or reversal each, random business dates.
  for (let i = 0; i < PAY_EVENTS; i++) {
    const idx = Math.floor(rand() * INVOICES);
    const day = DAY_ORIGIN + Math.floor(rand() * DAY_SPAN);
    const isPayment = open[idx] > 0n && (rand() < 0.7 || paid[idx] === 0n);
    if (isPayment) {
      let amount = BigInt(1 + Math.floor(rand() * 1_000_000));
      if (amount > open[idx]) {
        amount = open[idx];
      }
      open[idx] -= amount;
      paid[idx] += amount;
      ledger.appendBatch({
        payments: [{ invoiceId: invoiceIds[idx], amount: formatUnits4(amount), date: dayToString(day) }],
      });
    } else {
      let amount = BigInt(1 + Math.floor(rand() * 1_000_000));
      if (amount > paid[idx]) {
        amount = paid[idx];
      }
      open[idx] += amount;
      paid[idx] -= amount;
      ledger.appendBatch({
        reversals: [{ invoiceId: invoiceIds[idx], amount: formatUnits4(amount), date: dayToString(day) }],
      });
    }
  }
  const loadMs = Date.now() - t0;
  assert.ok(
    ledger.currentRevision >= 200_000,
    `expected at least 200k revisions, got ${ledger.currentRevision}`
  );

  // 10k rounds: append one record, then query a random (day, revision).
  const t1 = Date.now();
  let checksum = 0;
  for (let round = 0; round < MIXED_ROUNDS; round++) {
    const idx = Math.floor(rand() * INVOICES);
    const day = DAY_ORIGIN + Math.floor(rand() * DAY_SPAN);
    if (open[idx] > 0n && rand() < 0.7) {
      let amount = BigInt(1 + Math.floor(rand() * 1_000_000));
      if (amount > open[idx]) {
        amount = open[idx];
      }
      open[idx] -= amount;
      paid[idx] += amount;
      ledger.appendBatch({
        payments: [{ invoiceId: invoiceIds[idx], amount: formatUnits4(amount), date: dayToString(day) }],
      });
    } else if (paid[idx] > 0n) {
      let amount = BigInt(1 + Math.floor(rand() * 1_000_000));
      if (amount > paid[idx]) {
        amount = paid[idx];
      }
      open[idx] += amount;
      paid[idx] -= amount;
      ledger.appendBatch({
        reversals: [{ invoiceId: invoiceIds[idx], amount: formatUnits4(amount), date: dayToString(day) }],
      });
    } else {
      ledger.appendBatch({});
    }
    const reportDay = DAY_ORIGIN + Math.floor(rand() * DAY_SPAN);
    // All 25 currencies are visible from revision 25 on; sample old and new.
    const rev = CURRENCIES + Math.floor(rand() * (ledger.currentRevision - CURRENCIES + 1));
    const report = ledger.queryAging(dayToString(reportDay), rev);
    assert.equal(Object.keys(report.currencies).length, CURRENCIES);
    // Touch the result so it cannot be optimized away.
    checksum += report.currencies["C00"].current.length;
  }
  const mixedMs = Date.now() - t1;
  assert.ok(checksum > 0);

  const rss = process.memoryUsage().rss;
  assert.ok(loadMs < LOAD_BUDGET_MS, `initial load took ${loadMs}ms (budget ${LOAD_BUDGET_MS}ms)`);
  assert.ok(
    mixedMs < MIXED_BUDGET_MS,
    `10k alternating append+query rounds took ${mixedMs}ms (budget ${MIXED_BUDGET_MS}ms)`
  );
  assert.ok(
    rss < MEMORY_BUDGET_BYTES,
    `process rss ${(rss / 1024 / 1024).toFixed(1)} MiB exceeds 768 MiB`
  );
  // Surface the numbers in the test output for the report.
  console.log(
    `perf: load=${loadMs}ms mixed=${mixedMs}ms revisions=${ledger.currentRevision} rss=${(rss / 1024 / 1024).toFixed(1)} MiB`
  );
});

function formatUnits4(units: bigint): string {
  return `${units / 10000n}.${(units % 10000n).toString().padStart(4, "0")}`;
}
