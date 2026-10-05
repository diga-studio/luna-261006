import test from "node:test";
import assert from "node:assert/strict";
import {
  ArtifactKind,
  TestVerdict,
  createAnalyzer,
  type Baseline,
  type DesignItem,
  type Requirement,
  type TestCase,
  type TraceLink,
} from "../src/index.js";

/**
 * Full-scale baseline: 20000 requirements, 40000 design items,
 * 10000 test cases, ~132k directed links.
 *
 *   - D0..D19999:        a 20000-long design dependency chain
 *   - D20000..D29999:    a 10000-node design cycle
 *   - D30000..D30004:    5 hub entries; D30100..D30199: middle;
 *                        D30200..D30299: leaves fanning out to tests
 *   - R0 -> chain head;  R1 -> cycle;  chain tail and one cycle node
 *     also feed the hub, so every requirement reaches >= 5000 tests
 *   - R2..R14999:        5 direct hub-entry links each (high sharing)
 *   - R15000..R19999:    a 5000-long sub-requirement chain into the hub
 *   - T9800..T9999:      orphan tests, traced by no requirement
 */
const REQ = 20000;
const DESIGN = 40000;
const TESTS = 10000;
const TRACED_TESTS = 9800; // T0..T9799 reachable; last 200 are orphans

function buildScaleBaseline(): Baseline {
  const requirements: Requirement[] = Array.from({ length: REQ }, (_, i) => ({
    id: `R${i}`,
    kind: ArtifactKind.Requirement,
  }));
  const designItems: DesignItem[] = Array.from({ length: DESIGN }, (_, i) => ({
    id: `D${i}`,
    kind: ArtifactKind.DesignItem,
  }));
  const testCases: TestCase[] = Array.from({ length: TESTS }, (_, i) => ({
    id: `T${i}`,
    kind: ArtifactKind.TestCase,
    verdict:
      i % 3 === 0
        ? TestVerdict.Passed
        : i % 3 === 1
          ? TestVerdict.Failed
          : TestVerdict.NotExecuted,
  }));

  const links: TraceLink[] = [];
  const link = (from: string, to: string): void => {
    links.push({ from, to });
  };

  // Long design chain D0 -> ... -> D19999, fed by R0.
  for (let i = 0; i < 19999; i++) link(`D${i}`, `D${i + 1}`);
  link("R0", "D0");
  link("D19999", "T0");
  link("D19999", "T1");

  // Design cycle D20000 -> ... -> D29999 -> D20000, fed by R1.
  for (let i = 20000; i < 29999; i++) link(`D${i}`, `D${i + 1}`);
  link("D29999", "D20000");
  link("R1", "D20000");
  for (let i = 0; i < 10; i++) link(`D${20000 + i * 1000}`, `T${2 + i}`);

  // Hub: 5 entries -> 100 middle -> 100 leaves -> 98 tests each.
  for (let e = 0; e < 5; e++) {
    for (let m = 0; m < 100; m++) link(`D${30000 + e}`, `D${30100 + m}`);
  }
  for (let m = 0; m < 100; m++) {
    for (let l = 0; l < 100; l++) link(`D${30100 + m}`, `D${30200 + l}`);
  }
  for (let l = 0; l < 100; l++) {
    for (let t = 0; t < 98; t++) link(`D${30200 + l}`, `T${l * 98 + t}`);
  }

  // Chain tail and one cycle node also feed the hub.
  link("D19999", "D30000");
  link("D20000", "D30000");

  // High sharing: R2..R14999 each link all 5 hub entries.
  for (let r = 2; r < 15000; r++) {
    for (let e = 0; e < 5; e++) link(`R${r}`, `D${30000 + e}`);
  }

  // Sub-requirement chain R15000 -> ... -> R19999 into the hub.
  for (let r = 15000; r < 19999; r++) link(`R${r}`, `R${r + 1}`);
  for (let e = 0; e < 5; e++) link("R19999", `D${30000 + e}`);

  return { requirements, designItems, testCases, links };
}

test("full-scale baseline analyzes within time and memory budgets", () => {
  const baseline = buildScaleBaseline();
  assert.ok(baseline.links.length <= 300000, "link budget");

  const memBefore = process.memoryUsage();
  const start = Date.now();
  const analyzer = createAnalyzer(baseline);
  const elapsedMs = Date.now() - start;
  const memAfter = process.memoryUsage();

  const mib = (bytes: number): number => Math.round((bytes / 1048576) * 10) / 10;
  console.log(
    `scale analysis: ${elapsedMs} ms, ` +
      `rss ${mib(memBefore.rss)} -> ${mib(memAfter.rss)} MiB, ` +
      `heapUsed ${mib(memAfter.heapUsed)} MiB`,
  );
  assert.ok(elapsedMs <= 20000, `analysis took ${elapsedMs} ms`);
  assert.ok(
    memAfter.rss - memBefore.rss <= 384 * 1048576,
    `analysis rss delta ${mib(memAfter.rss - memBefore.rss)} MiB`,
  );

  // Independently computed expectations.
  let expectedPassed = 0;
  for (let t = 0; t < TRACED_TESTS; t++) if (t % 3 === 0) expectedPassed++;

  // Every requirement reaches exactly the 9800 hub-covered tests.
  const all = analyzer.allCoverage();
  assert.equal(all.length, REQ);
  for (const cov of all) {
    assert.equal(cov.reachableTests, TRACED_TESTS, cov.requirementId);
    assert.equal(cov.passedTests, expectedPassed, cov.requirementId);
    assert.equal(cov.isTraceabilityGap, false, cov.requirementId);
  }

  const summary = analyzer.summary();
  assert.equal(summary.totalRequirements, REQ);
  assert.equal(summary.requirementsWithTests, REQ);
  assert.equal(summary.requirementCoverageRatio, 1);
  assert.equal(summary.tracedTests, TRACED_TESTS);
  assert.equal(summary.tracedPassedTests, expectedPassed);
  assert.equal(summary.baselinePassRate, expectedPassed / TRACED_TESTS);

  // Impact query survives the 20000-long chain and the big cycle.
  const impact = analyzer.impactOf("R0");
  assert.equal(impact.testCases.length, TRACED_TESTS);
  // 20000 chain nodes + 1 reachable entry + 100 middle + 100 leaves.
  assert.equal(impact.designItems.length, 20201);
  assert.equal(new Set(impact.testCases).size, impact.testCases.length);
  // R1 goes through the 10000-node cycle plus the hub.
  const cycleImpact = analyzer.impactOf("R1");
  assert.equal(cycleImpact.designItems.length, 10201);
});
