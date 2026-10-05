import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger, LedgerError } from '../src/index.js';
import type { Snapshot } from '../src/index.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function makeClock(start: number) {
  let t = start;
  return {
    now: () => t,
    set(ms: number) {
      t = ms;
    },
    advance(ms: number) {
      t += ms;
    },
  };
}

function tempDbPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-test-'));
  return { dir, path: join(dir, 'ledger.db') };
}

function assertInvariant(snapshot: Snapshot): void {
  let total = 0;
  for (const b of snapshot.batches) {
    assert.equal(b.allocated, b.available + b.spent + b.expired, `batch ${b.month} splits`);
    assert.ok(b.available >= 0 && b.spent >= 0 && b.expired >= 0, `batch ${b.month} non-negative`);
    total += b.available;
  }
  assert.equal(snapshot.totalAvailable, total, 'totalAvailable equals sum of available');
}

const T0 = Date.UTC(2026, 0, 15, 12, 0, 0); // 2026-01-15T12:00:00Z

test('cross-batch redemptions, cancel before/after earlier batch expiry', () => {
  const { dir, path } = tempDbPath();
  try {
    const clock = makeClock(T0);
    const ledger = new Ledger(path, { clock: clock.now });
    const emp = 'emp-1';

    // Jan batch: 500 (expires 2026-05-01T00:00:00Z)
    ledger.credit(emp, 500, 'credit-jan');
    // Feb batch: 1000 (expires 2026-06-01T00:00:00Z)
    clock.set(Date.UTC(2026, 1, 15, 12, 0, 0));
    ledger.credit(emp, 1000, 'credit-feb');

    // Redemption A crosses both batches: 500 from Jan + 200 from Feb.
    clock.set(Date.UTC(2026, 3, 30, 23, 0, 0));
    const a = ledger.redeem(emp, 700, 'redeem-a');
    assert.deepEqual(a.shares, [
      { month: '2026-01', cents: 500 },
      { month: '2026-02', cents: 200 },
    ]);
    // Redemption B consumes Feb only.
    clock.set(Date.UTC(2026, 3, 30, 23, 30, 0));
    const b = ledger.redeem(emp, 500, 'redeem-b');
    assert.deepEqual(b.shares, [{ month: '2026-02', cents: 500 }]);

    let snap = ledger.snapshot(emp);
    assertInvariant(snap);
    assert.equal(snap.totalAvailable, 300);

    // Cancel A after the Jan batch expired (2026-05-01T00:30, within 24h of A).
    clock.set(Date.UTC(2026, 4, 1, 0, 30, 0));
    const cancelA = ledger.cancel(emp, a.redemptionId, 'cancel-a');
    assert.deepEqual(cancelA.shares, a.shares);
    assert.equal(cancelA.cents, 700);

    snap = ledger.snapshot(emp);
    assertInvariant(snap);
    const jan = snap.batches.find((x) => x.month === '2026-01');
    const feb = snap.batches.find((x) => x.month === '2026-02');
    // Jan share of A was already expired -> counted as expired, not spendable.
    assert.deepEqual(
      { allocated: jan!.allocated, available: jan!.available, spent: jan!.spent, expired: jan!.expired },
      { allocated: 500, available: 0, spent: 0, expired: 500 },
    );
    // Feb share of A became available again; B's attribution (spent 500) unchanged.
    assert.deepEqual(
      { allocated: feb!.allocated, available: feb!.available, spent: feb!.spent, expired: feb!.expired },
      { allocated: 1000, available: 500, spent: 500, expired: 0 },
    );

    // Expired refund cannot be spent: only 500 available.
    assert.throws(
      () => ledger.redeem(emp, 501, 'redeem-too-much'),
      (err) => err instanceof LedgerError && err.code === 'INSUFFICIENT_FUNDS',
    );

    // Cancel B (within 24h of B's redemption): Feb share still live -> spendable again.
    clock.set(Date.UTC(2026, 4, 1, 1, 0, 0));
    const cancelB = ledger.cancel(emp, b.redemptionId, 'cancel-b');
    assert.equal(cancelB.cents, 500);
    snap = ledger.snapshot(emp);
    assertInvariant(snap);
    assert.equal(snap.totalAvailable, 1000);

    // Refunded Feb balance is consumed in expiry order before a later batch.
    clock.set(Date.UTC(2026, 4, 2, 0, 0, 0));
    ledger.credit(emp, 500, 'credit-may');
    const c = ledger.redeem(emp, 1200, 'redeem-c');
    assert.deepEqual(c.shares, [
      { month: '2026-02', cents: 1000 },
      { month: '2026-05', cents: 200 },
    ]);
    snap = ledger.snapshot(emp);
    assertInvariant(snap);
    ledger.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cancel window and dedup window exact boundaries, reopen, replay', () => {
  const { dir, path } = tempDbPath();
  try {
    const clock = makeClock(T0);
    let ledger = new Ledger(path, { clock: clock.now });
    const emp = 'emp-2';

    ledger.credit(emp, 10_000, 'k-credit');
    const r1 = ledger.redeem(emp, 1000, 'k-redeem-1');
    const r2 = ledger.redeem(emp, 2000, 'k-redeem-2');

    // Cancel at exactly redemption+24h is rejected.
    clock.set(T0 + DAY);
    assert.throws(
      () => ledger.cancel(emp, r1.redemptionId, 'k-cancel-late'),
      (err) => err instanceof LedgerError && err.code === 'CANCEL_WINDOW_EXPIRED',
    );
    // Failed cancel leaves no dedup record: same key may be reused for another request.
    clock.set(T0 + DAY - 1);
    const c2 = ledger.cancel(emp, r2.redemptionId, 'k-cancel-late');
    assert.equal(c2.cents, 2000);

    // Cancel at redemption+24h-1ms succeeds.
    clock.set(T0 + DAY - 1);
    const c1 = ledger.cancel(emp, r1.redemptionId, 'k-cancel-1');
    assert.equal(c1.cents, 1000);

    // Dedup replay inside 48h returns the first result (comparison excludes call time).
    clock.set(T0 + 2 * DAY - 1);
    const replay = ledger.redeem(emp, 1000, 'k-redeem-1');
    assert.equal(replay.redemptionId, r1.redemptionId);
    // Replaying a successful cancel after the 24h cancel window still succeeds via dedup.
    const replayCancel = ledger.cancel(emp, r1.redemptionId, 'k-cancel-1');
    assert.deepEqual(replayCancel, c1);

    // Reopen: state and live dedup records survive.
    ledger.close();
    ledger = new Ledger(path, { clock: clock.now });
    const replayAfterReopen = ledger.redeem(emp, 1000, 'k-redeem-1');
    assert.equal(replayAfterReopen.redemptionId, r1.redemptionId);

    // Cancelling an already-cancelled redemption with a NEW key returns the
    // original cancel result (no 24h check, no double refund).
    const again = ledger.cancel(emp, r1.redemptionId, 'k-cancel-other-key');
    assert.deepEqual(again, c1);
    const snapAfterDupCancel = ledger.snapshot(emp);
    assertInvariant(snapAfterDupCancel);

    // Re-crediting the same month returns the original record.
    const dupCredit = ledger.credit(emp, 10_000, 'k-credit-again');
    assert.equal(dupCredit.created, false);
    assert.equal(dupCredit.cents, 10_000);
    assert.equal(dupCredit.month, '2026-01');

    // At exactly first-success+48h the same key is treated as a new request.
    clock.set(T0 + 2 * DAY);
    const fresh = ledger.redeem(emp, 1000, 'k-redeem-1');
    assert.notEqual(fresh.redemptionId, r1.redemptionId);
    assertInvariant(ledger.snapshot(emp));
    ledger.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('failed redeem is atomic and leaves no dedup record; shared key namespace', () => {
  const { dir, path } = tempDbPath();
  try {
    const clock = makeClock(T0);
    const ledger = new Ledger(path, { clock: clock.now });
    const emp = 'emp-3';

    ledger.credit(emp, 500, 'k1');
    const before = ledger.snapshot(emp);
    assert.throws(
      () => ledger.redeem(emp, 600, 'k2'),
      (err) => err instanceof LedgerError && err.code === 'INSUFFICIENT_FUNDS',
    );
    assert.deepEqual(ledger.snapshot(emp), before);

    // Key k2 was not recorded by the failed op: a different request may reuse it.
    const ok = ledger.redeem(emp, 500, 'k2');
    assert.equal(ok.cents, 500);

    // Keys share one namespace across the three write ops.
    assert.throws(
      () => ledger.redeem(emp, 100, 'k1'),
      (err) => err instanceof LedgerError && err.code === 'KEY_CONFLICT',
    );
    assert.throws(
      () => ledger.cancel(emp, ok.redemptionId, 'k1'),
      (err) => err instanceof LedgerError && err.code === 'KEY_CONFLICT',
    );
    // Same key + same op but different params also conflicts.
    assert.throws(
      () => ledger.credit(emp, 999, 'k1'),
      (err) => err instanceof LedgerError && err.code === 'KEY_CONFLICT',
    );
    ledger.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('expiry boundary is exact and needs no cleanup call; spent survives expiry', () => {
  const { dir, path } = tempDbPath();
  try {
    const clock = makeClock(T0); // Jan 2026 batch, expires 2026-05-01T00:00:00Z
    const ledger = new Ledger(path, { clock: clock.now });
    const emp = 'emp-4';
    ledger.credit(emp, 1000, 'k1');

    // One millisecond before expiry the batch is still usable.
    clock.set(Date.UTC(2026, 4, 1, 0, 0, 0) - 1);
    const r = ledger.redeem(emp, 400, 'k2');
    assert.deepEqual(r.shares, [{ month: '2026-01', cents: 400 }]);

    // At exactly expiry the remaining 600 is gone; spent 400 stays spent.
    clock.set(Date.UTC(2026, 4, 1, 0, 0, 0));
    const snap = ledger.snapshot(emp);
    assertInvariant(snap);
    assert.equal(snap.totalAvailable, 0);
    const jan = snap.batches[0]!;
    assert.deepEqual(
      { allocated: jan.allocated, available: jan.available, spent: jan.spent, expired: jan.expired },
      { allocated: 1000, available: 0, spent: 400, expired: 600 },
    );
    assert.throws(
      () => ledger.redeem(emp, 1, 'k3'),
      (err) => err instanceof LedgerError && err.code === 'INSUFFICIENT_FUNDS',
    );
    ledger.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('credit dedup within the same month and unknown redemption', () => {
  const { dir, path } = tempDbPath();
  try {
    const clock = makeClock(T0);
    const ledger = new Ledger(path, { clock: clock.now });
    const emp = 'emp-5';
    const first = ledger.credit(emp, 700, 'a');
    assert.equal(first.created, true);
    clock.advance(HOUR);
    const dup = ledger.credit(emp, 700, 'b');
    assert.deepEqual(dup, { ...first, created: false });
    assert.equal(ledger.snapshot(emp).totalAvailable, 700);
    assert.throws(
      () => ledger.cancel(emp, '99999', 'c'),
      (err) => err instanceof LedgerError && err.code === 'REDEMPTION_NOT_FOUND',
    );
    ledger.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
