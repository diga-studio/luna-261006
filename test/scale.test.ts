import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDate } from "../src/date.ts";
import { AgingLedger } from "../src/ledger.ts";
import { formatAmount } from "../src/money.ts";
import type { AgingReport, Batch } from "../src/types.ts";

/**
 * Scale/performance acceptance test:
 * - 50k invoices, 150k payments/reversals, 25 currencies, 200k revisions,
 *   initial load under 60 seconds;
 * - then 10k rounds of alternating single-record appends and queries over
 *   varying business dates and old/new revisions, under 15 seconds total;
 * - peak process memory below 768 MiB.
 */

const INVOICE_COUNT = 50_000;
const EVENT_COUNT = 150_000;
const CURRENCY_COUNT = 25;
const ROUNDS = 10_000;
const LOAD_BUDGET_MS = 60_000;
const MIXED_BUDGET_MS = 15_000;
const MEMORY_BUDGET_BYTES = 768 * 1024 * 1024;

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

function dateStr(dayNumber: number): string {
  const ms = Date.UTC(2000, 0, 1) + dayNumber * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

const BASE = parseDate("2020-01-01");
const MiB = 1024 * 1024;

interface PlannedEvent {
  invoiceId: string;
  day: number;
  weight: bigint;
}

test("scale: 200k revisions load fast; 10k mixed rounds stay fast and lean", { timeout: 120_000 }, () => {
  const random = rng(20241006);
  const pick = (n: number) => Math.floor(random() * n);
  const currencies = Array.from(
    { length: CURRENCY_COUNT },
    (_, i) => `C${String(i).padStart(2, "0")}`,
  );

  const ledger = new AgingLedger();
  const invoiceIds: string[] = [];
  const invoiceDay = new Map<string, number>();
  const eventsByInvoice = new Map<string, PlannedEvent[]>();

  const t0 = performance.now();

  // Phase 1a: 50k invoices, one batch each (revisions 1..50k).
  for (let i = 0; i < INVOICE_COUNT; i++) {
    const id = `INV${i}`;
    const invDay = BASE + pick(365 * 4);
    const dueDay = invDay + 30 + pick(90);
    // Amounts up to ~2e9 with 4 decimals; per-currency totals stay << 1e14.
    const orig = BigInt(1 + pick(2_000_000)) * 10000n + BigInt(pick(10000));
    invoiceIds.push(id);
    invoiceDay.set(id, invDay);
    ledger.appendBatch({
      invoices: [
        {
          invoiceId: id,
          currency: currencies[i % CURRENCY_COUNT],
          amount: formatAmount(orig),
          invoiceDate: dateStr(invDay),
          dueDate: dateStr(dueDay),
        },
      ],
    });

    // Plan exactly 3 events per invoice with prefix-valid amounts:
    // cumulative payments never exceed the original amount, and cumulative
    // reversals never exceed cumulative payments at any date prefix.
    const p1 = orig / 4n + BigInt(pick(1000));
    const p2 = orig / 4n + BigInt(pick(1000));
    const third = pick(4);
    const d1 = invDay + pick(100);
    const d2 = d1 + pick(100);
    const d3 = d2 + pick(100);
    const planned: PlannedEvent[] =
      third === 0
        ? [
            { invoiceId: id, day: d1, weight: -p1 },
            { invoiceId: id, day: d2, weight: -p2 },
            { invoiceId: id, day: d3, weight: p1 / 2n + 1n },
          ]
        : [
            { invoiceId: id, day: d1, weight: -p1 },
            { invoiceId: id, day: d2, weight: -p2 },
            { invoiceId: id, day: d3, weight: -(orig / 5n) },
          ];
    eventsByInvoice.set(id, planned);
  }

  // Phase 1b: 150k events, one batch each (revisions 50k+1..200k), entry
  // order shuffled away from business-date order.
  const allEvents: PlannedEvent[] = [];
  for (const planned of eventsByInvoice.values()) allEvents.push(...planned);
  assert.equal(allEvents.length, EVENT_COUNT);
  for (let i = allEvents.length - 1; i > 0; i--) {
    const j = pick(i + 1);
    [allEvents[i], allEvents[j]] = [allEvents[j], allEvents[i]];
  }
  for (const e of allEvents) {
    const batch: Batch =
      e.weight < 0n
        ? {
            payments: [
              {
                invoiceId: e.invoiceId,
                amount: formatAmount(-e.weight),
                businessDate: dateStr(e.day),
              },
            ],
          }
        : {
            reversals: [
              {
                invoiceId: e.invoiceId,
                amount: formatAmount(e.weight),
                businessDate: dateStr(e.day),
              },
            ],
          };
    ledger.appendBatch(batch);
  }

  const loadMs = performance.now() - t0;
  assert.equal(ledger.currentRevision, 200_000);
  assert.ok(
    loadMs < LOAD_BUDGET_MS,
    `initial load took ${loadMs.toFixed(0)}ms (budget ${LOAD_BUDGET_MS}ms)`,
  );
  const rssAfterLoad = process.memoryUsage().rss;
  assert.ok(
    rssAfterLoad < MEMORY_BUDGET_BYTES,
    `rss after load ${(rssAfterLoad / MiB).toFixed(0)} MiB exceeds 768 MiB`,
  );

  // Phase 2: 10k rounds of one single-record append plus one query covering
  // varying business dates and old/new revisions, returning all currencies.
  const newInvoiceIds: string[] = [];
  let queriesChecked = 0;
  const t1 = performance.now();
  for (let round = 0; round < ROUNDS; round++) {
    if (round % 2 === 0 || newInvoiceIds.length === 0) {
      const id = `NEW${round}`;
      const invDay = BASE + 365 * 4 + pick(365);
      newInvoiceIds.push(id);
      invoiceDay.set(id, invDay);
      ledger.appendBatch({
        invoices: [
          {
            invoiceId: id,
            currency: currencies[round % CURRENCY_COUNT],
            amount: "1000",
            invoiceDate: dateStr(invDay),
            dueDate: dateStr(invDay + 60),
          },
        ],
      });
    } else {
      const id = newInvoiceIds[newInvoiceIds.length - 1];
      ledger.appendBatch({
        payments: [
          {
            invoiceId: id,
            amount: "10",
            businessDate: dateStr(invoiceDay.get(id)! + 5),
          },
        ],
      });
    }

    const revision = ledger.currentRevision;
    let queryRevision: number;
    const mode = round % 4;
    if (mode === 0) queryRevision = revision; // latest
    else if (mode === 1) queryRevision = 1000 + pick(revision - 999); // old
    else if (mode === 2) queryRevision = revision - pick(Math.min(100, revision)); // recent
    else queryRevision = 1 + pick(revision); // anywhere
    const reportDay = BASE - 100 + pick(365 * 8);

    const report = ledger.queryAging(dateStr(reportDay), queryRevision);
    // Every query must return all currencies.
    assert.equal(Object.keys(report).length, CURRENCY_COUNT);
    // Amount format is validated on a sample of rounds to keep the
    // measurement focused on the ledger itself.
    if (round % 100 === 0) {
      for (const currency of currencies) {
        const buckets: AgingReport[string] = report[currency];
        for (const key of Object.keys(buckets) as (keyof typeof buckets)[]) {
          assert.match(buckets[key], /^-?\d+(\.\d{1,4})?$/);
        }
      }
    }
    queriesChecked++;
  }
  const mixedMs = performance.now() - t1;
  assert.equal(queriesChecked, ROUNDS);
  assert.ok(
    mixedMs < MIXED_BUDGET_MS,
    `10k mixed rounds took ${mixedMs.toFixed(0)}ms (budget ${MIXED_BUDGET_MS}ms)`,
  );

  const rssFinal = process.memoryUsage().rss;
  assert.ok(
    rssFinal < MEMORY_BUDGET_BYTES,
    `final rss ${(rssFinal / MiB).toFixed(0)} MiB exceeds 768 MiB`,
  );

  console.log(
    `    scale: load ${(loadMs / 1000).toFixed(1)}s, ` +
      `10k mixed rounds ${(mixedMs / 1000).toFixed(1)}s, ` +
      `rss after load ${(rssAfterLoad / MiB).toFixed(0)} MiB, final ${(rssFinal / MiB).toFixed(0)} MiB`,
  );
});
