import test from "node:test";
import assert from "node:assert/strict";
import {
  InvoiceLine,
  Reconciler,
  ReviewReport,
} from "../src/index";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A review spy backed by a controllable deferred. */
function controllableReview() {
  const calls: ReviewReport[] = [];
  const gate = deferred<boolean>();
  const review = (report: ReviewReport): Promise<boolean> => {
    calls.push(report);
    return gate.promise;
  };
  return { calls, gate, review };
}

const neverCalledReview = () => {
  const calls: ReviewReport[] = [];
  const review = (report: ReviewReport): Promise<boolean> => {
    calls.push(report);
    return Promise.resolve(true);
  };
  return { calls, review };
};

function invoiceStatus(rec: Reconciler, invoiceId: string): string | undefined {
  return rec
    .snapshot()
    .invoices.find((inv) => inv.invoiceId === invoiceId)?.status;
}

function receiptSnap(rec: Reconciler, receiptId: string) {
  const snap = rec
    .snapshot()
    .receipts.find((r) => r.receiptId === receiptId);
  assert.ok(snap, `receipt ${receiptId} missing`);
  return snap;
}

test("split lines to the same PO line are merged before variance check", async () => {
  const rec = new Reconciler([{ poLineId: "A", unitPriceCents: 10000 }]);
  rec.setReceipt("r1", "A", 10);

  // Each line alone is within the 5000-cent tolerance (diff 4000 each);
  // merged: qty 5, expected 50000, actual 58000, diff 8000 > 5000 -> review.
  const lines: InvoiceLine[] = [
    { poLineId: "A", quantity: 2, amountCents: 24000 },
    { poLineId: "A", quantity: 3, amountCents: 34000 },
  ];
  const { calls, gate, review } = controllableReview();
  const pending = rec.reconcile("inv-1", lines, review);

  assert.equal(calls.length, 1, "review called exactly once");
  assert.deepEqual(calls[0], {
    invoiceId: "inv-1",
    variances: [
      {
        poLineId: "A",
        mergedQuantity: 5,
        expectedCents: 50000,
        actualCents: 58000,
        diffCents: 8000,
      },
    ],
  });
  assert.equal(invoiceStatus(rec, "inv-1"), "pending_review");
  assert.equal(receiptSnap(rec, "r1").reservedQty, 5);

  gate.resolve(true);
  assert.equal(await pending, "authorized");
  assert.equal(receiptSnap(rec, "r1").authorizedQty, 5);
  assert.equal(receiptSnap(rec, "r1").reservedQty, 0);
});

test("variance exactly at the threshold does not trigger review", async () => {
  const rec = new Reconciler([{ poLineId: "A", unitPriceCents: 1000 }]);
  rec.setReceipt("r1", "A", 1000);
  const { calls, review } = neverCalledReview();

  // expected 100000, threshold max(5000, 5000) = 5000, diff exactly 5000.
  assert.equal(
    await rec.reconcile(
      "inv-abs",
      [{ poLineId: "A", quantity: 100, amountCents: 105000 }],
      review,
    ),
    "authorized",
  );
  // expected 200000, threshold max(5000, 10000) = 10000, diff exactly 10000.
  assert.equal(
    await rec.reconcile(
      "inv-rel",
      [{ poLineId: "A", quantity: 200, amountCents: 210000 }],
      review,
    ),
    "authorized",
  );
  assert.equal(calls.length, 0, "review must not be called at the threshold");
  assert.equal(receiptSnap(rec, "r1").authorizedQty, 300);
});

test("insufficient approved quantity fails the whole invoice without review", async () => {
  const rec = new Reconciler([{ poLineId: "A", unitPriceCents: 1000 }]);
  rec.setReceipt("r1", "A", 5);
  const { calls, review } = neverCalledReview();

  const status = await rec.reconcile(
    "inv-1",
    [{ poLineId: "A", quantity: 6, amountCents: 6000 }],
    review,
  );
  assert.equal(status, "rejected");
  assert.equal(calls.length, 0);
  assert.equal(receiptSnap(rec, "r1").authorizedQty, 0);
  assert.equal(receiptSnap(rec, "r1").availableQty, 5);

  // Retry is allowed after more quantity is approved.
  rec.setReceipt("r1", "A", 10);
  const retry = await rec.reconcile(
    "inv-1",
    [{ poLineId: "A", quantity: 6, amountCents: 6000 }],
    review,
  );
  assert.equal(retry, "authorized");
  assert.equal(receiptSnap(rec, "r1").authorizedQty, 6);
});

test("review rejection and review error release the whole invoice; retry allowed", async () => {
  const rec = new Reconciler([{ poLineId: "A", unitPriceCents: 1000 }]);
  rec.setReceipt("r1", "A", 10);
  const lines: InvoiceLine[] = [
    { poLineId: "A", quantity: 4, amountCents: 40000 },
  ];

  // Rejection path.
  const first = controllableReview();
  const p1 = rec.reconcile("inv-1", lines, first.review);
  assert.equal(receiptSnap(rec, "r1").reservedQty, 4);
  first.gate.resolve(false);
  assert.equal(await p1, "rejected");
  assert.equal(receiptSnap(rec, "r1").reservedQty, 0);
  assert.equal(receiptSnap(rec, "r1").availableQty, 10);

  // Throwing review path.
  const throwing = () => Promise.reject(new Error("review service down"));
  assert.equal(await rec.reconcile("inv-1", lines, throwing), "rejected");
  assert.equal(receiptSnap(rec, "r1").reservedQty, 0);

  // Retry with approval succeeds.
  const third = controllableReview();
  const p3 = rec.reconcile("inv-1", lines, third.review);
  third.gate.resolve(true);
  assert.equal(await p3, "authorized");
  assert.equal(receiptSnap(rec, "r1").authorizedQty, 4);
});

test("receipt correction invalidates only the newest invoices and releases cross-line reservations", async () => {
  const rec = new Reconciler([
    { poLineId: "A", unitPriceCents: 1000 },
    { poLineId: "B", unitPriceCents: 1000 },
  ]);
  rec.setReceipt("rA", "A", 13);
  rec.setReceipt("rB", "B", 10);

  const i1 = controllableReview();
  const i2 = controllableReview();
  const i3 = controllableReview();
  const p1 = rec.reconcile(
    "inv-1",
    [{ poLineId: "A", quantity: 6, amountCents: 60000 }],
    i1.review,
  );
  const p2 = rec.reconcile(
    "inv-2",
    [
      { poLineId: "A", quantity: 5, amountCents: 50000 },
      { poLineId: "B", quantity: 4, amountCents: 40000 },
    ],
    i2.review,
  );
  const p3 = rec.reconcile(
    "inv-3",
    [{ poLineId: "A", quantity: 2, amountCents: 20000 }],
    i3.review,
  );
  assert.equal(receiptSnap(rec, "rA").reservedQty, 13);
  assert.equal(receiptSnap(rec, "rB").reservedQty, 4);

  // Drop to 11: only the newest invoice (inv-3, 2 units) must be invalidated.
  rec.setReceipt("rA", "A", 11);
  assert.equal(invoiceStatus(rec, "inv-3"), "invalidated");
  assert.equal(invoiceStatus(rec, "inv-1"), "pending_review");
  assert.equal(invoiceStatus(rec, "inv-2"), "pending_review");
  assert.equal(receiptSnap(rec, "rA").reservedQty, 11);
  assert.equal(receiptSnap(rec, "rB").reservedQty, 4);

  // Drop to 5: inv-2 (newer) is invalidated before inv-1; inv-2's reservation
  // on PO line B must be released too.
  rec.setReceipt("rA", "A", 5);
  assert.equal(invoiceStatus(rec, "inv-2"), "invalidated");
  assert.equal(invoiceStatus(rec, "inv-1"), "invalidated");
  assert.equal(receiptSnap(rec, "rA").reservedQty, 0);
  assert.equal(receiptSnap(rec, "rB").reservedQty, 0);
  assert.equal(receiptSnap(rec, "rB").availableQty, 10);

  // Late review resolutions must not resurrect invalidated invoices.
  i1.gate.resolve(true);
  i2.gate.resolve(true);
  i3.gate.resolve(true);
  assert.equal(await p1, "invalidated");
  assert.equal(await p2, "invalidated");
  assert.equal(await p3, "invalidated");
  assert.equal(receiptSnap(rec, "rA").reservedQty, 0);
  assert.equal(receiptSnap(rec, "rB").reservedQty, 0);

  // Invalidated invoices may be retried with the same content.
  const retry = controllableReview();
  const p4 = rec.reconcile(
    "inv-3",
    [{ poLineId: "A", quantity: 2, amountCents: 20000 }],
    retry.review,
  );
  retry.gate.resolve(true);
  assert.equal(await p4, "authorized");
  assert.equal(receiptSnap(rec, "rA").authorizedQty, 2);
});

test("correction below authorized quantity fails and leaves state untouched", async () => {
  const rec = new Reconciler([{ poLineId: "A", unitPriceCents: 1000 }]);
  rec.setReceipt("r1", "A", 10);
  const { review } = neverCalledReview();
  assert.equal(
    await rec.reconcile(
      "inv-1",
      [{ poLineId: "A", quantity: 6, amountCents: 6000 }],
      review,
    ),
    "authorized",
  );

  const before = rec.snapshot();
  assert.throws(() => rec.setReceipt("r1", "A", 5));
  assert.deepEqual(rec.snapshot(), before);

  // Reducing only the unoccupied part is fine and invalidates nothing.
  rec.setReceipt("r1", "A", 6);
  assert.equal(receiptSnap(rec, "r1").authorizedQty, 6);
  assert.equal(receiptSnap(rec, "r1").availableQty, 0);
});

test("receipts cannot change PO line; unknown PO lines are rejected", () => {
  const rec = new Reconciler([{ poLineId: "A", unitPriceCents: 1000 }]);
  rec.setReceipt("r1", "A", 10);
  assert.throws(() => rec.setReceipt("r1", "B", 10));
  assert.throws(() => rec.setReceipt("r2", "B", 10));
  // Zero approved quantity is allowed.
  rec.setReceipt("r3", "A", 0);
  assert.equal(receiptSnap(rec, "r3").approvedQty, 0);
});

test("authorized invoices cannot be reconciled again; invoice content is immutable", async () => {
  const rec = new Reconciler([{ poLineId: "A", unitPriceCents: 1000 }]);
  rec.setReceipt("r1", "A", 10);
  const { review } = neverCalledReview();
  const lines: InvoiceLine[] = [
    { poLineId: "A", quantity: 4, amountCents: 4000 },
  ];
  assert.equal(await rec.reconcile("inv-1", lines, review), "authorized");

  await assert.rejects(() => rec.reconcile("inv-1", lines, review));
  await assert.rejects(() =>
    rec.reconcile(
      "inv-1",
      [{ poLineId: "A", quantity: 5, amountCents: 5000 }],
      review,
    ),
  );
  assert.equal(receiptSnap(rec, "r1").authorizedQty, 4);
});

test("allocation follows receipt creation order", async () => {
  const rec = new Reconciler([{ poLineId: "A", unitPriceCents: 1000 }]);
  rec.setReceipt("r1", "A", 3);
  rec.setReceipt("r2", "A", 5);
  const { review } = neverCalledReview();
  assert.equal(
    await rec.reconcile(
      "inv-1",
      [{ poLineId: "A", quantity: 4, amountCents: 4000 }],
      review,
    ),
    "authorized",
  );
  assert.deepEqual(receiptSnap(rec, "r1").allocations, [
    { invoiceId: "inv-1", quantity: 3, kind: "authorized" },
  ]);
  assert.deepEqual(receiptSnap(rec, "r2").allocations, [
    { invoiceId: "inv-1", quantity: 1, kind: "authorized" },
  ]);
});

test("input validation", async () => {
  const rec = new Reconciler([{ poLineId: "A", unitPriceCents: 1000 }]);
  rec.setReceipt("r1", "A", 10);
  const { review } = neverCalledReview();
  await assert.rejects(() =>
    rec.reconcile(
      "inv-1",
      [{ poLineId: "A", quantity: 0, amountCents: 0 }],
      review,
    ),
  );
  await assert.rejects(() =>
    rec.reconcile(
      "inv-1",
      [{ poLineId: "A", quantity: 1.5, amountCents: 100 }],
      review,
    ),
  );
  await assert.rejects(() =>
    rec.reconcile(
      "inv-1",
      [{ poLineId: "ZZZ", quantity: 1, amountCents: 100 }],
      review,
    ),
  );
  await assert.rejects(() => rec.reconcile("inv-1", [], review));
  assert.throws(() => rec.setReceipt("r2", "A", -1));
  assert.throws(
    () => new Reconciler([{ poLineId: "A", unitPriceCents: 10.5 }]),
  );
});
