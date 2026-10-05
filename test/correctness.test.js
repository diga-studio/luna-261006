"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  TestVerdict,
  analyzeBaseline,
  queryImpact,
  createAnalyzer,
} = require("../dist/src/index.js");

const P = TestVerdict.Passed;
const F = TestVerdict.Failed;
const N = TestVerdict.NotExecuted;

function req(id) {
  return { id };
}
function design(id) {
  return { id };
}
function tc(id, verdict) {
  return { id, verdict };
}
function link(fromId, toId) {
  return { fromId, toId };
}

/** Independent brute-force reachability used to cross-check the library. */
function bruteForceReachableTests(baseline, requirementId) {
  const adjacency = new Map();
  for (const l of baseline.links) {
    if (!adjacency.has(l.fromId)) adjacency.set(l.fromId, []);
    adjacency.get(l.fromId).push(l.toId);
  }
  const testIds = new Set(baseline.testCases.map((t) => t.id));
  const seen = new Set([requirementId]);
  const stack = [requirementId];
  const tests = new Set();
  while (stack.length > 0) {
    const id = stack.pop();
    for (const next of adjacency.get(id) || []) {
      if (testIds.has(next)) {
        tests.add(next);
      } else if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return tests;
}

function bruteForceImpact(baseline, requirementId) {
  const adjacency = new Map();
  for (const l of baseline.links) {
    if (!adjacency.has(l.fromId)) adjacency.set(l.fromId, []);
    adjacency.get(l.fromId).push(l.toId);
  }
  const testIds = new Set(baseline.testCases.map((t) => t.id));
  const designIds = new Set(baseline.designItems.map((d) => d.id));
  const seen = new Set([requirementId]);
  const stack = [requirementId];
  const result = { requirementIds: [], designItemIds: [], testCaseIds: [] };
  while (stack.length > 0) {
    const id = stack.pop();
    for (const next of adjacency.get(id) || []) {
      if (seen.has(next)) continue;
      seen.add(next);
      if (testIds.has(next)) result.testCaseIds.push(next);
      else if (designIds.has(next)) result.designItemIds.push(next);
      else result.requirementIds.push(next);
      if (!testIds.has(next)) stack.push(next);
    }
  }
  return result;
}

test("diamond paths, design cycle and duplicate links together: no double counting", () => {
  const baseline = {
    requirements: [req("R1"), req("R2")],
    designItems: [design("D1"), design("D2"), design("D3"), design("D4")],
    testCases: [tc("T1", P), tc("T2", F)],
    links: [
      link("R1", "R2"), // sub-requirement
      link("R1", "D1"),
      link("R1", "D2"),
      link("R1", "D2"), // duplicate link
      link("R2", "D3"),
      link("D1", "D3"), // diamond convergence
      link("D2", "D3"),
      link("D3", "D4"),
      link("D4", "D3"), // design cycle
      link("D3", "T1"),
      link("D4", "T1"), // same test via two paths
      link("D4", "T2"),
      link("R1", "T1"), // direct link duplicating indirect reach
    ],
  };

  const result = analyzeBaseline(baseline);
  const byId = new Map(result.requirements.map((r) => [r.requirementId, r]));

  for (const rid of ["R1", "R2"]) {
    const expected = bruteForceReachableTests(baseline, rid);
    const actual = byId.get(rid);
    assert.equal(actual.reachableTestCount, expected.size, `${rid} reachable count`);
    assert.equal(actual.reachableTestCount, 2);
    assert.equal(actual.passedTestCount, 1);
    assert.equal(actual.passRate, 0.5);
    assert.equal(actual.isTraceabilityGap, false);
  }

  // Impact query must agree with the same link semantics.
  for (const rid of ["R1", "R2"]) {
    const impact = queryImpact(baseline, rid);
    const expected = bruteForceImpact(baseline, rid);
    assert.deepEqual(
      [...impact.testCaseIds].sort(),
      [...expected.testCaseIds].sort(),
      `${rid} impact tests`,
    );
    assert.deepEqual(
      [...impact.designItemIds].sort(),
      [...expected.designItemIds].sort(),
      `${rid} impact designs`,
    );
    assert.deepEqual(
      [...impact.requirementIds].sort(),
      [...expected.requirementIds].sort(),
      `${rid} impact requirements`,
    );
  }

  const r1Impact = queryImpact(baseline, "R1");
  assert.ok(!r1Impact.requirementIds.includes("R1"), "start excluded from impact");
  assert.deepEqual([...r1Impact.requirementIds].sort(), ["R2"]);
});

test("shared tests, unexecuted and orphan tests: per-requirement vs deduplicated summary", () => {
  const baseline = {
    requirements: [req("RA"), req("RB"), req("RC")],
    designItems: [design("DA"), design("DB")],
    testCases: [
      tc("TA", P),
      tc("TB", F),
      tc("TC", N),
      tc("T_ORPHAN_1", P), // not traced by any requirement
      tc("T_ORPHAN_2", N),
    ],
    links: [
      link("RA", "DA"),
      link("DA", "TA"),
      link("DA", "TB"),
      link("RB", "DB"),
      link("DB", "TB"), // TB shared by RA and RB
      link("DB", "TC"),
      // RC has no links: traceability gap
    ],
  };

  const result = analyzeBaseline(baseline);
  const byId = new Map(result.requirements.map((r) => [r.requirementId, r]));

  assert.equal(byId.get("RA").reachableTestCount, 2);
  assert.equal(byId.get("RA").passedTestCount, 1);
  assert.equal(byId.get("RA").passRate, 0.5);

  assert.equal(byId.get("RB").reachableTestCount, 2);
  assert.equal(byId.get("RB").passedTestCount, 0);
  assert.equal(byId.get("RB").passRate, 0); // 0% is data, not "no data"
  assert.equal(byId.get("RB").isTraceabilityGap, false);

  // Failed / unexecuted tests are not gaps; only zero reachable tests is.
  assert.equal(byId.get("RC").reachableTestCount, 0);
  assert.equal(byId.get("RC").passRate, null);
  assert.equal(byId.get("RC").isTraceabilityGap, true);

  const summary = result.summary;
  assert.equal(summary.requirementCount, 3);
  assert.equal(summary.requirementsWithTests, 2);
  assert.equal(summary.requirementCoverageRatio, 2 / 3);

  // Union over requirements, each shared test counted once, orphans excluded.
  assert.equal(summary.tracedTestCount, 3);
  assert.equal(summary.tracedPassedCount, 1);
  assert.equal(summary.overallPassRate, 1 / 3);
  // Not the average of per-requirement pass rates ((0.5 + 0) / 2 = 0.25).
  assert.notEqual(summary.overallPassRate, (0.5 + 0) / 2);
});

test("impact query never propagates backwards along links", () => {
  const baseline = {
    requirements: [req("R0"), req("R1"), req("R2")],
    designItems: [design("D1")],
    testCases: [tc("T1", P), tc("T2", P)],
    links: [
      link("R0", "R1"), // R0 is a parent of R1
      link("R1", "D1"),
      link("D1", "T1"),
      link("R2", "D1"), // R2 shares D1 but is not downstream of R1
      link("R2", "T2"),
    ],
  };

  const impact = queryImpact(baseline, "R1");
  assert.deepEqual([...impact.designItemIds].sort(), ["D1"]);
  assert.deepEqual([...impact.testCaseIds].sort(), ["T1"]);
  assert.deepEqual(impact.requirementIds, []);
  assert.ok(!impact.requirementIds.includes("R0"), "parent not reachable backwards");
  assert.ok(!impact.requirementIds.includes("R2"), "sibling sharing a design item not included");
  assert.ok(!impact.testCaseIds.includes("T2"), "tests of unrelated branches not included");

  const r0Impact = queryImpact(baseline, "R0");
  assert.deepEqual([...r0Impact.requirementIds].sort(), ["R1"]);
  assert.deepEqual([...r0Impact.testCaseIds].sort(), ["T1"]);
});

test("zero denominators mean no data, not zero percent", () => {
  const empty = analyzeBaseline({
    requirements: [],
    designItems: [],
    testCases: [],
    links: [],
  });
  assert.equal(empty.summary.requirementCoverageRatio, null);
  assert.equal(empty.summary.overallPassRate, null);
  assert.equal(empty.summary.tracedTestCount, 0);

  const noTests = analyzeBaseline({
    requirements: [req("R1")],
    designItems: [],
    testCases: [],
    links: [],
  });
  assert.equal(noTests.summary.requirementCoverageRatio, 0);
  assert.equal(noTests.summary.overallPassRate, null);
  assert.equal(noTests.requirements[0].passRate, null);
  assert.equal(noTests.requirements[0].isTraceabilityGap, true);

  const allUnexecuted = analyzeBaseline({
    requirements: [req("R1")],
    designItems: [],
    testCases: [tc("T1", N), tc("T2", N)],
    links: [link("R1", "T1"), link("R1", "T2")],
  });
  assert.equal(allUnexecuted.requirements[0].passRate, 0);
  assert.equal(allUnexecuted.requirements[0].isTraceabilityGap, false);
  assert.equal(allUnexecuted.summary.overallPassRate, 0);
  assert.equal(allUnexecuted.summary.requirementCoverageRatio, 1);
});

test("indirect reach through sub-requirements and multi-level design chains", () => {
  const baseline = {
    requirements: [req("R1"), req("R2"), req("R3")],
    designItems: [design("D1"), design("D2"), design("D3")],
    testCases: [tc("T1", P), tc("T2", P), tc("T3", F)],
    links: [
      link("R1", "R2"),
      link("R2", "R3"),
      link("R3", "D1"),
      link("D1", "D2"),
      link("D2", "D3"),
      link("D3", "T3"),
      link("D2", "T2"),
      link("R3", "T1"),
    ],
  };
  const result = analyzeBaseline(baseline);
  const byId = new Map(result.requirements.map((r) => [r.requirementId, r]));
  assert.equal(byId.get("R1").reachableTestCount, 3);
  assert.equal(byId.get("R2").reachableTestCount, 3);
  assert.equal(byId.get("R3").reachableTestCount, 3);
  assert.equal(byId.get("R1").passedTestCount, 2);
  assert.equal(byId.get("R1").passRate, 2 / 3);
});

test("baseline contract violations are rejected", () => {
  const base = {
    requirements: [req("R1")],
    designItems: [design("D1")],
    testCases: [tc("T1", P)],
    links: [],
  };
  assert.throws(
    () => analyzeBaseline({ ...base, requirements: [req("R1"), req("R1")] }),
    /duplicate artifact id/,
  );
  assert.throws(
    () => analyzeBaseline({ ...base, links: [link("R1", "UNKNOWN")] }),
    /unknown artifact/,
  );
  assert.throws(
    () => analyzeBaseline({ ...base, links: [link("T1", "R1")] }),
    /must not have outgoing links/,
  );
  assert.throws(
    () => analyzeBaseline({ ...base, links: [link("D1", "R1")] }),
    /must not link to requirement/,
  );
  assert.throws(
    () =>
      analyzeBaseline({
        ...base,
        testCases: [{ id: "T1", verdict: "bogus" }],
      }),
    /unknown verdict/,
  );
  assert.throws(() => queryImpact(base, "NOPE"), /unknown requirement/);
});

test("analyzer instance reuses one frozen baseline for analysis and impact", () => {
  const baseline = {
    requirements: [req("R1")],
    designItems: [design("D1")],
    testCases: [tc("T1", P)],
    links: [link("R1", "D1"), link("D1", "T1")],
  };
  const analyzer = createAnalyzer(baseline);
  const analysis = analyzer.analyze();
  assert.equal(analysis.requirements[0].reachableTestCount, 1);
  const impact = analyzer.queryImpact("R1");
  assert.deepEqual(impact.testCaseIds, ["T1"]);
  assert.deepEqual(impact.designItemIds, ["D1"]);
});
