import { test } from "node:test";
import { deepEqual, equal } from "node:assert/strict";
import { GradebookService } from "../src/gradebook";
import { Attempts, Key, Rule } from "../src/types";
import { RecomputeGate } from "./helpers/gate";
import { referenceScore } from "./helpers/reference";

const KEY: Key = { course: "BIG", semester: "2026-spring" };
const RULE_V1: Rule = {
  weights: { homework: 20, midterm: 30, final: 50 },
  strategy: "max",
  passLine: 60,
};
const RULE_V2: Rule = {
  weights: { homework: 35, midterm: 35, final: 30 },
  strategy: "last",
  passLine: 55,
};

const STUDENT_COUNT = 20000;
const studentId = (i: number): string => `stu-${String(i).padStart(5, "0")}`;

function makeAttempts(seed: number): Attempts {
  let state = (seed >>> 0) || 1;
  const next = (): number => {
    state = (state * 1103515245 + 12345) >>> 0;
    return state;
  };
  const scores = (): number[] => {
    const n = 1 + (next() % 3);
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(next() % 101);
    return out;
  };
  return { homework: scores(), midterm: scores(), final: scores() };
}

test("20k students: interleaved overwrites, full reference diff, no redundant recompute", async () => {
  const gate = new RecomputeGate();
  const service = new GradebookService({
    hooks: { betweenStudents: gate.hook },
  });

  equal(await service.publishRule(KEY, RULE_V1), 1);
  const inputs = new Map<string, Attempts>();
  for (let i = 0; i < STUDENT_COUNT; i++) {
    const attempts = makeAttempts(i + 1);
    inputs.set(studentId(i), attempts);
    equal(service.putGrades(KEY, studentId(i), attempts), 1);
  }
  equal(service.computeCount(KEY), STUDENT_COUNT);

  // Correction pauses halfway through the 20k students.
  const paused = gate.pauseAfter(10000);
  const publish = service.publishRule(KEY, RULE_V2);
  equal(await paused, 10000);

  // 10 overwrites hit already-recomputed students, 5 hit students the
  // recompute has not reached yet.
  const staleOverwrites: string[] = [];
  for (let i = 0; i < 10; i++) staleOverwrites.push(studentId(i));
  const freshOverwrites: string[] = [];
  for (let i = 15000; i < 15005; i++) freshOverwrites.push(studentId(i));
  for (const [index, id] of [...staleOverwrites, ...freshOverwrites].entries()) {
    const attempts = makeAttempts(1000000 + index);
    inputs.set(id, attempts);
    equal(service.putGrades(KEY, id, attempts), 2);
  }

  // A read during the pause still sees a complete rule-1 gradebook that
  // already includes the fresh writes.
  const during = service.readGradebook(KEY);
  equal(during.ruleVersion, 1);
  equal(during.rows.length, STUDENT_COUNT);
  const spotId = staleOverwrites[0];
  const spotRow = during.rows.find((row) => row.studentId === spotId);
  deepEqual(spotRow, {
    studentId: spotId,
    inputVersion: 2,
    ...referenceScore(RULE_V1, inputs.get(spotId)!),
  });

  gate.resume();
  equal(await publish, 2);

  // Only the 10 students overwritten after being recomputed need a second
  // computation at commit time; nobody else is recomputed.
  equal(
    service.computeCount(KEY),
    STUDENT_COUNT + 15 + STUDENT_COUNT + staleOverwrites.length
  );

  // Full comparison against a serial reference over the final inputs.
  const expected = Array.from(inputs.entries())
    .map(([id, attempts], ) => ({
      studentId: id,
      inputVersion: staleOverwrites.includes(id) || freshOverwrites.includes(id) ? 2 : 1,
      ...referenceScore(RULE_V2, attempts),
    }))
    .sort((a, b) => a.studentId.localeCompare(b.studentId));
  const actual = service
    .readGradebook(KEY)
    .rows.sort((a, b) => a.studentId.localeCompare(b.studentId));
  equal(service.readGradebook(KEY).ruleVersion, 2);
  deepEqual(actual, expected);
});
