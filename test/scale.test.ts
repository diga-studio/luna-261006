import { test } from "node:test";
import * as assert from "node:assert/strict";
import { MatchingEvent } from "../src/event";
import type { RoundPlan } from "../src/types";

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const N = 300;
const TAGS = 64;
const ROUNDS = 12;

function buildParticipants(tagsPerPerson: number, seed: number) {
  const rand = rng(seed);
  return Array.from({ length: N }, (_, i) => {
    const tags = new Set<string>();
    while (tags.size < tagsPerPerson) {
      tags.add(`t${Math.floor(rand() * TAGS)}`);
    }
    return { id: `p${i}`, tags: [...tags] };
  });
}

function buildAttendance(seed: number, presence: number): string[][] {
  const rand = rng(seed);
  return Array.from({ length: ROUNDS }, () =>
    Array.from({ length: N }, (_, i) => `p${i}`).filter(() => rand() < presence),
  );
}

function checkSchedule(
  participants: Array<{ id: string; tags: string[] }>,
  attendance: string[][],
  rounds: RoundPlan[],
): void {
  const tagSets = new Map(participants.map((p) => [p.id, new Set(p.tags)]));
  const usedPairs = new Set<string>();
  let totalPairs = 0;
  for (const round of rounds) {
    const attending = new Set(attendance[round.round]);
    const seen = new Set<string>();
    for (const [a, b] of round.pairs) {
      assert.ok(attending.has(a) && attending.has(b), "pair attends");
      const ta = tagSets.get(a)!;
      assert.ok([...tagSets.get(b)!].some((t) => ta.has(t)), "pair shares tag");
      const k = a < b ? `${a}|${b}` : `${b}|${a}`;
      assert.ok(!usedPairs.has(k), `pair ${k} repeated across rounds`);
      usedPairs.add(k);
      assert.ok(!seen.has(a) && !seen.has(b), "one pair per person per round");
      seen.add(a);
      seen.add(b);
      totalPairs++;
    }
    assert.strictEqual(
      round.byes.length + seen.size,
      attending.size,
      "byes + paired = attending",
    );
  }
  assert.ok(totalPairs > 0, "some pairs were formed");
}

for (const [name, tagsPerPerson, presence] of [
  ["dense", 20, 0.9],
  ["sparse", 2, 0.8],
] as Array<[string, number, number]>) {
  test(`scale: ${N} participants, ${TAGS} tags, ${ROUNDS} rounds (${name})`, () => {
    const participants = buildParticipants(tagsPerPerson, 42);
    const attendance = buildAttendance(43, presence);
    const ev = new MatchingEvent({ participants, rounds: ROUNDS });
    const t0 = Date.now();
    const plan = ev.generateSchedule(attendance);
    const elapsed = Date.now() - t0;
    assert.strictEqual(plan.length, ROUNDS);
    checkSchedule(participants, attendance, plan);
    assert.ok(elapsed < 15000, `generation took ${elapsed}ms`);
    console.log(`    ${name}: full ${ROUNDS}-round generation in ${elapsed}ms`);

    // Confirm half the rounds, then replan the rest with new attendance.
    for (let r = 0; r < ROUNDS / 2; r++) ev.confirmNextRound();
    const confirmed = ev.getConfirmedRounds();
    const newFuture = buildAttendance(44, presence).slice(ROUNDS / 2);
    const t1 = Date.now();
    const replanned = ev.generateSchedule(newFuture);
    const replanElapsed = Date.now() - t1;
    assert.deepStrictEqual(ev.getConfirmedRounds(), confirmed);
    checkSchedule(
      participants,
      [...attendance.slice(0, ROUNDS / 2), ...newFuture],
      [...confirmed, ...replanned],
    );
    assert.ok(replanElapsed < 15000, `replan took ${replanElapsed}ms`);
    console.log(`    ${name}: replan of 6 rounds in ${replanElapsed}ms`);
  });
}
