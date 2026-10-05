import assert from "node:assert/strict";
import { test } from "node:test";
import { AgingLedger } from "../src/ledger.ts";
import { parseDate } from "../src/date.ts";

function day(offset: number, base = "2024-06-15"): string {
  const ms = Date.UTC(2000, 0, 1) + (parseDate(base) + offset) * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

const ZEROES = {
  current: "0",
  days1To30: "0",
  days31To60: "0",
  days61To90: "0",
  over90: "0",
};

test("one invoice walks through every bucket boundary", () => {
  const ledger = new AgingLedger();
  ledger.appendBatch({
    invoices: [
      {
        invoiceId: "W",
        currency: "USD",
        amount: 100,
        invoiceDate: day(-200),
        dueDate: "2024-06-15",
      },
    ],
  });
  const expectations: [number, keyof typeof ZEROES][] = [
    [-1, "current"],
    [0, "current"], // due on the report date itself
    [1, "days1To30"],
    [30, "days1To30"],
    [31, "days31To60"],
    [60, "days31To60"],
    [61, "days61To90"],
    [90, "days61To90"],
    [91, "over90"],
    [400, "over90"],
  ];
  for (const [offset, bucket] of expectations) {
    const report = ledger.queryAging(day(offset));
    for (const key of Object.keys(ZEROES) as (keyof typeof ZEROES)[]) {
      assert.equal(
        report.USD[key],
        key === bucket ? "100" : "0",
        `offset ${offset}: expected 100 in ${bucket}`,
      );
    }
  }
});

test("many invoices in different buckets sum independently", () => {
  const ledger = new AgingLedger();
  const offsets = [-10, 0, 1, 30, 31, 60, 61, 90, 91, 500];
  ledger.appendBatch({
    invoices: offsets.map((past, i) => ({
      invoiceId: `I${i}`,
      currency: "USD",
      amount: 100,
      invoiceDate: day(-600),
      dueDate: day(-past),
    })),
  });
  const report = ledger.queryAging(day(0));
  assert.deepEqual(report.USD, {
    current: "200", // offsets 0 and 5 -> due today or in 5 days
    days1To30: "200",
    days31To60: "200",
    days61To90: "200",
    over90: "200",
  });
});

test("zero balances contribute nothing; unbilled invoices are excluded", () => {
  const ledger = new AgingLedger();
  ledger.appendBatch({
    invoices: [
      {
        invoiceId: "PAID",
        currency: "USD",
        amount: 100,
        invoiceDate: "2024-01-01",
        dueDate: day(-40),
      },
      {
        invoiceId: "FUTURE",
        currency: "USD",
        amount: 55,
        invoiceDate: day(2),
        dueDate: day(30),
      },
      {
        invoiceId: "OPEN",
        currency: "USD",
        amount: 70,
        invoiceDate: day(-10),
        dueDate: day(-40),
      },
    ],
  });
  ledger.appendBatch({
    payments: [{ invoiceId: "PAID", amount: 100, businessDate: day(-5) }],
  });
  const report = ledger.queryAging(day(0));
  assert.deepEqual(report.USD, { ...ZEROES, days31To60: "70" });
  // The future invoice appears once the report date reaches its invoice date.
  assert.equal(ledger.queryAging(day(2)).USD.current, "55");
});

test("records dated on the report day are included", () => {
  const ledger = new AgingLedger();
  ledger.appendBatch({
    invoices: [
      {
        invoiceId: "S",
        currency: "USD",
        amount: 100,
        invoiceDate: "2024-02-01",
        dueDate: "2024-02-01",
      },
    ],
  });
  ledger.appendBatch({
    payments: [{ invoiceId: "S", amount: 25, businessDate: "2024-02-10" }],
  });
  assert.equal(ledger.queryAging("2024-02-10").USD.days1To30, "75");
  assert.equal(ledger.queryAging("2024-02-09").USD.days1To30, "100");
});

test("payment dated before the invoice date only counts once billed", () => {
  const ledger = new AgingLedger();
  ledger.appendBatch({
    invoices: [
      {
        invoiceId: "P",
        currency: "USD",
        amount: 100,
        invoiceDate: "2024-03-01",
        dueDate: "2024-03-10",
      },
    ],
  });
  ledger.appendBatch({
    payments: [{ invoiceId: "P", amount: 30, businessDate: "2024-02-01" }],
  });
  // Not yet billed on Feb 15: excluded entirely.
  assert.deepEqual(ledger.queryAging("2024-02-15").USD, { ...ZEROES });
  // Billed on Mar 1: the early payment is netted from that day on.
  assert.equal(ledger.queryAging("2024-03-01").USD.current, "70");
});

test("currencies are reported separately without conversion", () => {
  const ledger = new AgingLedger();
  ledger.appendBatch({
    invoices: [
      {
        invoiceId: "A",
        currency: "USD",
        amount: 100,
        invoiceDate: "2024-01-01",
        dueDate: "2024-01-01",
      },
      {
        invoiceId: "B",
        currency: "JPY",
        amount: 100,
        invoiceDate: "2024-01-01",
        dueDate: "2024-01-01",
      },
    ],
  });
  ledger.appendBatch({
    payments: [{ invoiceId: "A", amount: 40, businessDate: "2024-01-02" }],
  });
  // The payment is dated Jan 2: invisible on Jan 1, applied on Jan 2.
  const before = ledger.queryAging("2024-01-01");
  assert.equal(before.USD.current, "100");
  assert.equal(before.JPY.current, "100");
  // On Jan 2 both invoices are 1 day past their Jan 1 due date.
  const report = ledger.queryAging("2024-01-02");
  assert.equal(report.USD.days1To30, "60");
  assert.equal(report.JPY.days1To30, "100");
});

test("amounts are exact to 4 decimal places", () => {
  const ledger = new AgingLedger();
  ledger.appendBatch({
    invoices: [
      {
        invoiceId: "D",
        currency: "USD",
        amount: "0.0001",
        invoiceDate: "2024-01-01",
        dueDate: "2024-01-01",
      },
    ],
  });
  for (let i = 0; i < 9; i++) {
    ledger.appendBatch({
      invoices: [
        {
          invoiceId: `D${i}`,
          currency: "USD",
          amount: "0.0001",
          invoiceDate: "2024-01-01",
          dueDate: "2024-01-01",
        },
      ],
    });
  }
  assert.equal(ledger.queryAging("2024-01-01").USD.current, "0.001");
  ledger.appendBatch({
    payments: [{ invoiceId: "D", amount: "0.0001", businessDate: "2024-01-01" }],
  });
  assert.equal(ledger.queryAging("2024-01-01").USD.current, "0.0009");
  // Large magnitudes stay exact (well beyond float53 precision).
  const big = new AgingLedger();
  big.appendBatch({
    invoices: [
      {
        invoiceId: "BIG",
        currency: "USD",
        amount: "99999999999999.9999",
        invoiceDate: "2024-01-01",
        dueDate: "2024-01-01",
      },
    ],
  });
  big.appendBatch({
    payments: [{ invoiceId: "BIG", amount: "0.0001", businessDate: "2024-01-01" }],
  });
  assert.equal(big.queryAging("2024-01-01").USD.current, "99999999999999.9998");
});
