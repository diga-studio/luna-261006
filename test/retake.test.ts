import assert from "node:assert/strict";
import test from "node:test";
import { assembleExam, snapshotBank } from "../src/index.js";
import type { QuestionVersion } from "../src/index.js";

function shuffled<T>(items: readonly T[]): T[] {
  return [...items].reverse();
}

test("revised question that changed category still counts as repeat by questionId", () => {
  const versions: QuestionVersion[] = [
    { questionId: "q1", version: 1, category: "代数", difficulty: "基础" },
    { questionId: "q1", version: 2, category: "几何", difficulty: "基础" },
    { questionId: "q2", version: 1, category: "几何", difficulty: "基础" },
  ];
  const bank = snapshotBank(versions);
  assert.equal(bank.questions.length, 2);
  const q1 = bank.questions.find((q) => q.questionId === "q1")!;
  assert.equal(q1.version, 2);
  assert.equal(q1.category, "几何");

  const history = [["q1"]];
  const result = assembleExam(
    bank,
    { 几何: 1 },
    { 基础: 1 },
    history,
    "retake-seed"
  );
  assert.ok(result.ok);
  assert.deepEqual(
    result.questions.map((q) => q.questionId),
    ["q2"],
    "q1 must count as a repeat even after revision, so q2 is preferred"
  );
});

test("repeat appearing in two history exams still counts once", () => {
  const versions: QuestionVersion[] = [
    { questionId: "q1", version: 1, category: "代数", difficulty: "基础" },
    { questionId: "q2", version: 1, category: "代数", difficulty: "基础" },
  ];
  const bank = snapshotBank(versions);
  const result = assembleExam(
    bank,
    { 代数: 2 },
    { 基础: 2 },
    [["q1"], ["q1", "q2"]],
    "retake-seed"
  );
  assert.ok(result.ok);
  assert.equal(result.questions.length, 2);
});

test("returns minimal-repeat exam instead of failing when repeats are unavoidable", () => {
  const versions: QuestionVersion[] = [
    { questionId: "q1", version: 1, category: "代数", difficulty: "基础" },
    { questionId: "q2", version: 1, category: "代数", difficulty: "进阶" },
    { questionId: "q3", version: 1, category: "代数", difficulty: "基础" },
  ];
  const bank = snapshotBank(versions);
  const history = [["q1", "q2", "q3"]];
  const result = assembleExam(bank, { 代数: 2 }, { 基础: 1, 进阶: 1 }, history, "s");
  assert.ok(result.ok, "must not fail even though every question is a repeat");
  assert.equal(result.questions.length, 2);

  const partial = assembleExam(bank, { 代数: 3 }, { 基础: 2, 进阶: 1 }, history, "s");
  assert.ok(partial.ok);
  assert.equal(partial.questions.length, 3);
});

test("input order of versions and history does not change the result", () => {
  const versions: QuestionVersion[] = [
    { questionId: "q1", version: 1, category: "代数", difficulty: "基础" },
    { questionId: "q2", version: 1, category: "代数", difficulty: "进阶" },
    { questionId: "q3", version: 1, category: "几何", difficulty: "基础" },
    { questionId: "q4", version: 1, category: "几何", difficulty: "高阶" },
    { questionId: "q5", version: 1, category: "代数", difficulty: "基础" },
  ];
  const history = [["q1", "q3"], ["q5"]];
  const categoryCounts = { 代数: 2, 几何: 1 };
  const difficultyCounts = { 基础: 2, 进阶: 0, 高阶: 1 };

  const base = assembleExam(
    snapshotBank(versions),
    categoryCounts,
    difficultyCounts,
    history,
    "order-seed"
  );
  const reordered = assembleExam(
    snapshotBank(shuffled(versions)),
    categoryCounts,
    difficultyCounts,
    shuffled(history).map((exam) => shuffled(exam)),
    "order-seed"
  );
  assert.ok(base.ok && reordered.ok);
  assert.deepEqual(reordered, base);

  const again = assembleExam(
    snapshotBank(versions),
    categoryCounts,
    difficultyCounts,
    history,
    "order-seed"
  );
  assert.deepEqual(again, base, "same inputs and seed must give identical order");
});

test("mutating original input does not change snapshot or generated exam", () => {
  const versions: QuestionVersion[] = [
    { questionId: "q1", version: 1, category: "代数", difficulty: "基础" },
    { questionId: "q2", version: 1, category: "代数", difficulty: "进阶" },
  ];
  const bank = snapshotBank(versions);
  const exam = assembleExam(bank, { 代数: 1 }, { 基础: 1 }, [], "iso-seed");
  assert.ok(exam.ok);
  const snapshotBefore = JSON.stringify(bank);
  const examBefore = JSON.stringify(exam);

  versions[0]!.category = "几何";
  versions[0]!.version = 99;
  versions.push({ questionId: "q9", version: 1, category: "几何", difficulty: "高阶" });

  assert.equal(JSON.stringify(bank), snapshotBefore, "snapshot must be isolated");
  assert.equal(JSON.stringify(exam), examBefore, "exam must be isolated");

  const rerun = assembleExam(bank, { 代数: 1 }, { 基础: 1 }, [], "iso-seed");
  assert.deepEqual(rerun, exam, "snapshot still assembles the same exam");
});

test("mismatched quota totals yield no solution, never a partial exam", () => {
  const bank = snapshotBank([
    { questionId: "q1", version: 1, category: "代数", difficulty: "基础" },
  ]);
  const result = assembleExam(bank, { 代数: 1 }, { 基础: 2 }, [], "s");
  assert.ok(!result.ok);
  const invalid = assembleExam(bank, { 代数: -1 }, { 基础: -1 }, [], "s");
  assert.ok(!invalid.ok);
});
