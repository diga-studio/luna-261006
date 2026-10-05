import { test } from "node:test";
import * as assert from "node:assert/strict";
import { MatchingEvent } from "../src/event";
import type { RoundPlan } from "../src/types";

interface Ctx {
  ids: string[];
  tags: Map<string, Set<string>>;
}

function makeCtx(participants: Array<[string, string[]]>): Ctx {
  return {
    ids: participants.map(([id]) => id),
    tags: new Map(participants.map(([id, t]) => [id, new Set(t)])),
  };
}

function commonCount(ctx: Ctx, a: string, b: string): number {
  const ta = ctx.tags.get(a)!;
  const tb = ctx.tags.get(b)!;
  let c = 0;
  for (const t of ta) if (tb.has(t)) c++;
  return c;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Brute-force optimizer for one round: enumerate every legal matching of
 * the attending participants and pick the lexicographically best
 * (pairCount, -byeSquareSum, tagScore).
 */
function bruteForceRound(
  ctx: Ctx,
  attending: string[],
  byeBase: Map<string, number>,
  usedPairs: Set<string>,
): { pairCount: number; byeSquareSum: number; tagScore: number } {
  const edges: Array<[string, string, number]> = [];
  for (let a = 0; a < attending.length; a++) {
    for (let b = a + 1; b < attending.length; b++) {
      const x = attending[a]!;
      const y = attending[b]!;
      if (usedPairs.has(pairKey(x, y))) continue;
      const c = commonCount(ctx, x, y);
      if (c > 0) edges.push([x, y, c]);
    }
  }
  let best: [number, number, number] | null = null; // (pairCount, -byeSq, tag)
  const matched = new Set<string>();
  function consider(matching: Array<[string, string, number]>): void {
    const byeSq = ctx.ids.reduce((sum, id) => {
      const extra = attending.includes(id) && !matched.has(id) ? 1 : 0;
      const b = (byeBase.get(id) ?? 0) + extra;
      return sum + b * b;
    }, 0);
    const tag = matching.reduce((s, [, , c]) => s + c, 0);
    const cand: [number, number, number] = [matching.length, -byeSq, tag];
    if (best === null || cand[0] > best[0] ||
        (cand[0] === best[0] && (cand[1] > best[1] ||
          (cand[1] === best[1] && cand[2] > best[2])))) {
      best = cand;
    }
  }
  function go(ei: number, chosen: Array<[string, string, number]>): void {
    if (ei === edges.length) {
      consider(chosen);
      return;
    }
    go(ei + 1, chosen);
    const [x, y, c] = edges[ei]!;
    if (!matched.has(x) && !matched.has(y)) {
      matched.add(x);
      matched.add(y);
      chosen.push([x, y, c]);
      go(ei + 1, chosen);
      chosen.pop();
      matched.delete(x);
      matched.delete(y);
    }
  }
  go(0, []);
  const [pairCount, negByeSq, tagScore] = best!;
  return { pairCount, byeSquareSum: -negByeSq, tagScore };
}

/** Apply a round's result to the running state. */
function applyRound(
  round: RoundPlan,
  attending: string[],
  byeBase: Map<string, number>,
  usedPairs: Set<string>,
): void {
  for (const [a, b] of round.pairs) usedPairs.add(pairKey(a, b));
  for (const id of attending) {
    if (!round.pairs.some(([a, b]) => a === id || b === id)) {
      byeBase.set(id, (byeBase.get(id) ?? 0) + 1);
    }
  }
}

test("three mutually compatible participants: one pair, one bye", () => {
  const ev = new MatchingEvent({
    participants: [
      { id: "a", tags: ["x"] },
      { id: "b", tags: ["x"] },
      { id: "c", tags: ["x"] },
    ],
    rounds: 1,
  });
  const plan = ev.generateSchedule([["a", "b", "c"]]);
  assert.strictEqual(plan.length, 1);
  assert.strictEqual(plan[0]!.pairs.length, 1);
  assert.strictEqual(plan[0]!.byes.length, 1);
  const obj = ev.getRoundObjectives()[0]!;
  assert.deepStrictEqual(obj, { pairCount: 1, byeSquareSum: 1, tagScore: 1 });
});

test("pair count beats local high-score pair", () => {
  // A-B share 5 tags; A-C and B-D share 1 each. Taking A-B (score 5)
  // leaves C and D unmatched; the optimum takes two pairs (score 2).
  const ev = new MatchingEvent({
    participants: [
      { id: "A", tags: ["t1", "t2", "t3", "t4", "t5", "u"] },
      { id: "B", tags: ["t1", "t2", "t3", "t4", "t5", "v"] },
      { id: "C", tags: ["u"] },
      { id: "D", tags: ["v"] },
    ],
    rounds: 1,
  });
  const plan = ev.generateSchedule([["A", "B", "C", "D"]]);
  const obj = ev.getRoundObjectives()[0]!;
  assert.strictEqual(obj.pairCount, 2);
  assert.strictEqual(obj.tagScore, 2);
  assert.deepStrictEqual(
    [...plan[0]!.pairs].map(([a, b]) => pairKey(a, b)).sort(),
    ["A|C", "B|D"],
  );
});

test("bye fairness beats tag score when pair counts tie", () => {
  // Round 0: X attends alone -> one bye. Round 1: X,Y,Z attend.
  // Pairing Y-Z scores 5 but gives X a second bye (squares 4);
  // pairing X with anyone scores 1 but keeps squares at 2.
  const ev = new MatchingEvent({
    participants: [
      { id: "X", tags: ["t1"] },
      { id: "Y", tags: ["t1", "u1", "u2", "u3", "u4"] },
      { id: "Z", tags: ["t1", "u1", "u2", "u3", "u4"] },
    ],
    rounds: 2,
  });
  const plan = ev.generateSchedule([["X"], ["X", "Y", "Z"]]);
  assert.strictEqual(plan[0]!.byes.length, 1);
  const obj = ev.getRoundObjectives()[1]!;
  assert.strictEqual(obj.pairCount, 1);
  assert.strictEqual(obj.byeSquareSum, 2);
  assert.strictEqual(obj.tagScore, 1);
  assert.ok(plan[1]!.pairs[0]!.includes("X"), "X must be paired for fairness");
});

test("random small events match brute-force optimum every round", () => {
  let seed = 999;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let iter = 0; iter < 40; iter++) {
    const nP = 3 + Math.floor(rand() * 6); // 3..8 participants
    const nT = 3 + Math.floor(rand() * 4); // 3..6 tags
    const nR = 1 + Math.floor(rand() * 4); // 1..4 rounds
    const parts = Array.from({ length: nP }, (_, i) => ({
      id: `p${i}`,
      tags: Array.from(
        { length: 1 + Math.floor(rand() * nT) },
        () => `t${Math.floor(rand() * nT)}`,
      ),
    }));
    const ctx = makeCtx(parts.map((p) => [p.id, p.tags] as [string, string[]]));
    const attendance = Array.from({ length: nR }, () =>
      parts.map((p) => p.id).filter(() => rand() < 0.8),
    );
    const ev = new MatchingEvent({ participants: parts, rounds: nR });
    const plan = ev.generateSchedule(attendance);
    const objectives = ev.getRoundObjectives();
    const byeBase = new Map<string, number>(parts.map((p) => [p.id, 0]));
    const usedPairs = new Set<string>();
    for (let r = 0; r < nR; r++) {
      const want = bruteForceRound(ctx, attendance[r]!, byeBase, usedPairs);
      assert.deepStrictEqual(
        objectives[r],
        want,
        `iter ${iter} round ${r}: objectives must equal brute-force optimum`,
      );
      // Structural checks on the produced round.
      const round = plan[r]!;
      const seen = new Set<string>();
      for (const [a, b] of round.pairs) {
        assert.ok(attendance[r]!.includes(a) && attendance[r]!.includes(b));
        assert.ok(commonCount(ctx, a, b) > 0, "pair shares a tag");
        assert.ok(!usedPairs.has(pairKey(a, b)), "no repeated pair");
        assert.ok(!seen.has(a) && !seen.has(b), "one pair per person");
        seen.add(a);
        seen.add(b);
      }
      const byeSet = new Set(round.byes);
      assert.strictEqual(
        byeSet.size + seen.size,
        attendance[r]!.length,
        "byes + paired = attending",
      );
      applyRound(round, attendance[r]!, byeBase, usedPairs);
    }
  }
});

test("confirm two rounds, replan future attendance repeatedly", () => {
  const parts = Array.from({ length: 6 }, (_, i) => ({
    id: `p${i}`,
    tags: [`t${i % 3}`, "shared"],
  }));
  const all = parts.map((p) => p.id);
  const ev = new MatchingEvent({ participants: parts, rounds: 4 });
  ev.generateSchedule([all, all, all, all]);
  const c0 = ev.confirmNextRound();
  const c1 = ev.confirmNextRound();
  assert.strictEqual(c0.round, 0);
  assert.strictEqual(c1.round, 1);

  // Replan the future several times with changing attendance.
  const futures: string[][][] = [
    [all, all],
    [all.filter((id) => id !== "p0"), all],
    [all, all.filter((id) => id !== "p5")],
  ];
  for (const future of futures) {
    const plan = ev.generateSchedule(future);
    assert.strictEqual(plan.length, 2);
    assert.strictEqual(plan[0]!.round, 2);
    // Confirmed history untouched.
    assert.deepStrictEqual(ev.getConfirmedRounds(), [c0, c1]);
    // No repeated pairs across confirmed + planned rounds.
    const used = new Set<string>();
    for (const round of [...ev.getConfirmedRounds(), ...plan]) {
      for (const [a, b] of round.pairs) {
        const k = pairKey(a, b);
        assert.ok(!used.has(k), `pair ${k} repeated`);
        used.add(k);
      }
    }
    // Confirmed bye counts only reflect confirmed rounds.
    const byeCounts = ev.getConfirmedByeCounts();
    let total = 0;
    for (const v of byeCounts.values()) total += v;
    assert.strictEqual(total, c0.byes.length + c1.byes.length);
  }
  // Confirming consumes the latest plan in order.
  const c2 = ev.confirmNextRound();
  assert.strictEqual(c2.round, 2);
  assert.deepStrictEqual(ev.getConfirmedRounds(), [c0, c1, c2]);
});

test("generating twice does not accumulate history", () => {
  const parts = [
    { id: "a", tags: ["x"] },
    { id: "b", tags: ["x"] },
    { id: "c", tags: ["x"] },
    { id: "d", tags: ["x"] },
  ];
  const ev = new MatchingEvent({ participants: parts, rounds: 2 });
  const all = ["a", "b", "c", "d"];
  ev.generateSchedule([all, all]);
  const plan2 = ev.generateSchedule([all, all]);
  // Second generation must reproduce an identical, non-accumulated plan.
  assert.strictEqual(plan2.length, 2);
  const used = new Set<string>();
  for (const round of plan2) {
    for (const [a, b] of round.pairs) {
      const k = pairKey(a, b);
      assert.ok(!used.has(k), `pair ${k} repeated within one plan`);
      used.add(k);
    }
  }
  assert.strictEqual(ev.getConfirmedRounds().length, 0);
});

test("validation errors", () => {
  const parts = [
    { id: "a", tags: ["x"] },
    { id: "b", tags: ["x"] },
  ];
  assert.throws(() => new MatchingEvent({ participants: parts, rounds: 13 }));
  assert.throws(
    () =>
      new MatchingEvent({
        participants: [...parts, { id: "a", tags: [] }],
        rounds: 1,
      }),
  );
  const ev = new MatchingEvent({ participants: parts, rounds: 2 });
  assert.throws(() => ev.confirmNextRound());
  assert.throws(() => ev.generateSchedule([["a", "b"]])); // needs 2 rounds
  assert.throws(() => ev.generateSchedule([["a", "b", "zz"], ["a"]]));
  assert.throws(() => ev.generateSchedule([["a", "a"], ["a"]]));
  const tooManyTags = Array.from({ length: 65 }, (_, i) => `t${i}`);
  assert.throws(
    () =>
      new MatchingEvent({
        participants: [{ id: "a", tags: tooManyTags }],
        rounds: 1,
      }),
  );
});
