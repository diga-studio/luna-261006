import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommissionLedger } from '../src/index.js';
import { referenceCommissions, tempDbPath, type FrozenInput } from './helpers.js';

const MONTH = '2026-09';

function buildInitialInput(): FrozenInput {
  const sponsors = new Map<string, string | null>([
    ['root', null],
    ['a', 'root'],
    ['b', 'root'],
    ['c', 'a'],
    ['d', 'b'],
    ['e', 'c'],
  ]);
  const pv = new Map<string, number>([
    ['c', 1000],
    ['d', 2000],
    ['e', 500],
  ]);
  return { sponsors, pv };
}

function applyInput(ledger: CommissionLedger, input: FrozenInput, month: string): void {
  for (const [id, sponsor] of input.sponsors) ledger.addMember(id, sponsor);
  for (const [id, pv] of input.pv) ledger.setMonthlyPv(id, month, pv);
}

test('snapshot isolation: edits after start do not affect the batch, even across restart', () => {
  const dbPath = tempDbPath('freeze');
  const input = buildInitialInput();

  const ledger = new CommissionLedger(dbPath);
  applyInput(ledger, input, MONTH);
  const batch = ledger.startSettlement(MONTH);
  const partial = ledger.advance(batch.batchId, 2);
  assert.equal(partial.done, 2);
  assert.equal(partial.status, 'processing');

  // Mutate live inputs while the batch is mid-flight.
  ledger.addMember('c', 'b'); // re-sponsor: c moves from a to b
  ledger.addMember('newcomer', 'root'); // brand-new member
  ledger.setMonthlyPv('newcomer', MONTH, 7777);
  ledger.setMonthlyPv('d', MONTH, 99999); // overwrite PV
  ledger.setMonthlyPv('c', MONTH, 1);
  ledger.close();

  // Reopen the database (simulates quitting the program overnight).
  const resumed = new CommissionLedger(dbPath);
  const seen = resumed.getBatch(batch.batchId);
  assert.ok(seen);
  assert.equal(seen.done, 2, 'persisted progress must not regress');

  let info = seen;
  while (info.status !== 'completed') info = resumed.advance(batch.batchId);
  assert.equal(info.total, 6, 'new member added after start must not join the batch');

  const expected = referenceCommissions(input);
  const results = resumed.getAllResults(batch.batchId);
  assert.equal(results.length, expected.size);
  for (const result of results) {
    assert.equal(
      result.commissionCents,
      expected.get(result.memberId),
      `commission mismatch for ${result.memberId}`,
    );
  }
  // The newcomer exists in live data but has no record in this batch.
  assert.equal(resumed.getResult(batch.batchId, 'newcomer'), null);
  resumed.close();
});

test('completed results stay immutable even after live input changes', () => {
  const dbPath = tempDbPath('immutable');
  const input = buildInitialInput();
  const ledger = new CommissionLedger(dbPath);
  applyInput(ledger, input, MONTH);
  const batch = ledger.startSettlement(MONTH);
  let info = batch;
  while (info.status !== 'completed') info = ledger.advance(batch.batchId);
  const before = ledger.getAllResults(batch.batchId);

  // Heavy mutations after completion.
  ledger.addMember('root', 'e'); // would create a cycle if live data were re-read
  ledger.setMonthlyPv('c', MONTH, 88888);
  ledger.addMember('intruder', 'root');
  ledger.close();

  const reopened = new CommissionLedger(dbPath);
  const after = reopened.getAllResults(batch.batchId);
  assert.deepEqual(after, before);
  reopened.close();
});
