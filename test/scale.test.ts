import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommissionLedger } from '../src/index.js';
import { referenceCommissions, tempDbPath, type FrozenInput } from './helpers.js';

const MONTH = '2026-09';
const N = 100_000;

function buildInput(): FrozenInput {
  const sponsors = new Map<string, string | null>();
  const pv = new Map<string, number>();
  sponsors.set('m0', null);
  for (let i = 1; i < N; i += 1) {
    // Deterministic acyclic shape: mostly a deep chain, with branches.
    const sponsorIndex = i % 10 === 0 ? i - 7 : i - 1;
    sponsors.set(`m${i}`, `m${sponsorIndex}`);
  }
  for (let i = 0; i < N; i += 1) {
    const value = i % 3 === 0 ? i % 1000 : 1;
    if (value > 0) pv.set(`m${i}`, value);
  }
  return { sponsors, pv };
}

test('scale: 100k members settle correctly in 200-member steps, across a restart', { timeout: 300_000 }, () => {
  const dbPath = tempDbPath('scale');
  const input = buildInput();

  const ledger = new CommissionLedger(dbPath);
  for (const [id, sponsor] of input.sponsors) ledger.addMember(id, sponsor);
  for (const [id, pv] of input.pv) ledger.setMonthlyPv(id, MONTH, pv);

  const batch = ledger.startSettlement(MONTH);
  assert.equal(batch.total, N);

  // Settle roughly half, then simulate the process exiting overnight.
  let done = 0;
  while (done < N / 2) {
    done = ledger.advance(batch.batchId).done;
  }
  ledger.close();

  const resumed = new CommissionLedger(dbPath);
  const observed = resumed.getBatch(batch.batchId);
  assert.ok(observed);
  assert.equal(observed.done, done, 'progress persists across restart');
  assert.throws(() => resumed.getAllResults(batch.batchId), /still processing/);

  let info = observed;
  while (info.status !== 'completed') info = resumed.advance(batch.batchId);
  assert.equal(info.done, N);

  const expected = referenceCommissions(input);
  const results = resumed.getAllResults(batch.batchId);
  assert.equal(results.length, N);
  for (const result of results) {
    assert.equal(
      result.commissionCents,
      expected.get(result.memberId),
      `commission mismatch for ${result.memberId}`,
    );
  }
  resumed.close();
});
