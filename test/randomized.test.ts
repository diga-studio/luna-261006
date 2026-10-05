import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDate } from "../src/date.ts";
import { AgingLedger } from "../src/ledger.ts";
import { formatAmount, parseAmount } from "../src/money.ts";
import type { AgingReport, Batch } from "../src/types.ts";

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface InvoiceRec {
  id: string;
  currency: string;
  orig: bigint;
  invDay: number;
  dueDay: number;
  rev: number;
}

interface EventRec {
  invoiceId: string;
  day: number;
  rev: number;
  weight: bigint;
}

/** Naive per-record reference computation straight from the specification. */
function naiveQuery(
  invoices: InvoiceRec[],
  events: EventRec[],
  reportDay: number,
  maxRevision: number,
): AgingReport {
  const eventsByInvoice = new Map<string, EventRec[]>();
  for (const e of events) {
    const list = eventsByInvoice.get(e.invoiceId);
    if (list === undefined) eventsByInvoice.set(e.invoiceId, [e]);
    else list.push(e);
  }
  const byCurrency = new Map<string, bigint[]>();
  // A currency is visible once any of its invoices is recorded at a visible
  // revision, even if nothing is billed yet on the report date.
  for (const inv of invoices) {
    if (inv.rev > maxRevision) continue;
    if (!byCurrency.has(inv.currency)) byCurrency.set(inv.currency, [0n, 0n, 0n, 0n, 0n]);
  }
  for (const inv of invoices) {
    if (inv.rev > maxRevision || inv.invDay > reportDay) continue;
    let balance = inv.orig;
    for (const e of eventsByInvoice.get(inv.id) ?? []) {
      if (e.rev <= maxRevision && e.day <= reportDay) balance += e.weight;
    }
    const overdue = reportDay - inv.dueDay;
    const bucket = overdue <= 0 ? 0 : overdue <= 30 ? 1 : overdue <= 60 ? 2 : overdue <= 90 ? 3 : 4;
    byCurrency.get(inv.currency)![bucket] += balance;
  }
  const report: AgingReport = {};
  for (const [currency, sums] of byCurrency) {
    report[currency] = {
      current: formatAmount(sums[0]),
      days1To30: formatAmount(sums[1]),
      days31To60: formatAmount(sums[2]),
      days61To90: formatAmount(sums[3]),
      over90: formatAmount(sums[4]),
    };
  }
  return report;
}

function dateStr(dayNumber: number): string {
  const ms = Date.UTC(2000, 0, 1) + dayNumber * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

const BASE = parseDate("2024-01-01");

interface ScenarioOptions {
  invoiceCount: number;
  currencies: string[];
  maxEventsPerInvoice: number;
  batchCount: number;
  queryCount: number;
}

function runScenario(seed: number, options: ScenarioOptions): void {
  const random = rng(seed);
  const pick = (n: number) => Math.floor(random() * n);
  const currencies = options.currencies;

  // Invoices.
  const invoiceCount = options.invoiceCount;
  const invoices: InvoiceRec[] = [];
  for (let i = 0; i < invoiceCount; i++) {
    const invDay = BASE + pick(300);
    invoices.push({
      id: `INV-${i}`,
      currency: currencies[pick(currencies.length)],
      orig: parseAmount(`${1 + pick(10000)}.${String(pick(10000)).padStart(4, "0")}`),
      invDay,
      dueDay: invDay + pick(120),
      rev: 0, // assigned below
    });
  }

  // Events per invoice, dates sorted, keeping the running balance in [0, orig]
  // for every date prefix so every (date, revision) combination is valid.
  const events: EventRec[] = [];
  for (const inv of invoices) {
    const count = pick(options.maxEventsPerInvoice + 1);
    let paid = 0n;
    for (let k = 0; k < count; k++) {
      const day = inv.invDay + pick(150);
      events.push({ invoiceId: inv.id, day, rev: 0, weight: 0n });
    }
    // Assign amounts in date order to keep all prefixes valid.
    const mine = events.slice(events.length - count).sort((a, b) => a.day - b.day);
    for (const e of mine) {
      if (paid > 0n && random() < 0.3) {
        const amount = paid / 2n + 1n;
        e.weight = amount; // reversal restores balance
        paid -= amount;
      } else {
        const room = inv.orig - paid;
        const amount = room / 2n + BigInt(pick(4));
        e.weight = -amount; // payment reduces balance
        paid += amount;
      }
    }
  }

  // Shuffle records into random batches; an event's batch is never earlier
  // than its invoice's batch.
  const batchCount = options.batchCount;
  const invoiceBatch = invoices.map(() => pick(batchCount));
  const batches: Batch[] = Array.from({ length: batchCount }, () => ({}));
  invoices.forEach((inv, i) => {
    (batches[invoiceBatch[i]].invoices ??= []).push({
      invoiceId: inv.id,
      currency: inv.currency,
      amount: formatAmount(inv.orig),
      invoiceDate: dateStr(inv.invDay),
      dueDate: dateStr(inv.dueDay),
    });
  });
  // Parallel queues keep the event<->input mapping exact during replay.
  const paymentLinks: EventRec[][] = batches.map(() => []);
  const reversalLinks: EventRec[][] = batches.map(() => []);
  for (const e of events) {
    const invIdx = invoices.findIndex((inv) => inv.id === e.invoiceId);
    const minBatch = invoiceBatch[invIdx];
    const b = minBatch + pick(batchCount - minBatch);
    const input = {
      invoiceId: e.invoiceId,
      amount: formatAmount(e.weight < 0n ? -e.weight : e.weight),
      businessDate: dateStr(e.day),
    };
    if (e.weight < 0n) {
      (batches[b].payments ??= []).push(input);
      paymentLinks[b].push(e);
    } else {
      (batches[b].reversals ??= []).push(input);
      reversalLinks[b].push(e);
    }
  }

  // Replay into the ledger, recording revisions.
  const ledger = new AgingLedger();
  batches.forEach((batch, b) => {
    const rev = ledger.appendBatch(batch);
    for (const inv of batch.invoices ?? []) {
      invoices.find((x) => x.id === inv.invoiceId)!.rev = rev;
    }
    for (const e of paymentLinks[b]) e.rev = rev;
    for (const e of reversalLinks[b]) e.rev = rev;
  });

  // Random queries across report dates and old/new revisions.
  const latest = ledger.currentRevision;
  for (let q = 0; q < options.queryCount; q++) {
    const reportDay = BASE - 30 + pick(500);
    const revision = random() < 0.5 ? latest : pick(latest + 1);
    const expected = naiveQuery(invoices, events, reportDay, revision);
    const actual = ledger.queryAging(dateStr(reportDay), revision);
    assert.deepEqual(
      actual,
      expected,
      `seed ${seed} query ${q}: day ${dateStr(reportDay)} rev ${revision}`,
    );
    // Determinism: the same query repeated must agree.
    assert.deepEqual(ledger.queryAging(dateStr(reportDay), revision), actual);
  }
}

test("randomized complex flows match naive per-record computation", () => {
  for (const seed of [1, 7, 42, 1337, 20240601]) {
    runScenario(seed, {
      invoiceCount: 20 + (seed % 15),
      currencies: ["USD", "EUR", "JPY"],
      maxEventsPerInvoice: 5,
      batchCount: 25 + (seed % 15),
      queryCount: 150,
    });
  }
});

test("larger flows force block splits and still match the naive model", () => {
  // 1600 invoices in one currency -> several blocks; queries hit both the
  // aggregated full-block path and the invoice-by-invoice boundary path.
  for (const seed of [99, 12345]) {
    runScenario(seed, {
      invoiceCount: 1600,
      currencies: ["USD", "EUR"],
      maxEventsPerInvoice: 4,
      batchCount: 120,
      queryCount: 80,
    });
  }
});
