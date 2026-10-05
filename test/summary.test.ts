import test from "node:test";
import assert from "node:assert/strict";
import { createAnalyzer, TestVerdict, type Baseline } from "../src/index.js";
import { makeBaseline } from "./reference.js";

/**
 * Shared tests, an unexecuted test, an orphan test and an orphan requirement:
 *
 *   R1 -> R2 (sub-requirement)
 *   R2 -> D1, R2 -> T3
 *   R3 -> D1            (shares D1 with R2)
 *   D1 -> T1, D1 -> T2
 *   R4: no links        (traceability gap)
 *   T4: not linked      (orphan test, must not enter the baseline pass rate)
 */
const baseline: Baseline = makeBaseline(
  ["R1", "R2", "R3", "R4"],
  ["D1"],
  [
    ["T1", TestVerdict.Passed],
    ["T2", TestVerdict.Failed],
    ["T3", TestVerdict.NotExecuted],
    ["T4", TestVerdict.Passed],
  ],
  [
    ["R1", "R2"],
    ["R2", "D1"],
    ["R2", "T3"],
    ["R3", "D1"],
    ["D1", "T1"],
    ["D1", "T2"],
  ],
);

test("requirement coverage counts shared tests per requirement", () => {
  const analyzer = createAnalyzer(baseline);
  assert.equal(analyzer.coverageFor("R1").reachableTests, 3);
  assert.equal(analyzer.coverageFor("R1").passRate, 1 / 3);
  assert.equal(analyzer.coverageFor("R2").reachableTests, 3);
  assert.equal(analyzer.coverageFor("R3").reachableTests, 2);
  assert.equal(analyzer.coverageFor("R3").passRate, 1 / 2);
  assert.equal(analyzer.coverageFor("R4").isTraceabilityGap, true);
});

test("baseline summary deduplicates shared tests and ignores orphan tests", () => {
  const summary = createAnalyzer(baseline).summary();
  assert.equal(summary.totalRequirements, 4);
  assert.equal(summary.requirementsWithTests, 3);
  assert.equal(summary.requirementCoverageRatio, 3 / 4);
  // Union of traced tests is {T1,T2,T3}; T4 is traced by no requirement.
  assert.equal(summary.tracedTests, 3);
  assert.equal(summary.tracedPassedTests, 1);
  assert.equal(summary.baselinePassRate, 1 / 3);
  // The mean of per-requirement pass rates would be 7/18: prove the summary
  // is union-based, not an average of averages.
  assert.notEqual(summary.baselinePassRate, (1 / 3 + 1 / 3 + 1 / 2) / 3);
});

test("ratios are null (no data) when denominators are zero", () => {
  const empty = createAnalyzer(makeBaseline([], [], [], [])).summary();
  assert.equal(empty.requirementCoverageRatio, null);
  assert.equal(empty.baselinePassRate, null);

  const noTests = createAnalyzer(makeBaseline(["R"], [], [], [])).summary();
  assert.equal(noTests.requirementCoverageRatio, 0);
  assert.equal(noTests.baselinePassRate, null);
});

test("impact scope contains each downstream artifact once, excluding start", () => {
  const impact = createAnalyzer(baseline).impactOf("R1");
  assert.deepEqual(impact.subRequirements, ["R2"]);
  assert.deepEqual(impact.designItems, ["D1"]);
  assert.deepEqual(impact.testCases.sort(), ["T1", "T2", "T3"]);
  assert.ok(!impact.subRequirements.includes("R1"));
});

test("impact scope never spreads along reverse-only connections", () => {
  const analyzer = createAnalyzer(baseline);
  // R3 shares D1 with R2 but must not see R2, R1 or T3.
  const impact = analyzer.impactOf("R3");
  assert.deepEqual(impact.subRequirements, []);
  assert.deepEqual(impact.designItems, ["D1"]);
  assert.deepEqual(impact.testCases.sort(), ["T1", "T2"]);
  // R2 must not see its parent R1.
  const up = analyzer.impactOf("R2");
  assert.ok(!up.subRequirements.includes("R1"));
});
