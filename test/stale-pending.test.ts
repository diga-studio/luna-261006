import { test } from "node:test";
import { deepEqual, equal } from "node:assert/strict";
import { GradebookService } from "../src/gradebook";
import { Attempts, Key, Rule } from "../src/types";
import { RecomputeGate } from "./helpers/gate";
import { referenceScore } from "./helpers/reference";

const KEY_A: Key = { course: "MATH", semester: "2026-spring" };
const KEY_B: Key = { course: "MATH", semester: "2026-fall" };

const RULE_V1: Rule = {
  weights: { homework: 34, midterm: 33, final: 33 },
  strategy: "max",
  passLine: 60,
};
const RULE_V2: Rule = {
  weights: { homework: 34, midterm: 33, final: 33 },
  strategy: "last",
  passLine: 60,
};

// Under "max" this scores 95 (pass); under "last" it scores 10 (fail).
const S1_V1: Attempts = {
  homework: [10, 95],
  midterm: [10, 95],
  final: [10, 95],
};
const S1_V2: Attempts = {
  homework: [50],
  midterm: [50],
  final: [50],
};
// Under "last" this scores ~91 (pass): the opposite of the stale pending result.
const S1_V3: Attempts = {
  homework: [90, 92],
  midterm: [88],
  final: [91, 93],
};
const S2: Attempts = {
  homework: [70, 40],
  midterm: [65],
  final: [80, 75],
};
const B1: Attempts = {
  homework: [60, 90],
  midterm: [75],
  final: [82],
};

test("stale pending grade cannot overwrite newer input; other semester untouched", async () => {
  const gate = new RecomputeGate();
  const service = new GradebookService({
    hooks: { betweenStudents: gate.hook },
  });

  equal(await service.publishRule(KEY_A, RULE_V1), 1);
  equal(await service.publishRule(KEY_B, RULE_V1), 1);
  service.putGrades(KEY_A, "s1", S1_V1);
  service.putGrades(KEY_A, "s2", S2);
  service.putGrades(KEY_B, "b1", B1);

  // Correction on KEY_A pauses right after s1's pending grade was computed
  // from input v1 (strategy "last" -> total 10, fail).
  const paused = gate.pauseAfter(1);
  const publish = service.publishRule(KEY_A, RULE_V2);
  equal(await paused, 1);

  // Two consecutive overwrites land while the stale v1-based grade is pending.
  equal(service.putGrades(KEY_A, "s1", S1_V2), 2);
  equal(service.putGrades(KEY_A, "s1", S1_V3), 3);

  // The other semester keeps accepting writes and reads independently.
  const b1Overwrite: Attempts = { homework: [55], midterm: [58], final: [53] };
  equal(service.putGrades(KEY_B, "b1", b1Overwrite), 2);
  const duringB = service.readGradebook(KEY_B);
  equal(duringB.ruleVersion, 1);
  deepEqual(duringB.rows, [
    { studentId: "b1", inputVersion: 2, ...referenceScore(RULE_V1, b1Overwrite) },
  ]);

  gate.resume();
  equal(await publish, 2);

  // The stale v1-based result (fail, total 10) must not resurface: s1 shows
  // input v3 under the new "last" strategy, which flips the pass verdict.
  const after = service.readGradebook(KEY_A);
  equal(after.ruleVersion, 2);
  deepEqual(after.rows, [
    { studentId: "s1", inputVersion: 3, ...referenceScore(RULE_V2, S1_V3) },
    { studentId: "s2", inputVersion: 1, ...referenceScore(RULE_V2, S2) },
  ]);
  equal(after.rows[0].pass, true);

  // KEY_B was never corrected: still rule version 1 with its own latest input.
  const afterB = service.readGradebook(KEY_B);
  equal(afterB.ruleVersion, 1);
  deepEqual(afterB.rows, [
    { studentId: "b1", inputVersion: 2, ...referenceScore(RULE_V1, b1Overwrite) },
  ]);
});
