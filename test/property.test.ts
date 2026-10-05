import test from "node:test";
import assert from "node:assert/strict";
import { settle } from "../src/index";
import type { SettleInput, SettleOutput } from "../src/index";
import { computeShares } from "../src/shares";
import { ceilRat, floorRat, roundHalfUp, add, ratFromInt } from "../src/rational";
import type { Rat } from "../src/rational";

/** 可复现的伪随机数生成器。 */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function randomInput(rand: () => number): SettleInput {
  const indicators = ["K1", "K2"].slice(0, 1 + Math.floor(rand() * 2));
  const authors = ["A", "B", "C", "D"];
  const workCount = 1 + Math.floor(rand() * 6);
  const works = [];
  for (let i = 0; i < workCount; i++) {
    const n = 1 + Math.floor(rand() * 3);
    const shuffled = [...authors].sort(() => rand() - 0.5);
    works.push({
      id: "w" + i,
      indicator: indicators[Math.floor(rand() * indicators.length)]!,
      budget: Math.floor(rand() * 21),
      authors: shuffled.slice(0, n),
    });
  }
  const caps = [];
  for (const author of authors) {
    for (const indicator of indicators) {
      caps.push({ author, indicator, cap: Math.floor(rand() * 26) });
    }
  }
  return { works, caps };
}

/** 独立校验输出是否满足全部四层约束。 */
function verify(input: SettleInput, out: SettleOutput): void {
  const cells = computeShares(input);
  const zOf = new Map<string, number>();
  for (const w of out) {
    const work = input.works.find((x) => x.id === w.workId)!;
    for (const author of Object.keys(w.shares)) {
      assert.ok(work.authors.includes(author), "未署名作者不得分积分");
      zOf.set(w.workId + "|" + author, w.shares[author]!);
    }
  }
  // 单元格层面
  for (const cell of cells) {
    const work = input.works[cell.workIndex]!;
    const z = zOf.get(work.id + "|" + cell.author) ?? 0;
    const lo = floorRat(cell.x);
    const hi = ceilRat(cell.x);
    assert.ok(BigInt(z) === lo || BigInt(z) === hi,
      "单元格取整越界: z=" + z + " x=" + cell.x.num + "/" + cell.x.den);
  }
  // 成果层面
  input.works.forEach((work, i) => {
    const xs = cells.filter((c) => c.workIndex === i).map((c) => c.x);
    const sum = xs.reduce((a: Rat, b) => add(a, b), ratFromInt(0n));
    const z = work.authors.reduce((s, a) => s + (zOf.get(work.id + "|" + a) ?? 0), 0);
    assert.ok(BigInt(z) === floorRat(sum) || BigInt(z) === ceilRat(sum),
      "成果 " + work.id + " 合计越界");
  });
  // （作者, 指标）组合层面
  const combos = new Map<string, { sum: Rat; z: number; cap: number }>();
  for (const cell of cells) {
    const work = input.works[cell.workIndex]!;
    const key = cell.author + "|" + work.indicator;
    const entry = combos.get(key) ?? { sum: ratFromInt(0n), z: 0, cap: 0 };
    entry.sum = add(entry.sum, cell.x);
    entry.z += zOf.get(work.id + "|" + cell.author) ?? 0;
    combos.set(key, entry);
  }
  for (const [key, entry] of combos) {
    const [author, indicator] = key.split("|");
    const cap = input.caps.find(
      (c) => c.author === author && c.indicator === indicator,
    );
    assert.ok(
      BigInt(entry.z) === floorRat(entry.sum) || BigInt(entry.z) === ceilRat(entry.sum),
      "组合 " + key + " 合计越界",
    );
    if (cap) assert.ok(entry.z <= cap.cap, "组合 " + key + " 超过上限");
  }
  // 指标层面
  const indicators = new Map<string, { sum: Rat; z: number }>();
  for (const cell of cells) {
    const work = input.works[cell.workIndex]!;
    const entry = indicators.get(work.indicator) ?? { sum: ratFromInt(0n), z: 0 };
    entry.sum = add(entry.sum, cell.x);
    entry.z += zOf.get(work.id + "|" + cell.author) ?? 0;
    indicators.set(work.indicator, entry);
  }
  for (const [indicator, entry] of indicators) {
    assert.equal(BigInt(entry.z), roundHalfUp(entry.sum),
      "指标 " + indicator + " 合计必须等于四舍五入值");
  }
}

test("随机输入下三层汇总约束全部成立", () => {
  for (let seed = 1; seed <= 300; seed++) {
    const input = randomInput(lcg(seed));
    const out = settle(input);
    verify(input, out);
  }
});
