import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { analyzeFlow, replayFlow } from '../src/index';
import {
  analyzedCombos,
  bruteForceCombos,
  comboKey,
  makeRng,
  randomFlow,
} from './helpers';

test('analysis matches brute-force first failures on random flows', () => {
  const rng = makeRng(20261005);
  const fields = ['f0', 'f1', 'f2', 'f3'];
  for (let round = 0; round < 300; round++) {
    const flow = randomFlow(rng, {
      middleNodes: 4 + Math.floor(rng() * 11),
      switchCount: 4,
      fields,
      endNodes: 1 + Math.floor(rng() * 2),
    });
    const expected = bruteForceCombos(flow);
    const actual = analyzedCombos(flow);
    assert.deepEqual(
      actual,
      expected,
      `round ${round} mismatch: only in analysis=${[...actual].filter((c) => !expected.has(c))}` +
        ` only in brute force=${[...expected].filter((c) => !actual.has(c))}`,
    );
  }
});

test('every reported witness reproduces its first failure', () => {
  const rng = makeRng(777);
  const fields = ['f0', 'f1', 'f2'];
  for (let round = 0; round < 200; round++) {
    const flow = randomFlow(rng, {
      middleNodes: 4 + Math.floor(rng() * 9),
      switchCount: 3,
      fields,
    });
    const { reports } = analyzeFlow(flow);
    const seen = new Set<string>();
    for (const report of reports) {
      // De-duplicated by (node, field).
      const key = comboKey(report.nodeId, report.field);
      assert.ok(!seen.has(key), `duplicate report ${key}`);
      seen.add(key);
      // Complete input.
      assert.equal(report.witness.length, flow.switchCount);
      // The witness really triggers this first failure.
      const replay = replayFlow(flow, report.witness);
      assert.equal(replay.ok, false, `witness of ${key} did not fail`);
      if (!replay.ok) {
        assert.equal(replay.failedNode, report.nodeId, `witness of ${key} failed elsewhere`);
        assert.ok(
          replay.missingFields.includes(report.field),
          `witness of ${key} missed the field`,
        );
      }
    }
  }
});

test('safe random flows really reach an end under every input', () => {
  const rng = makeRng(424242);
  const fields = ['f0', 'f1'];
  let safeCount = 0;
  for (let round = 0; round < 200; round++) {
    // Few required fields -> many flows are safe.
    const flow = randomFlow(rng, { middleNodes: 3 + Math.floor(rng() * 6), switchCount: 3, fields });
    const result = analyzeFlow(flow);
    if (!result.safe) continue;
    safeCount++;
    for (let mask = 0; mask < 1 << flow.switchCount; mask++) {
      const input: boolean[] = [];
      for (let bit = 0; bit < flow.switchCount; bit++) input.push(((mask >>> bit) & 1) === 1);
      assert.equal(replayFlow(flow, input).ok, true, `safe flow failed on ${input}`);
    }
  }
  assert.ok(safeCount > 0, 'expected at least one safe random flow');
});
