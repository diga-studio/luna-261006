import assert from "node:assert/strict";
import test from "node:test";
import { assembleExam } from "../src/assemble.js";
import { snapshotBank } from "../src/snapshot.js";
import type { Difficulty, QuestionVersion } from "../src/types.js";
import { exhaustiveBest, rng, shuffled } from "./helpers.js";

const DIFFS: Difficulty[] = ["基础", "进阶", "高阶"];

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

test("小题库：与独立穷举核对可行性及两级最优成本", () => {
  const rand = rng(20261006);
  const categories = ["代数", "几何", "统计"];
  let feasible = 0;
  let infeasible = 0;
  for (let trial = 0; trial < 60; trial++) {
    const n = 4 + Math.floor(rand() * 9); // 4~12 题
    const versions: QuestionVersion[] = [];
    for (let i = 0; i < n; i++) {
      const id = `q${i}`;
      const category = categories[Math.floor(rand() * categories.length)]!;
      const difficulty = DIFFS[Math.floor(rand() * 3)]!;
      versions.push({ questionId: id, version: 1, category, difficulty });
      // 随机给部分题加旧版本或新版本
      if (rand() < 0.3) {
        versions.push({
          questionId: id,
          version: 2,
          category: categories[Math.floor(rand() * categories.length)]!,
          difficulty: DIFFS[Math.floor(rand() * 3)]!,
        });
      }
    }
    const categoryCounts: Record<string, number> = {};
    for (const c of categories) {
      const v = Math.floor(rand() * 3); // 0~2
      if (v > 0) categoryCounts[c] = v;
    }
    const difficultyCounts: Partial<Record<Difficulty, number>> = {};
    let total = 0;
    for (const c of Object.keys(categoryCounts)) total += categoryCounts[c]!;
    // 随机把总数摊到难度上，保证两侧总数一致
    let remaining = total;
    for (let i = 0; i < DIFFS.length; i++) {
      const d = DIFFS[i]!;
      const v = i === DIFFS.length - 1 ? remaining : Math.floor(rand() * (remaining + 1));
      if (v > 0) difficultyCounts[d] = v;
      remaining -= v;
    }
    const historyPool = versions.map((v) => v.questionId);
    const history: string[][] = [
      shuffled(historyPool, rand).slice(0, Math.floor(rand() * 4)),
      shuffled(historyPool, rand).slice(0, Math.floor(rand() * 3)),
    ];
    const seed = `seed-${trial}`;

    const bank = snapshotBank(versions);
    const got = assembleExam(bank, categoryCounts, difficultyCounts, history, seed);
    const want = exhaustiveBest(versions, categoryCounts, difficultyCounts, history, seed);

    if (want === null) {
      infeasible += 1;
      assert.equal(got.ok, false, `trial ${trial}: 穷举无解但组卷返回了试卷`);
      continue;
    }
    feasible += 1;
    assert.equal(got.ok, true, `trial ${trial}: 穷举有解但组卷返回无解`);
    if (!got.ok) continue;
    assert.equal(got.repeats, want.repeats, `trial ${trial}: 重复题数量不是最优`);
    assert.equal(got.totalCost, want.totalCost, `trial ${trial}: 随机成本总和不是最优`);
    // 配额精确满足
    const catUsed = new Map<string, number>();
    const diffUsed = new Map<string, number>();
    const ids = new Set<string>();
    for (const q of got.questions) {
      assert.ok(!ids.has(q.questionId), "同一 questionId 重复出现");
      ids.add(q.questionId);
      catUsed.set(q.category, (catUsed.get(q.category) ?? 0) + 1);
      diffUsed.set(q.difficulty, (diffUsed.get(q.difficulty) ?? 0) + 1);
    }
    for (const c of Object.keys(categoryCounts)) {
      assert.equal(catUsed.get(c) ?? 0, categoryCounts[c]!);
    }
    for (const d of Object.keys(difficultyCounts)) {
      assert.equal(diffUsed.get(d) ?? 0, (difficultyCounts as Record<string, number>)[d]!);
    }
    assert.equal(catUsed.size, Object.keys(categoryCounts).length);
    assert.equal(diffUsed.size, Object.keys(difficultyCounts).length);
  }
  // 确认两种情形都被覆盖
  assert.ok(feasible > 0, "随机用例应覆盖有解情形");
  assert.ok(infeasible > 0, "随机用例应覆盖无解情形");
});

test("各类别各难度分别充足但整体无解时明确返回无解", () => {
  // 代数、几何各自候选充足；基础、进阶各自题池也充足。
  // 但代数与几何都只有基础题，而基础配额只有 1：联合约束下无解。
  const versions = makeBank([
    ["a1", 1, "代数", "基础"],
    ["a2", 1, "代数", "基础"],
    ["g1", 1, "几何", "基础"],
    ["g2", 1, "几何", "基础"],
    ["s1", 1, "统计", "进阶"], // 进阶题存在，但统计配额为 0
  ]);
  const bank = snapshotBank(versions);
  const got = assembleExam(
    bank,
    { 代数: 1, 几何: 1 },
    { 基础: 1, 进阶: 1 },
    [],
    "s",
  );
  assert.equal(got.ok, false);
  if (got.ok) return;
  assert.ok(got.reason.length > 0);
  // 不得返回部分试卷
  assert.equal((got as { questions?: unknown }).questions, undefined);
});

test("两侧配额总数不一致时返回无解", () => {
  const bank = snapshotBank(makeBank([["a1", 1, "代数", "基础"]]));
  const got = assembleExam(bank, { 代数: 2 }, { 基础: 1 }, [], "s");
  assert.equal(got.ok, false);
});

test("非法配额（负数、非整数、未知难度）返回无解", () => {
  const bank = snapshotBank(makeBank([["a1", 1, "代数", "基础"]]));
  assert.equal(assembleExam(bank, { 代数: -1 }, {}, [], "s").ok, false);
  assert.equal(assembleExam(bank, { 代数: 1.5 }, { 基础: 1.5 }, [], "s").ok, false);
  const bad = assembleExam(
    bank,
    { 代数: 1 },
    { 入门: 1 } as unknown as Partial<Record<Difficulty, number>>,
    [],
    "s",
  );
  assert.equal(bad.ok, false);
});

test("只有最大 version 参与组卷，旧版不能作为额外候选", () => {
  const versions = makeBank([
    ["a1", 1, "代数", "基础"],
    ["a1", 2, "几何", "进阶"], // 修订后换类别换难度
    ["b1", 1, "代数", "基础"],
  ]);
  const bank = snapshotBank(versions);
  assert.equal(bank.questions.length, 2);
  const got = assembleExam(bank, { 几何: 1 }, { 进阶: 1 }, [], "s");
  assert.equal(got.ok, true);
  if (!got.ok) return;
  assert.deepEqual(
    got.questions.map((q) => [q.questionId, q.version]),
    [["a1", 2]],
  );
  // 旧版不算候选：代数基础名义上有 a1v1 与 b1，但 a1 已升级到几何进阶，
  // 要求 2 道代数基础时只剩 b1 一道候选，必须无解。
  const got2 = assembleExam(bank, { 代数: 2 }, { 基础: 2 }, [], "s");
  assert.equal(got2.ok, false);
});
