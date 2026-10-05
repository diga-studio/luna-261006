"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { TestVerdict, analyzeBaseline, createAnalyzer } = require("../dist/src/index.js");

const MIB = 1024 * 1024;

const REQ_COUNT = 20000;
const DESIGN_COUNT = 40000;
const TEST_COUNT = 10000;

const CHAIN_LEN = 20000; // D0..D19999 long dependency chain
const CYCLE_LEN = 15000; // C0..C14999 large cyclic region
const FAN_COUNT = DESIGN_COUNT - CHAIN_LEN - CYCLE_LEN; // 5000 shared fan-out items

const P = TestVerdict.Passed;
const F = TestVerdict.Failed;
const N = TestVerdict.NotExecuted;

function buildLargeBaseline() {
  const requirements = [];
  for (let i = 0; i < REQ_COUNT; i++) requirements.push({ id: `R${i}` });

  const designItems = [];
  for (let i = 0; i < CHAIN_LEN; i++) designItems.push({ id: `D${i}` });
  for (let i = 0; i < CYCLE_LEN; i++) designItems.push({ id: `C${i}` });
  for (let i = 0; i < FAN_COUNT; i++) designItems.push({ id: `E${i}` });

  const testCases = [];
  for (let i = 0; i < TEST_COUNT; i++) {
    const verdict = i % 3 === 0 ? P : i % 3 === 1 ? F : N;
    testCases.push({ id: `T${i}`, verdict });
  }

  const links = [];
  const push = (fromId, toId) => links.push({ fromId, toId });

  // Long design dependency chain, depth 20000.
  for (let i = 0; i + 1 < CHAIN_LEN; i++) push(`D${i}`, `D${i + 1}`);
  for (let t = 0; t < 5000; t++) push(`D${CHAIN_LEN - 1}`, `T${t}`);

  // Large cyclic region of 15000 design items.
  for (let i = 0; i < CYCLE_LEN; i++) push(`C${i}`, `C${(i + 1) % CYCLE_LEN}`);
  for (let i = 0; i < CYCLE_LEN; i++) push(`C${i}`, `T${5000 + (i % 5000)}`);

  // Shared fan-out design items.
  for (let i = 0; i < FAN_COUNT; i++) {
    push(`E${i}`, `T${(i * 2) % TEST_COUNT}`);
    push(`E${i}`, `T${(i * 2 + 1) % TEST_COUNT}`);
  }

  // Requirement links: sub-requirement chain plus heavily shared,
  // partially duplicated links into every design region and direct tests.
  for (let i = 0; i + 1 < REQ_COUNT; i++) push(`R${i}`, `R${i + 1}`);
  for (let i = 0; i < REQ_COUNT; i++) {
    push(`R${i}`, "D0"); // duplicate of the chain entry below on purpose
    push(`R${i}`, `D${i % CHAIN_LEN}`);
    push(`R${i}`, `D${(i * 3) % CHAIN_LEN}`);
    push(`R${i}`, `C${i % CYCLE_LEN}`);
    push(`R${i}`, `C${(i * 3) % CYCLE_LEN}`);
    push(`R${i}`, `E${i % FAN_COUNT}`);
    push(`R${i}`, `E${(i * 7) % FAN_COUNT}`);
    push(`R${i}`, `T${i % TEST_COUNT}`);
    push(`R${i}`, `T${(i * 13) % TEST_COUNT}`);
    push(`R${i}`, "D0"); // exact duplicate link
  }

  return { requirements, designItems, testCases, links };
}

test("full-scale baseline: highly shared graph, long chain, large cycle", () => {
  const baseline = buildLargeBaseline();
  assert.equal(baseline.requirements.length, REQ_COUNT);
  assert.equal(baseline.designItems.length, DESIGN_COUNT);
  assert.equal(baseline.testCases.length, TEST_COUNT);
  assert.ok(
    baseline.links.length <= 300000,
    `link count ${baseline.links.length} exceeds the 300000 budget`,
  );
  console.log(`baseline links: ${baseline.links.length}`);

  const memBefore = process.memoryUsage();
  const started = process.hrtime.bigint();

  const analyzer = createAnalyzer(baseline);
  const result = analyzer.analyze();

  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const memAfter = process.memoryUsage();
  console.log(
    `analysis time: ${elapsedMs.toFixed(0)} ms, ` +
      `peak rss ~${(memAfter.rss / MIB).toFixed(0)} MiB, ` +
      `heapUsed ~${(memAfter.heapUsed / MIB).toFixed(0)} MiB ` +
      `(rss delta ${((memAfter.rss - memBefore.rss) / MIB).toFixed(0)} MiB)`,
  );

  // Non-functional budgets.
  assert.ok(elapsedMs < 20000, `analysis took ${elapsedMs.toFixed(0)} ms (> 20 s)`);
  assert.ok(
    memAfter.rss < 384 * MIB,
    `peak rss ${(memAfter.rss / MIB).toFixed(0)} MiB exceeds 384 MiB`,
  );

  // Independently determinable statistics.
  //
  // Every requirement reaches the chain tail (T0..T4999) via any chain
  // item and the whole cycle (T5000..T9999) via any cycle item, so each
  // requirement reaches all 10000 tests. Passed tests are T_i with
  // i % 3 === 0: 3334 tests.
  const expectedPassed = Math.ceil(TEST_COUNT / 3); // 3334
  assert.equal(result.requirements.length, REQ_COUNT);
  for (const cov of result.requirements) {
    assert.equal(cov.reachableTestCount, TEST_COUNT, cov.requirementId);
    assert.ok(cov.reachableTestCount >= 5000, "each requirement reaches >= 5000 tests");
    assert.equal(cov.passedTestCount, expectedPassed, cov.requirementId);
    assert.ok(Math.abs(cov.passRate - expectedPassed / TEST_COUNT) < 1e-12);
    assert.equal(cov.isTraceabilityGap, false);
  }

  const summary = result.summary;
  assert.equal(summary.requirementCount, REQ_COUNT);
  assert.equal(summary.requirementsWithTests, REQ_COUNT);
  assert.equal(summary.requirementCoverageRatio, 1);
  assert.equal(summary.tracedTestCount, TEST_COUNT);
  assert.equal(summary.tracedPassedCount, expectedPassed);
  assert.ok(Math.abs(summary.overallPassRate - expectedPassed / TEST_COUNT) < 1e-12);

  // Impact of the first requirement: the whole sub-requirement chain,
  // every design item and every test, each exactly once.
  const impact = analyzer.queryImpact("R0");
  assert.equal(impact.requirementIds.length, REQ_COUNT - 1);
  assert.equal(new Set(impact.requirementIds).size, REQ_COUNT - 1);
  assert.equal(impact.designItemIds.length, DESIGN_COUNT);
  assert.equal(new Set(impact.designItemIds).size, DESIGN_COUNT);
  assert.equal(impact.testCaseIds.length, TEST_COUNT);
  assert.equal(new Set(impact.testCaseIds).size, TEST_COUNT);

  // Impact of the chain tail requirement: no sub-requirements. It still
  // reaches the whole chain (via D0) and the whole cycle (via C links),
  // but only its own two fan-out items; all 10000 tests remain reachable
  // through the chain tail and the cycle.
  const tailImpact = analyzer.queryImpact(`R${REQ_COUNT - 1}`);
  assert.equal(tailImpact.requirementIds.length, 0);
  const tailFanOut = new Set([
    (REQ_COUNT - 1) % FAN_COUNT,
    ((REQ_COUNT - 1) * 7) % FAN_COUNT,
  ]);
  assert.equal(tailImpact.designItemIds.length, CHAIN_LEN + CYCLE_LEN + tailFanOut.size);
  assert.equal(tailImpact.testCaseIds.length, TEST_COUNT);
});

test("deep chain and cycle alone complete without stack overflow", () => {
  // Minimal baseline exercising exactly the deep-recursion hazards:
  // one chain of 20000 design items and one cycle of 15000.
  const designItems = [];
  const links = [];
  for (let i = 0; i < CHAIN_LEN; i++) designItems.push({ id: `D${i}` });
  for (let i = 0; i + 1 < CHAIN_LEN; i++) links.push({ fromId: `D${i}`, toId: `D${i + 1}` });
  for (let i = 0; i < CYCLE_LEN; i++) designItems.push({ id: `C${i}` });
  for (let i = 0; i < CYCLE_LEN; i++) {
    links.push({ fromId: `C${i}`, toId: `C${(i + 1) % CYCLE_LEN}` });
  }
  const baseline = {
    requirements: [{ id: "R" }],
    designItems,
    testCases: [{ id: "T", verdict: P }],
    links: [
      ...links,
      { fromId: "R", toId: "D0" },
      { fromId: "R", toId: "C0" },
      { fromId: `D${CHAIN_LEN - 1}`, toId: "T" },
      { fromId: `C${CYCLE_LEN - 1}`, toId: "T" },
    ],
  };
  const result = analyzeBaseline(baseline);
  assert.equal(result.requirements[0].reachableTestCount, 1);
  assert.equal(result.requirements[0].passedTestCount, 1);
  assert.equal(result.summary.overallPassRate, 1);
});
