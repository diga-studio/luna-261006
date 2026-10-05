import { test } from "node:test";
import { deepEqual, equal, throws } from "node:assert/strict";
import { GradebookService } from "../src/gradebook";
import { Key, Rule } from "../src/types";
import { referenceScore } from "./helpers/reference";

const KEY: Key = { course: "ENG", semester: "2026-spring" };
const OTHER: Key = { course: "ENG", semester: "2026-fall" };
const RULE: Rule = {
  weights: { homework: 30, midterm: 30, final: 40 },
  strategy: "max",
  passLine: 60,
};

test("first publish, version increments, read isolation across keys", async () => {
  const service = new GradebookService();

  deepEqual(service.readGradebook(KEY), { ruleVersion: 0, rows: [] });
  throws(() => service.putGrades(KEY, "s1", sample()), /first rule/);

  equal(await service.publishRule(KEY, RULE), 1);
  deepEqual(service.readGradebook(KEY), { ruleVersion: 1, rows: [] });

  const a1 = sample();
  equal(service.putGrades(KEY, "s1", a1), 1);
  const a2 = sample();
  equal(service.putGrades(KEY, "s1", a2), 2);
  equal(service.putGrades(KEY, "s2", sample()), 1);

  const snap = service.readGradebook(KEY);
  equal(snap.ruleVersion, 1);
  deepEqual(snap.rows, [
    { studentId: "s1", inputVersion: 2, ...referenceScore(RULE, a2) },
    { studentId: "s2", inputVersion: 1, ...referenceScore(RULE, sample()) },
  ]);

  // A different semester of the same course is fully independent.
  deepEqual(service.readGradebook(OTHER), { ruleVersion: 0, rows: [] });
  equal(await service.publishRule(OTHER, RULE), 1);
  equal(service.readGradebook(KEY).ruleVersion, 1);
});

function sample(): { homework: number[]; midterm: number[]; final: number[] } {
  return { homework: [70, 90], midterm: [80], final: [60, 100] };
}
