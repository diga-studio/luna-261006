import test from "node:test";
import assert from "node:assert/strict";
import { createAnalyzer, TestVerdict, type Baseline } from "../src/index.js";
import { makeBaseline, naiveReachableTests, verdictOf } from "./reference.js";

/**
 * Diamond paths, a design cycle and duplicate links all at once:
 *
 *   R1 -> A, R1 -> B, R1 -> A (duplicate)
 *   A -> D, B -> D          (diamond through D)
 *   D -> C, C -> D          (design cycle)
 *   C -> T1, D -> T2, A -> T1
 *   R2 -> R1                (sub-requirement chain)
 *   R2 -> T3
 *   R3 (no links at all -> traceability gap)
 */
const baseline: Baseline = makeBaseline(
  ["R1", "R2", "R3"],
  ["A", "B", "C", "D"],
  [
    ["T1", TestVerdict.Passed],
    ["T2", TestVerdict.Failed],
    ["T3", TestVerdict.NotExecuted],
  ],
  [
    ["R1", "A"],
    ["R1", "B"],
    ["R1", "A"], // duplicate link
    ["A", "D"],
    ["B", "D"],
    ["D", "C"],
    ["C", "D"], // cycle
    ["C", "T1"],
    ["D", "T2"],
    ["A", "T1"], // converging path to an already-reachable test
    ["R2", "R1"],
    ["R2", "T3"],
  ],
);

test("per-requirement coverage matches naive reachable sets exactly", () => {
  const analyzer = createAnalyzer(baseline);
  for (const req of baseline.requirements) {
    const expected = naiveReachableTests(baseline, req.id);
    const expectedPassed = [...expected].filter(
      (t) => verdictOf(baseline, t) === TestVerdict.Passed,
    ).length;
    const cov = analyzer.coverageFor(req.id);
    assert.equal(cov.reachableTests, expected.size, `${req.id} reachable`);
    assert.equal(cov.passedTests, expectedPassed, `${req.id} passed`);
    assert.equal(
      cov.passRate,
      expected.size === 0 ? null : expectedPassed / expected.size,
      `${req.id} pass rate`,
    );
    assert.equal(cov.isTraceabilityGap, expected.size === 0, `${req.id} gap`);
  }
});

test("explicit expectations for the diamond/cycle fixture", () => {
  const analyzer = createAnalyzer(baseline);
  const r1 = analyzer.coverageFor("R1");
  assert.deepEqual(
    { reachable: r1.reachableTests, passed: r1.passedTests },
    { reachable: 2, passed: 1 },
  );
  const r2 = analyzer.coverageFor("R2");
  assert.deepEqual(
    { reachable: r2.reachableTests, passed: r2.passedTests },
    { reachable: 3, passed: 1 },
  );
  const r3 = analyzer.coverageFor("R3");
  assert.equal(r3.isTraceabilityGap, true);
  assert.equal(r3.passRate, null);
});

test("failed and not-executed tests count in the denominator, not as gaps", () => {
  const analyzer = createAnalyzer(baseline);
  // R2 reaches T1 (passed), T2 (failed), T3 (not executed): not a gap.
  const r2 = analyzer.coverageFor("R2");
  assert.equal(r2.isTraceabilityGap, false);
  assert.equal(r2.passRate, 1 / 3);
});

test("unknown requirement id throws", () => {
  const analyzer = createAnalyzer(baseline);
  assert.throws(() => analyzer.coverageFor("NOPE"));
  assert.throws(() => analyzer.impactOf("NOPE"));
});
