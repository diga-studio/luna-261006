import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommissionLedger } from '../src/index.js';
import { referenceCommissions, tempDbPath, type FrozenInput } from './helpers.js';

const MONTH = '2026-09';

function sampleInput(): FrozenInput {
  const sponsors = new Map<string, string | null>([['top', null]]);
  const pv = new Map<string, number>();
  for (let i = 0; i < 10; i += 1) {
    sponsors.set(`d${i}`, 'top');
    pv.set(`d${i}`, 100 * (i + 1));
  }
  return { sponsors, pv };
}

function applyInput(ledger: CommissionLedger, input: FrozenInput, month: string): void {
  for (const [id, sponsor] of input.sponsors) ledger.addMember(id, sponsor);
  for (const [id, pv] of input.pv) ledger.setMonthlyPv(id, month, pv);
}

test('duplicate startSettlement returns the original batch without re-snapshotting', () => {
  const dbPath = tempDbPath('dup-start');
  const input = sampleInput();
  const ledger = new CommissionLedger(dbPath);
  applyInput(ledger, input, MONTH);

  const first = ledger.startSettlement(MONTH);
  // Caller "lost" the response; inputs changed before the retry.
  ledger.addMember('late', 'top');
  ledger.setMonthlyPv('late', MONTH, 12345);
  const retry = ledger.startSettlement(MONTH);
  assert.equal(retry.batchId, first.batchId);
  assert.equal(retry.total, first.total);

  // Same guarantee across a restart.
  ledger.close();
  const reopened = new CommissionLedger(dbPath);
  const afterRestart = reopened.startSettlement(MONTH);
  assert.equal(afterRestart.batchId, first.batchId);

  let info = afterRestart;
  while (info.status !== 'completed') info = reopened.advance(first.batchId);
  assert.equal(info.total, 11, 'batch must only contain members frozen at first start');

  const expected = referenceCommissions(input);
  for (const result of reopened.getAllResults(first.batchId)) {
    assert.equal(result.commissionCents, expected.get(result.memberId));
  }
  reopened.close();
});

test('advance retry after a lost response: progress never regresses, no double counting', () => {
  const dbPath = tempDbPath('retry-advance');
  const input = sampleInput();
  const ledger = new CommissionLedger(dbPath);
  applyInput(ledger, input, MONTH);
  const batch = ledger.startSettlement(MONTH);

  const step1 = ledger.advance(batch.batchId, 4);
  assert.equal(step1.done, 4);
  // Simulate the response being lost, then the process exiting.
  ledger.close();

  const resumed = new CommissionLedger(dbPath);
  const observed = resumed.getBatch(batch.batchId);
  assert.ok(observed);
  assert.equal(observed.done, 4, 'persisted progress survives restart');

  // Retry the same advance: it must continue forward, not redo finished work.
  const step2 = resumed.advance(batch.batchId, 4);
  assert.equal(step2.done, 8);
  const step3 = resumed.advance(batch.batchId, 4);
  assert.equal(step3.done, 11);
  assert.equal(step3.status, 'completed');

  // Every member has exactly one record and matches the independent calculation.
  const expected = referenceCommissions(input);
  const results = resumed.getAllResults(batch.batchId);
  assert.equal(results.length, expected.size);
  const ids = new Set(results.map((r) => r.memberId));
  assert.equal(ids.size, results.length, 'no duplicate commission records');
  for (const result of results) {
    assert.equal(result.commissionCents, expected.get(result.memberId));
  }
  resumed.close();
});

test('different months get independent batches', () => {
  const ledger = new CommissionLedger(tempDbPath('months'));
  ledger.addMember('top');
  ledger.addMember('kid', 'top');
  ledger.setMonthlyPv('kid', '2026-08', 100);
  ledger.setMonthlyPv('kid', '2026-09', 200);

  const august = ledger.startSettlement('2026-08');
  const september = ledger.startSettlement('2026-09');
  assert.notEqual(august.batchId, september.batchId);

  ledger.advance(august.batchId);
  ledger.advance(september.batchId);
  assert.equal(ledger.getResult(august.batchId, 'top')?.commissionCents, 500);
  assert.equal(ledger.getResult(september.batchId, 'top')?.commissionCents, 1000);
  assert.equal(ledger.getBatchByMonth('2026-08')?.batchId, august.batchId);
  assert.equal(ledger.getBatchByMonth('2026-07'), null);
  ledger.close();
});
