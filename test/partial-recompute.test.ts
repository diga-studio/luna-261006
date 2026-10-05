import { test } from "node:test";
import { deepEqual, equal } from "node:assert/strict";
import { GradebookService } from "../src/gradebook";
import { Attempts, Key, Rule } from "../src/types";
import { RecomputeGate } from "./helpers/gate";
import { referenceScore } from "./helpers/reference";

const KEY: Key = { course: "CS101", semester: "2026-spring" };
const RULE_V1: Rule = {
  weights: { homework: 30, midterm: 30, final: 40 },
  strategy: "max",
  passLine: 60,
};
const RULE_V2: Rule = {
  weights: { homework: 10, midterm: 20, final: 70 },
  strategy: "last",
  passLine: 65,
};

const INITIAL: Record<string, Attempts> = {
  s1: { homework: [70, 80], midterm: [60], final: [90, 85] },
  s2: { homework: [50], midterm: [55, 65], final: [70] },
  s3: { homework: [90, 40], midterm: [80], final: [30, 60] },
  s4: { homework: [100], midterm: [20, 40], final: [50] },
  s5: { homework: [10, 20, 30], midterm: [90], final: [90, 10] },
};

const S1_OVERWRITE: Attempts = {
  homework: [40],
  midterm: [50, 55],
  final: [45],
};
const S6_NEW: Attempts = {
  homework: [88],
  midterm: [77, 99],
  final: [66],
};

function expectedRows(
  rule: Rule,
  inputs: Record<string, { attempts: Attempts; inputVersion: number }>
) {
  return Object.keys(inputs)
    .sort()
    .map((studentId) => ({
      studentId,
      inputVersion: inputs[studentId].inputVersion,
      ...referenceScore(rule, inputs[studentId].attempts),
    }));
}

test("paused recompute: writes and reads proceed under old rule, switch uses latest inputs", async () => {
  const gate = new RecomputeGate();
  const service = new GradebookService({
    hooks: { betweenStudents: gate.hook },
  });

  equal(await service.publishRule(KEY, RULE_V1), 1);
  for (const [studentId, attempts] of Object.entries(INITIAL)) {
    equal(service.putGrades(KEY, studentId, attempts), 1);
  }

  // Start the correction; it pauses after recomputing 2 of 5 students.
  const paused = gate.pauseAfter(2);
  const publish = service.publishRule(KEY, RULE_V2);
  equal(await paused, 2);

  // While paused: overwrite an already-recomputed student and add a new one.
  equal(service.putGrades(KEY, "s1", S1_OVERWRITE), 2);
  equal(service.putGrades(KEY, "s6", S6_NEW), 1);

  // Reads during the pause complete immediately and stay entirely on rule 1,
  // while already reflecting the concurrent writes.
  const during = service.readGradebook(KEY);
  equal(during.ruleVersion, 1);
  deepEqual(
    during.rows.slice().sort((a, b) => a.studentId.localeCompare(b.studentId)),
    expectedRows(RULE_V1, {
      s1: { attempts: S1_OVERWRITE, inputVersion: 2 },
      s2: { attempts: INITIAL.s2, inputVersion: 1 },
      s3: { attempts: INITIAL.s3, inputVersion: 1 },
      s4: { attempts: INITIAL.s4, inputVersion: 1 },
      s5: { attempts: INITIAL.s5, inputVersion: 1 },
      s6: { attempts: S6_NEW, inputVersion: 1 },
    })
  );

  gate.resume();
  equal(await publish, 2);

  // After the switch every row uses rule 2 against the latest inputs,
  // including the student added mid-recompute.
  const after = service.readGradebook(KEY);
  equal(after.ruleVersion, 2);
  deepEqual(
    after.rows.slice().sort((a, b) => a.studentId.localeCompare(b.studentId)),
    expectedRows(RULE_V2, {
      s1: { attempts: S1_OVERWRITE, inputVersion: 2 },
      s2: { attempts: INITIAL.s2, inputVersion: 1 },
      s3: { attempts: INITIAL.s3, inputVersion: 1 },
      s4: { attempts: INITIAL.s4, inputVersion: 1 },
      s5: { attempts: INITIAL.s5, inputVersion: 1 },
      s6: { attempts: S6_NEW, inputVersion: 1 },
    })
  );
});
