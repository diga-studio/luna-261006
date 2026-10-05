import { test } from "node:test";
import { equal, deepEqual } from "node:assert/strict";
import { buildSchedulerState, planRound } from "../src/scheduler.js";
import { bruteForceObjectives, objectivesOf, mulberry32 } from "./helpers.js";

const NO_PAIRS = () => false;

function idMap(ids: string[]): Map<string, number> {
  return new Map(ids.map((id, i) => [id, i]));
}

test("triangle: three mutually pairable attendees, one bye per round", () => {
  const state = buildSchedulerState([
    { id: "P0", tags: ["x", "y"] },
    { id: "P1", tags: ["x", "z"] },
    { id: "P2", tags: ["y", "z"] },
  ]);
  const byeCounts = [0, 0, 0];
  const plan = planRound(state, 0, [0, 1, 2], NO_PAIRS, byeCounts);
  equal(plan.result.pairs.length, 1);
  equal(plan.result.byes.length, 1);
  const want = bruteForceObjectives(state.tagMasks, byeCounts, NO_PAIRS);
  const got = objectivesOf(plan.result, [0, 1, 2], idMap(state.ids), byeCounts);
  deepEqual(got, want);
});

test("high-score local pair must not reduce the number of pairs", () => {
  // Path A-B-C-D: B-C share 5 tags, A-B and C-D share 1 each.
  // Picking B-C (score 5) blocks A-B and C-D: only 1 pair.
  // Optimal is A-B + C-D: 2 pairs with total score 2.
  const state = buildSchedulerState([
    { id: "A", tags: ["t0"] },
    { id: "B", tags: ["t0", "t1", "t2", "t3", "t4", "t5"] },
    { id: "C", tags: ["t1", "t2", "t3", "t4", "t5", "t6"] },
    { id: "D", tags: ["t6"] },
  ]);
  const byeCounts = [0, 0, 0, 0];
  const plan = planRound(state, 0, [0, 1, 2, 3], NO_PAIRS, byeCounts);
  equal(plan.result.pairs.length, 2, "must prefer 2 pairs over 1 high-score pair");
  const got = objectivesOf(plan.result, [0, 1, 2, 3], idMap(state.ids), byeCounts);
  equal(got.tagSum, 2);
  const want = bruteForceObjectives(state.tagMasks, byeCounts, NO_PAIRS);
  deepEqual(got, want);
});

test("fairness (bye squares) beats common-tag score", () => {
  // Bye counts [1, 0, 0]. Options:
  //  - bye P0: pair(P1,P2) score 1, squares (2,0,0) -> 4
  //  - bye P1: pair(P0,P2) score 1, squares (1,1,0) -> 2
  //  - bye P2: pair(P0,P1) score 5, squares (1,0,1) -> 2
  // Fairness eliminates "bye P0"; tag score then picks "bye P2".
  const state = buildSchedulerState([
    { id: "P0", tags: ["a", "b", "c", "d", "e"] },
    { id: "P1", tags: ["a", "b", "c", "d", "e"] },
    { id: "P2", tags: ["a"] },
  ]);
  const byeCounts = [1, 0, 0];
  const plan = planRound(state, 0, [0, 1, 2], NO_PAIRS, byeCounts);
  equal(plan.result.pairs.length, 1);
  deepEqual(plan.result.byes, ["P2"], "P2 must sit out: squares 2 + score 5 wins");
  const got = objectivesOf(plan.result, [0, 1, 2], idMap(state.ids), byeCounts);
  deepEqual(got, { pairs: 1, byeSquares: 2, tagSum: 5 });
  const want = bruteForceObjectives(state.tagMasks, byeCounts, NO_PAIRS);
  deepEqual(got, want);
});

test("random small rounds match brute force objectives", () => {
  const rand = mulberry32(777);
  for (let iter = 0; iter < 200; iter++) {
    const nTags = 2 + Math.floor(rand() * 5);
    const n = 2 + Math.floor(rand() * 7); // 2..8 participants
    const participants = Array.from({ length: n }, (_, i) => ({
      id: `P${i}`,
      tags: Array.from({ length: nTags }, (_, t) => `t${t}`).filter(() => rand() < 0.5),
    }));
    const state = buildSchedulerState(participants);
    const byeCounts = participants.map(() => Math.floor(rand() * 3));
    const blockedPairs = new Set<string>();
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (rand() < 0.2) blockedPairs.add(`${i},${j}`);
      }
    }
    const blocked = (i: number, j: number) =>
      blockedPairs.has(i < j ? `${i},${j}` : `${j},${i}`);
    const attendees = participants.map((_, i) => i).filter(() => rand() < 0.85);
    const plan = planRound(state, 0, attendees, blocked, byeCounts);
    const attMasks = attendees.map((i) => state.tagMasks[i]);
    const attByes = attendees.map((i) => byeCounts[i]);
    const attBlocked = (a: number, b: number) => blocked(attendees[a], attendees[b]);
    const want = bruteForceObjectives(attMasks, attByes, attBlocked);
    const idToPos = new Map<string, number>();
    attendees.forEach((p, pos) => idToPos.set(state.ids[p], pos));
    const got = objectivesOf(plan.result, attendees.map((_, pos) => pos), idToPos, attByes);
    deepEqual(got, want, `iter=${iter} attendees=${attendees.length}`);
  }
});
