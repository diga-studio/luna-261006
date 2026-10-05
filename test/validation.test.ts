import assert from "node:assert/strict";
import { test } from "node:test";
import { AgingLedger } from "../src/ledger.ts";

test("duplicate invoice ids are rejected", () => {
  const ledger = new AgingLedger();
  const invoice = {
    invoiceId: "X",
    currency: "USD",
    amount: 1,
    invoiceDate: "2024-01-01",
    dueDate: "2024-01-01",
  };
  ledger.appendBatch({ invoices: [invoice] });
  assert.throws(() => ledger.appendBatch({ invoices: [invoice] }), /Duplicate invoice id/);
});

test("events for unknown invoices are rejected", () => {
  const ledger = new AgingLedger();
  assert.throws(
    () =>
      ledger.appendBatch({
        payments: [{ invoiceId: "NOPE", amount: 1, businessDate: "2024-01-01" }],
      }),
    /Unknown invoice id/,
  );
});

test("malformed amounts and dates are rejected", () => {
  const ledger = new AgingLedger();
  const base = {
    invoiceId: "X",
    currency: "USD",
    invoiceDate: "2024-01-01",
    dueDate: "2024-01-01",
  };
  assert.throws(
    () => ledger.appendBatch({ invoices: [{ ...base, amount: "1.00001" }] }),
    /decimal places/,
  );
  assert.throws(
    () => ledger.appendBatch({ invoices: [{ ...base, amount: "abc" }] }),
    /Invalid amount/,
  );
  assert.throws(
    () =>
      ledger.appendBatch({
        invoices: [{ ...base, amount: 1, invoiceDate: "1999-12-31" }],
      }),
    /out of range/,
  );
  assert.throws(
    () =>
      ledger.appendBatch({
        invoices: [{ ...base, amount: 1, invoiceDate: "2023-02-29" }],
      }),
    /Invalid day/,
  );
  assert.throws(
    () =>
      ledger.appendBatch({
        invoices: [{ ...base, amount: 1, dueDate: "2100-01-01" }],
      }),
    /out of range/,
  );
});
