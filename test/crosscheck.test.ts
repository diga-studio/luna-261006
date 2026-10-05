import test from "node:test";
import assert from "node:assert/strict";
import { AgingLedger, BucketAmounts } from "../src/index";
import { parseDate } from "../src/date";
import { formatUnits, parseAmount } from "../src/money";

// Deterministic PRNG so failures are reproducible.
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

interface InvoiceRec {
  id: string;
  currency: string;
  units: bigint;
  invoiceDay: number;
  dueDay: number;
  rev: number;
}

interface EventRec {
  invoice: InvoiceRec;
  units: bigint; // signed
  day: number;
  rev: number;
}

const DAY_ORIGIN = parseDate("2000-01-01");
const DAY_SPAN = parseDate("2099-12-31") - DAY_ORIGIN + 1;

function dayToString(day: number): string {
  // Day numbers are days since 1970-01-01; format via UTC Date.
  return new Date(day * 86400000).toISOString().slice(0, 10);
}

function bucketName(overdueDays: number): keyof BucketAmounts {
  if (overdueDays <= 0) {
    return "current";
  }
  if (overdueDays <= 30) {
    return "overdue1To30";
  }
  if (overdueDays <= 60) {
    return "overdue31To60";
  }
  if (overdueDays <= 90) {
    return "overdue61To90";
  }
  return "overdue90Plus";
}

/** Brute-force reference: recompute every invoice balance record by record. */
function bruteForce(
  invoices: InvoiceRec[],
  events: EventRec[],
  reportDay: number,
  rev: number
): Record<string, BucketAmounts> {
  const totals = new Map<string, Map<keyof BucketAmounts, bigint>>();
  for (const inv of invoices) {
    if (inv.rev > rev || inv.invoiceDay > reportDay) {
      continue;
    }
    let balance = inv.units;
    for (const ev of events) {
      if (ev.invoice.id === inv.id && ev.rev <= rev && ev.day <= reportDay) {
        balance += ev.units;
      }
    }
    if (balance === 0n) {
      continue;
    }
    const bucket = bucketName(reportDay - inv.dueDay);
    let perCurrency = totals.get(inv.currency);
    if (perCurrency === undefined) {
      perCurrency = new Map();
      totals.set(inv.currency, perCurrency);
    }
    perCurrency.set(bucket, (perCurrency.get(bucket) ?? 0n) + balance);
  }
  const out: Record<string, BucketAmounts> = {};
  for (const [currency, perBucket] of totals) {
    out[currency] = {
      current: formatUnits(perBucket.get("current") ?? 0n),
      overdue1To30: formatUnits(perBucket.get("overdue1To30") ?? 0n),
      overdue31To60: formatUnits(perBucket.get("overdue31To60") ?? 0n),
      overdue61To90: formatUnits(perBucket.get("overdue61To90") ?? 0n),
      overdue90Plus: formatUnits(perBucket.get("overdue90Plus") ?? 0n),
    };
  }
  return out;
}

const ZERO: BucketAmounts = {
  current: "0",
  overdue1To30: "0",
  overdue31To60: "0",
  overdue61To90: "0",
  overdue90Plus: "0",
};

test("random small ledgers match record-by-record computation", () => {
  const rand = mulberry32(20261006);
  const currencies = ["USD", "EUR", "JPY"];
  for (let trial = 0; trial < 30; trial++) {
    const ledger = new AgingLedger();
    const invoices: InvoiceRec[] = [];
    const events: EventRec[] = [];
    const openBalance = new Map<string, bigint>();
    const invoiceCount = 5 + Math.floor(rand() * 10);
    // Initial batch: all invoices.
    const batch = { invoices: [] as { id: string; currency: string; amount: string; invoiceDate: string; dueDate: string }[] };
    for (let i = 0; i < invoiceCount; i++) {
      const invoiceDay = DAY_ORIGIN + Math.floor(rand() * DAY_SPAN * 0.5);
      const dueDay = invoiceDay + Math.floor(rand() * 120);
      const units = BigInt(1 + Math.floor(rand() * 1000000));
      const inv: InvoiceRec = {
        id: `t${trial}-inv-${i}`,
        currency: currencies[Math.floor(rand() * currencies.length)],
        units,
        invoiceDay,
        dueDay,
        rev: 1,
      };
      invoices.push(inv);
      openBalance.set(inv.id, units);
      batch.invoices.push({
        id: inv.id,
        currency: inv.currency,
        amount: formatUnits(units),
        invoiceDate: dayToString(invoiceDay),
        dueDate: dayToString(dueDay),
      });
    }
    ledger.appendBatch(batch);
    // Follow-up batches: random payments and reversals, possibly backdated,
    // keeping every invoice balance non-negative at every (day, revision).
    // To guarantee the invariant simply: payments never exceed the running
    // balance tracked in business-date order per invoice, and reversals
    // never exceed what was paid before them in business-date order.
    const paidByDay = new Map<string, { day: number; units: bigint }[]>();
    const batchCount = 5 + Math.floor(rand() * 15);
    for (let b = 0; b < batchCount; b++) {
      const payments: { invoiceId: string; amount: string; date: string }[] = [];
      const reversals: { invoiceId: string; amount: string; date: string }[] = [];
      const opCount = 1 + Math.floor(rand() * 4);
      for (let op = 0; op < opCount; op++) {
        const inv = invoices[Math.floor(rand() * invoices.length)];
        const day = inv.invoiceDay + Math.floor(rand() * (DAY_SPAN / 2));
        const isPayment = rand() < 0.6;
        if (isPayment) {
          const open = openBalance.get(inv.id)!;
          if (open <= 0n) {
            continue;
          }
          let amount = BigInt(1 + Math.floor(rand() * 1000));
          if (amount > open) {
            amount = open;
          }
          openBalance.set(inv.id, open - amount);
          const list = paidByDay.get(inv.id) ?? [];
          list.push({ day, units: amount });
          paidByDay.set(inv.id, list);
          events.push({ invoice: inv, units: -amount, day, rev: ledger.currentRevision + 1 });
          payments.push({ invoiceId: inv.id, amount: formatUnits(amount), date: dayToString(day) });
        } else {
          const list = paidByDay.get(inv.id) ?? [];
          const totalPaid = list.reduce((s, p) => s + p.units, 0n);
          const reversedSoFar = -((openBalance.get(inv.id)! ?? 0n) - (inv.units - totalPaid));
          const reversible = totalPaid - reversedSoFar;
          if (reversible <= 0n) {
            continue;
          }
          let amount = BigInt(1 + Math.floor(rand() * 1000));
          if (amount > reversible) {
            amount = reversible;
          }
          openBalance.set(inv.id, openBalance.get(inv.id)! + amount);
          list.push({ day, units: -amount });
          events.push({ invoice: inv, units: amount, day, rev: ledger.currentRevision + 1 });
          reversals.push({ invoiceId: inv.id, amount: formatUnits(amount), date: dayToString(day) });
        }
      }
      ledger.appendBatch({ payments, reversals });
    }
    // Random queries across business days and revisions, old and new.
    const maxRev = ledger.currentRevision;
    for (let q = 0; q < 40; q++) {
      const reportDay = DAY_ORIGIN + Math.floor(rand() * DAY_SPAN);
      const rev = 1 + Math.floor(rand() * maxRev);
      const expected = bruteForce(invoices, events, reportDay, rev);
      const actual = ledger.queryAging(dayToString(reportDay), rev).currencies;
      for (const currency of currencies) {
        const exp = expected[currency] ?? ZERO;
        const act = actual[currency] ?? ZERO;
        assert.deepEqual(
          act,
          exp,
          `trial ${trial} query ${q} currency ${currency} day ${dayToString(reportDay)} rev ${rev}`
        );
      }
    }
  }
});
