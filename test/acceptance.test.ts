import assert from "node:assert/strict";
import { test } from "node:test";
import { AgingLedger } from "../src/ledger.ts";

/**
 * Acceptance scenario from the specification:
 * invoice of 100 due Jan 31; a payment of 40 with business date Feb 5 is only
 * entered in March; a reversal of 10 with business date Feb 8 is entered even
 * later. Historical revisions must keep their original values.
 */
test("late-entered payment and reversal do not rewrite history", () => {
  const ledger = new AgingLedger();

  const revInvoice = ledger.appendBatch({
    invoices: [
      {
        invoiceId: "INV-1",
        currency: "USD",
        amount: 100,
        invoiceDate: "2024-01-05",
        dueDate: "2024-01-31",
      },
    ],
  });
  // Feb 10: 10 days past the Jan 31 due date -> 1-30 bucket.
  const before = ledger.queryAging("2024-02-10", revInvoice);
  assert.equal(before.USD.days1To30, "100");

  // Payment with business date Feb 5, entered later (e.g. in March).
  const revPayment = ledger.appendBatch({
    payments: [{ invoiceId: "INV-1", amount: 40, businessDate: "2024-02-05" }],
  });
  const afterPayment = ledger.queryAging("2024-02-10", revPayment);
  assert.equal(afterPayment.USD.days1To30, "60");
  // The earlier revision still shows the original amount.
  assert.equal(ledger.queryAging("2024-02-10", revInvoice).USD.days1To30, "100");

  // Reversal with business date Feb 8, entered in a later revision.
  const revReversal = ledger.appendBatch({
    reversals: [{ invoiceId: "INV-1", amount: 10, businessDate: "2024-02-08" }],
  });
  const afterReversal = ledger.queryAging("2024-02-10", revReversal);
  assert.equal(afterReversal.days1To30 ?? undefined, undefined);
  assert.equal(afterReversal.USD.days1To30, "70");
  // Old revisions are immutable.
  assert.equal(ledger.queryAging("2024-02-10", revInvoice).USD.days1To30, "100");
  assert.equal(ledger.queryAging("2024-02-10", revPayment).USD.days1To30, "60");

  // Everything sits in the 1-30 bucket; all other buckets are zero.
  for (const report of [afterPayment, afterReversal]) {
    assert.equal(report.USD.current, "0");
    assert.equal(report.USD.days31To60, "0");
    assert.equal(report.USD.days61To90, "0");
    assert.equal(report.USD.over90, "0");
  }

  // The reversal restores the balance from its own business date (Feb 8),
  // not retroactively: on Feb 7 the balance at the latest revision is 60.
  assert.equal(ledger.queryAging("2024-02-07").USD.days1To30, "60");
  assert.equal(ledger.queryAging("2024-02-08").USD.days1To30, "70");
});

test("revisions increment per batch and queries default to latest", () => {
  const ledger = new AgingLedger();
  assert.equal(ledger.currentRevision, 0);
  const r1 = ledger.appendBatch({});
  const r2 = ledger.appendBatch({
    invoices: [
      {
        invoiceId: "X",
        currency: "EUR",
        amount: "10.5",
        invoiceDate: "2024-03-01",
        dueDate: "2024-03-01",
      },
    ],
  });
  assert.deepEqual([r1, r2, ledger.currentRevision], [1, 2, 2]);
  assert.equal(ledger.queryAging("2024-03-01").EUR.current, "10.5");
  // Revision 1 predates the invoice: no visible currency.
  assert.deepEqual(ledger.queryAging("2024-03-01", r1), {});
  assert.equal(ledger.queryAging("2024-03-01", 0).EUR, undefined);
});

test("invalid revisions are rejected", () => {
  const ledger = new AgingLedger();
  ledger.appendBatch({});
  assert.throws(() => ledger.queryAging("2024-01-01", 2), /Invalid revision/);
  assert.throws(() => ledger.queryAging("2024-01-01", -1), /Invalid revision/);
  assert.throws(() => ledger.queryAging("2024-01-01", 1.5), /Invalid revision/);
});
