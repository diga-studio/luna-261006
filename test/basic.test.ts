import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommissionLedger } from '../src/index.js';
import { tempDbPath } from './helpers.js';

const MONTH = '2026-09';

test('12-level chain: each level gets the correct rate', () => {
  const ledger = new CommissionLedger(tempDbPath('chain'));
  const ids: string[] = [];
  for (let i = 0; i <= 12; i += 1) {
    ids.push(`m${i}`);
    ledger.addMember(`m${i}`, i === 0 ? null : `m${i - 1}`);
  }
  ledger.setMonthlyPv('m12', MONTH, 100);

  const batch = ledger.startSettlement(MONTH);
  let info = batch;
  while (info.status !== 'completed') info = ledger.advance(batch.batchId);

  // m12 is the PV holder; m11 is level 1, ..., m0 is level 12.
  const expected: Array<[string, number]> = [
    ['m11', 500], // 5%
    ['m10', 300], // 3%
    ['m9', 200], // 2%
    ['m8', 200],
    ['m7', 200],
    ['m6', 100], // 1%
    ['m5', 100],
    ['m4', 100],
    ['m3', 100],
    ['m2', 100],
    ['m1', 100],
    ['m0', 100],
    ['m12', 0], // own PV never counts
  ];
  for (const [id, cents] of expected) {
    const result = ledger.getResult(batch.batchId, id);
    assert.ok(result, `missing result for ${id}`);
    assert.equal(result.commissionCents, cents, `wrong commission for ${id}`);
    assert.equal(result.needsReview, false);
  }
  ledger.close();
});

test('review flag: exactly $2500 is not flagged, anything above is', () => {
  const ledger = new CommissionLedger(tempDbPath('review'));
  ledger.addMember('boss');
  ledger.addMember('edge', 'boss');
  ledger.addMember('over', 'boss');
  ledger.setMonthlyPv('edge', MONTH, 50000); // 5% = 250000 cents = exactly $2500
  ledger.setMonthlyPv('over', MONTH, 50020); // 5% = 250100 cents

  const batch = ledger.startSettlement(MONTH);
  ledger.advance(batch.batchId);

  const result = ledger.getResult(batch.batchId, 'boss');
  assert.ok(result);
  assert.equal(result.commissionCents, 250000 + 250100);
  assert.equal(result.needsReview, true); // total exceeds threshold

  const ledger2 = new CommissionLedger(tempDbPath('review-exact'));
  ledger2.addMember('boss');
  ledger2.addMember('edge', 'boss');
  ledger2.setMonthlyPv('edge', MONTH, 50000);
  const batch2 = ledger2.startSettlement(MONTH);
  ledger2.advance(batch2.batchId);
  const exact = ledger2.getResult(batch2.batchId, 'boss');
  assert.ok(exact);
  assert.equal(exact.commissionCents, 250000);
  assert.equal(exact.needsReview, false);
  ledger.close();
  ledger2.close();
});

test('zero-commission members still get a permanent record', () => {
  const ledger = new CommissionLedger(tempDbPath('zero'));
  ledger.addMember('lonely');
  ledger.addMember('also-lonely');
  const batch = ledger.startSettlement(MONTH);
  ledger.advance(batch.batchId);
  for (const id of ['lonely', 'also-lonely']) {
    const result = ledger.getResult(batch.batchId, id);
    assert.ok(result, `missing record for ${id}`);
    assert.equal(result.commissionCents, 0);
    assert.equal(result.needsReview, false);
  }
  ledger.close();
});

test('advance completes at most 200 members per call', () => {
  const ledger = new CommissionLedger(tempDbPath('paging'));
  for (let i = 0; i < 250; i += 1) ledger.addMember(`u${i}`);
  const batch = ledger.startSettlement(MONTH);
  assert.equal(batch.total, 250);

  const first = ledger.advance(batch.batchId, 999); // clamped to 200
  assert.equal(first.done, 200);
  assert.equal(first.status, 'processing');

  const second = ledger.advance(batch.batchId);
  assert.equal(second.done, 250);
  assert.equal(second.status, 'completed');

  const third = ledger.advance(batch.batchId); // no-op after completion
  assert.equal(third.done, 250);
  assert.equal(third.status, 'completed');
  ledger.close();
});

test('results are not readable while the batch is processing', () => {
  const ledger = new CommissionLedger(tempDbPath('hidden'));
  for (let i = 0; i < 5; i += 1) ledger.addMember(`u${i}`);
  const batch = ledger.startSettlement(MONTH);
  ledger.advance(batch.batchId, 2); // partial: 2 of 5 settled
  assert.throws(() => ledger.getResult(batch.batchId, 'u0'), /still processing/);
  assert.throws(() => ledger.getAllResults(batch.batchId), /still processing/);
  const info = ledger.getBatch(batch.batchId);
  assert.ok(info);
  assert.equal(info.done, 2);
  assert.equal(info.status, 'processing');
  ledger.close();
});

test('input validation', () => {
  const ledger = new CommissionLedger(tempDbPath('validation'));
  ledger.addMember('a');
  assert.throws(() => ledger.setMonthlyPv('a', MONTH, -1));
  assert.throws(() => ledger.setMonthlyPv('a', MONTH, 100000));
  assert.throws(() => ledger.setMonthlyPv('a', MONTH, 1.5));
  assert.throws(() => ledger.setMonthlyPv('ghost', MONTH, 1), /unknown member/);
  assert.throws(() => ledger.setMonthlyPv('a', '2026-13', 1));
  assert.throws(() => ledger.startSettlement('not-a-month'));
  ledger.setMonthlyPv('a', MONTH, 0);
  ledger.setMonthlyPv('a', MONTH, 99999);
  ledger.close();
});
