import test from "node:test";
import assert from "node:assert/strict";
import { AgingLedger } from "../src/index";

const ZERO = {
  current: "0",
  overdue1To30: "0",
  overdue31To60: "0",
  overdue61To90: "0",
  overdue90Plus: "0",
};

test("late-entered payment and reversal keep old revisions intact", () => {
  const ledger = new AgingLedger();
  // Invoice 100, due 2024-01-31.
  const r1 = ledger.appendBatch({
    invoices: [
      { id: "inv-1", currency: "USD", amount: 100, invoiceDate: "2024-01-01", dueDate: "2024-01-31" },
    ],
  });
  // Payment of 40 with business date 2024-02-05, only entered in March.
  const r2 = ledger.appendBatch({
    payments: [{ invoiceId: "inv-1", amount: 40, date: "2024-02-05" }],
  });
  // Reversal of 10 with business date 2024-02-08, entered even later.
  const r3 = ledger.appendBatch({
    reversals: [{ invoiceId: "inv-1", amount: 10, date: "2024-02-08" }],
  });

  // 2024-02-10 is 10 days past the due date -> 1..30 bucket.
  const before = ledger.queryAging("2024-02-10", r1);
  assert.equal(before.currencies["USD"].overdue1To30, "100");

  const afterPayment = ledger.queryAging("2024-02-10", r2);
  assert.equal(afterPayment.currencies["USD"].overdue1To30, "60");

  const afterReversal = ledger.queryAging("2024-02-10", r3);
  assert.equal(afterReversal.currencies["USD"].overdue1To30, "70");

  // Old revisions are unaffected by later appends.
  assert.equal(ledger.queryAging("2024-02-10", r1).currencies["USD"].overdue1To30, "100");
  assert.equal(ledger.queryAging("2024-02-10", r2).currencies["USD"].overdue1To30, "60");
});

test("bucket boundaries around due date and 30/60/90 days", () => {
  const ledger = new AgingLedger();
  const rev = ledger.appendBatch({
    invoices: [
      { id: "inv-1", currency: "USD", amount: 100, invoiceDate: "2024-01-01", dueDate: "2024-01-31" },
    ],
  });
  const bucketOf = (date: string) => {
    const b = ledger.queryAging(date, rev).currencies["USD"];
    for (const [name, value] of Object.entries(b)) {
      if (value === "100") {
        return name;
      }
    }
    throw new Error(`no bucket holds 100 at ${date}: ${JSON.stringify(b)}`);
  };
  // Not yet due, including the due date itself.
  assert.equal(bucketOf("2024-01-01"), "current");
  assert.equal(bucketOf("2024-01-30"), "current");
  assert.equal(bucketOf("2024-01-31"), "current");
  // 1..30 days overdue.
  assert.equal(bucketOf("2024-02-01"), "overdue1To30");
  assert.equal(bucketOf("2024-02-29"), "overdue1To30"); // due + 29
  assert.equal(bucketOf("2024-03-01"), "overdue1To30"); // due + 30
  // 31..60 days overdue.
  assert.equal(bucketOf("2024-03-02"), "overdue31To60"); // due + 31
  assert.equal(bucketOf("2024-03-30"), "overdue31To60"); // due + 59
  assert.equal(bucketOf("2024-03-31"), "overdue31To60"); // due + 60
  // 61..90 days overdue.
  assert.equal(bucketOf("2024-04-01"), "overdue61To90"); // due + 61
  assert.equal(bucketOf("2024-04-29"), "overdue61To90"); // due + 89
  assert.equal(bucketOf("2024-04-30"), "overdue61To90"); // due + 90
  // More than 90 days overdue.
  assert.equal(bucketOf("2024-05-01"), "overdue90Plus"); // due + 91
  assert.equal(bucketOf("2025-06-15"), "overdue90Plus");
});

test("invoices not yet billed are excluded", () => {
  const ledger = new AgingLedger();
  const rev = ledger.appendBatch({
    invoices: [
      { id: "inv-1", currency: "USD", amount: 100, invoiceDate: "2024-02-01", dueDate: "2024-03-01" },
    ],
  });
  assert.deepEqual(ledger.queryAging("2024-01-31", rev).currencies["USD"], ZERO);
  assert.equal(ledger.queryAging("2024-02-01", rev).currencies["USD"].current, "100");
});

test("records on the report day count for that day", () => {
  const ledger = new AgingLedger();
  ledger.appendBatch({
    invoices: [
      { id: "inv-1", currency: "USD", amount: 100, invoiceDate: "2024-01-01", dueDate: "2024-01-15" },
    ],
  });
  const r2 = ledger.appendBatch({
    payments: [{ invoiceId: "inv-1", amount: 100, date: "2024-01-10" }],
  });
  assert.equal(ledger.queryAging("2024-01-09", r2).currencies["USD"].current, "100");
  assert.deepEqual(ledger.queryAging("2024-01-10", r2).currencies["USD"], ZERO);
});

test("currencies are reported separately without conversion", () => {
  const ledger = new AgingLedger();
  const rev = ledger.appendBatch({
    invoices: [
      { id: "a", currency: "USD", amount: "10.5", invoiceDate: "2024-01-01", dueDate: "2024-01-01" },
      { id: "b", currency: "EUR", amount: "20.25", invoiceDate: "2024-01-01", dueDate: "2024-01-01" },
    ],
  });
  const report = ledger.queryAging("2024-01-01", rev);
  assert.equal(report.currencies["USD"].current, "10.5");
  assert.equal(report.currencies["EUR"].current, "20.25");
  // A currency only appears once it is visible.
  const r2 = ledger.appendBatch({
    invoices: [
      { id: "c", currency: "JPY", amount: 7, invoiceDate: "2024-01-01", dueDate: "2024-01-01" },
    ],
  });
  assert.equal(ledger.queryAging("2024-01-01", rev).currencies["JPY"], undefined);
  assert.equal(ledger.queryAging("2024-01-01", r2).currencies["JPY"].current, "7");
});

test("decimal exactness with 4 fractional digits", () => {
  const ledger = new AgingLedger();
  const r1 = ledger.appendBatch({
    invoices: [
      { id: "a", currency: "USD", amount: "0.0001", invoiceDate: "2024-01-01", dueDate: "2024-01-01" },
      { id: "b", currency: "USD", amount: "99999999.9999", invoiceDate: "2024-01-01", dueDate: "2024-01-01" },
    ],
  });
  assert.equal(ledger.queryAging("2024-01-01", r1).currencies["USD"].current, "100000000");
  const r2 = ledger.appendBatch({
    payments: [{ invoiceId: "b", amount: "0.0001", date: "2024-01-01" }],
  });
  assert.equal(ledger.queryAging("2024-01-01", r2).currencies["USD"].current, "99999999.9999");
});

test("backdated facts do not rewrite earlier business days", () => {
  const ledger = new AgingLedger();
  ledger.appendBatch({
    invoices: [
      { id: "a", currency: "USD", amount: 100, invoiceDate: "2024-01-01", dueDate: "2024-02-01" },
    ],
  });
  // Payment entered later, with an earlier business date.
  const r2 = ledger.appendBatch({
    payments: [{ invoiceId: "a", amount: 30, date: "2024-01-05" }],
  });
  // The payment counts from its own business date onward.
  assert.equal(ledger.queryAging("2024-01-04", r2).currencies["USD"].current, "100");
  assert.equal(ledger.queryAging("2024-01-05", r2).currencies["USD"].current, "70");
  // Reversal restores the balance from its own business date only.
  const r3 = ledger.appendBatch({
    reversals: [{ invoiceId: "a", amount: 30, date: "2024-01-20" }],
  });
  assert.equal(ledger.queryAging("2024-01-19", r3).currencies["USD"].current, "70");
  assert.equal(ledger.queryAging("2024-01-20", r3).currencies["USD"].current, "100");
});

test("empty ledger and empty batches", () => {
  const ledger = new AgingLedger();
  assert.equal(ledger.currentRevision, 0);
  assert.deepEqual(ledger.queryAging("2024-01-01", 0).currencies, {});
  const r1 = ledger.appendBatch({});
  assert.equal(r1, 1);
  assert.deepEqual(ledger.queryAging("2024-01-01", r1).currencies, {});
});

test("revisions are consecutive and clamped for queries", () => {
  const ledger = new AgingLedger();
  const r1 = ledger.appendBatch({
    invoices: [
      { id: "a", currency: "USD", amount: 5, invoiceDate: "2024-01-01", dueDate: "2024-01-01" },
    ],
  });
  const r2 = ledger.appendBatch({});
  assert.equal(r1, 1);
  assert.equal(r2, 2);
  assert.equal(ledger.currentRevision, 2);
  // Asking beyond the current revision clamps to the latest state.
  assert.equal(ledger.queryAging("2024-01-01", 999).revision, 2);
  assert.equal(ledger.queryAging("2024-01-01", 999).currencies["USD"].current, "5");
});

test("invalid inputs are rejected", () => {
  const ledger = new AgingLedger();
  assert.throws(() =>
    ledger.appendBatch({
      invoices: [
        { id: "a", currency: "USD", amount: 5, invoiceDate: "2024-02-30", dueDate: "2024-01-01" },
      ],
    })
  );
  assert.throws(() =>
    ledger.appendBatch({
      invoices: [
        { id: "a", currency: "USD", amount: 5, invoiceDate: "1999-01-01", dueDate: "2024-01-01" },
      ],
    })
  );
  assert.throws(() =>
    ledger.appendBatch({
      invoices: [
        { id: "a", currency: "USD", amount: "1.00001", invoiceDate: "2024-01-01", dueDate: "2024-01-01" },
      ],
    })
  );
  assert.throws(() => ledger.appendBatch({ payments: [{ invoiceId: "nope", amount: 1, date: "2024-01-01" }] }));
  ledger.appendBatch({
    invoices: [
      { id: "a", currency: "USD", amount: 5, invoiceDate: "2024-01-01", dueDate: "2024-01-01" },
    ],
  });
  assert.throws(() =>
    ledger.appendBatch({
      invoices: [
        { id: "a", currency: "USD", amount: 5, invoiceDate: "2024-01-01", dueDate: "2024-01-01" },
      ],
    })
  );
});
