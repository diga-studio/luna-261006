import assert from "node:assert/strict";
import test from "node:test";
import { assembleExam } from "../src/assemble.js";
import { snapshotBank } from "../src/snapshot.js";
import type { Difficulty, QuestionVersion } from "../src/types.js";
import { rng, shuffled } from "./helpers.js";

function makeBank(
  spec: ReadonlyArray<readonly [string, number, string, Difficulty]>,
): QuestionVersion[] {
  return spec.map(([questionId, version, category, difficulty]) => ({
    questionId,
    version,
    category,
    difficulty,
  }));
}

test("重考：修订后换了类别的历史题仍算重复题", () => {
  // q1 历史上以"代数/基础"出现，修订后变为"几何/进阶"。
  const versions = makeBank([
    ["q1", 1, "代数", "基础"],
    ["q1", 2, "几何", "进阶"],
    ["q2", 1, "几何", "进阶"],
  ]);
  const bank = snapshotBank(versions);
  const history = [["q1"]];
  // 需要 1 道几何进阶：q1v2 与 q2 都合法，q2 不重复，必须选 q2。
  const got = assembleExam(bank, { 几何: 1 }, { 进阶: 1 }, history, "s");
  assert.equal(got.ok, true);
  if (!got.ok) return;
  assert.equal(got.repeats, 0);
  assert.deepEqual(got.questions.map((q) => q.questionId), ["q2"]);
});

test("重考：同一题出现在多份历史试卷中只计一次重复", () => {
  const versions = makeBank([
    ["q1", 1, "代数", "基础"],
    ["q2", 1, "代数", "基础"],
  ]);
  const bank = snapshotBank(versions);
  // q1 同时出现在两份历史试卷里；题库只有 2 道，配额要 2 道，q1 必须选。
  const got = assembleExam(
    bank,
    { 代数: 2 },
    { 基础: 2 },
    [["q1"], ["q1", "q9"]],
    "s",
  );
  assert.equal(got.ok, true);
  if (!got.ok) return;
  assert.equal(got.repeats, 1);
});

test("重考：题库不足以避开重复题时返回重复最少的合法试卷而非失败", () => {
  // 3 道代数基础题中 2 道是历史题，配额要 2 道：至少重复 1 道。
  const versions = makeBank([
    ["old1", 1, "代数", "基础"],
    ["old2", 1, "代数", "基础"],
    ["new1", 1, "代数", "基础"],
  ]);
  const bank = snapshotBank(versions);
  const got = assembleExam(
    bank,
    { 代数: 2 },
    { 基础: 2 },
    [["old1", "old2"]],
    "s",
  );
  assert.equal(got.ok, true);
  if (!got.ok) return;
  assert.equal(got.repeats, 1);
  const ids = got.questions.map((q) => q.questionId);
  assert.ok(ids.includes("new1"), "应优先选非重复题");
});

test("重复题数量相同再比随机成本：成本优先级不得高于重复数", () => {
  // 构造：方案A = {old1, new2}（1 重复），方案B = {old2, old3}（2 重复）。
  // 无论 old2/old3 的随机成本多低，都必须选方案A。
  const versions = makeBank([
    ["old1", 1, "代数", "基础"],
    ["old2", 1, "代数", "基础"],
    ["old3", 1, "代数", "基础"],
    ["new2", 1, "代数", "基础"],
  ]);
  const bank = snapshotBank(versions);
  const got = assembleExam(
    bank,
    { 代数: 2 },
    { 基础: 2 },
    [["old1", "old2", "old3"]],
    "cost-priority-seed",
  );
  assert.equal(got.ok, true);
  if (!got.ok) return;
  assert.equal(got.repeats, 1);
  assert.ok(got.questions.some((q) => q.questionId === "new2"));
});

test("确定性：相同输入与 seed 得到相同试卷（含题目顺序），输入换序不影响结果", () => {
  const rand = rng(42);
  const versions = makeBank([
    ["a1", 1, "代数", "基础"],
    ["a2", 1, "代数", "进阶"],
    ["a3", 2, "代数", "高阶"],
    ["a3", 1, "代数", "基础"],
    ["g1", 1, "几何", "基础"],
    ["g2", 1, "几何", "进阶"],
    ["g3", 1, "几何", "高阶"],
    ["s1", 1, "统计", "基础"],
    ["s2", 1, "统计", "进阶"],
  ]);
  const categoryCounts = { 代数: 2, 几何: 1, 统计: 1 };
  const difficultyCounts = { 基础: 2, 进阶: 1, 高阶: 1 };
  const history = [["a1", "g2"], ["s1"]];
  const seed = "determinism";

  const base = assembleExam(
    snapshotBank(versions),
    categoryCounts,
    difficultyCounts,
    history,
    seed,
  );
  assert.equal(base.ok, true);
  if (!base.ok) return;

  // 重复调用结果一致
  const again = assembleExam(
    snapshotBank(versions),
    categoryCounts,
    difficultyCounts,
    history,
    seed,
  );
  assert.deepEqual(again, base);

  // 版本列表与历史列表换序不影响结果
  for (let i = 0; i < 10; i++) {
    const shuffledVersions = shuffled(versions, rand);
    const shuffledHistory = shuffled(history, rand).map((exam) => shuffled(exam, rand));
    const got = assembleExam(
      snapshotBank(shuffledVersions),
      categoryCounts,
      difficultyCounts,
      shuffledHistory,
      seed,
    );
    assert.deepEqual(got, base, "输入换序后结果必须不变");
  }
});

test("快照隔离：修改原始输入不改变已有快照和已生成试卷", () => {
  const versions = makeBank([
    ["a1", 1, "代数", "基础"],
    ["a2", 1, "代数", "基础"],
    ["g1", 1, "几何", "进阶"],
  ]);
  const bank = snapshotBank(versions);
  const before = assembleExam(bank, { 代数: 1, 几何: 1 }, { 基础: 1, 进阶: 1 }, [], "iso");
  assert.equal(before.ok, true);
  if (!before.ok) return;
  const examJson = JSON.stringify(before.questions);
  const bankJson = JSON.stringify(bank.questions);

  // 调用方修改原始输入：改字段、加版本、删元素
  versions[0]!.category = "篡改";
  versions[0]!.version = 99;
  versions.push({ questionId: "hack", version: 1, category: "代数", difficulty: "基础" });
  versions.splice(1, 1);

  assert.equal(JSON.stringify(bank.questions), bankJson, "快照不应受原始输入修改影响");
  assert.equal(JSON.stringify(before.questions), examJson, "已生成试卷不应受影响");

  const after = assembleExam(bank, { 代数: 1, 几何: 1 }, { 基础: 1, 进阶: 1 }, [], "iso");
  assert.deepEqual(after, before, "快照上再次组卷结果不应改变");
});

test("seed 影响选题且结果可复现", () => {
  const versions = makeBank([
    ["a1", 1, "代数", "基础"],
    ["a2", 1, "代数", "基础"],
    ["a3", 1, "代数", "基础"],
    ["a4", 1, "代数", "基础"],
  ]);
  const bank = snapshotBank(versions);
  const picks = new Set<string>();
  for (let i = 0; i < 8; i++) {
    const got = assembleExam(bank, { 代数: 1 }, { 基础: 1 }, [], `seed-${i}`);
    assert.equal(got.ok, true);
    if (!got.ok) return;
    picks.add(got.questions[0]!.questionId);
    // 相同 seed 成本可复现
    const again = assembleExam(bank, { 代数: 1 }, { 基础: 1 }, [], `seed-${i}`);
    assert.deepEqual(again, got);
  }
  assert.ok(picks.size > 1, "不同 seed 应能通过随机成本选出不同的题");
});

test("零配额返回空试卷", () => {
  const bank = snapshotBank(makeBank([["a1", 1, "代数", "基础"]]));
  const got = assembleExam(bank, {}, {}, [["a1"]], "s");
  assert.equal(got.ok, true);
  if (!got.ok) return;
  assert.equal(got.questions.length, 0);
  assert.equal(got.repeats, 0);
  assert.equal(got.totalCost, 0n);
});
