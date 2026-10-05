import { test } from "node:test";
import { equal, deepEqual, ok, fail } from "node:assert/strict";
import { ActivityEvent } from "../src/event.js";
import { buildSchedulerState } from "../src/scheduler.js";
import type { Participant, RoundResult } from "../src/types.js";
import { bruteForceObjectives, objectivesOf, mulberry32 } from "./helpers.js";

function makeParticipants(n: number, nTags: number, rand: () => number, p = 0.4): Participant[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `P${i}`,
    tags: Array.from({ length: nTags }, (_, t) => `t${t}`).filter(() => rand() < p),
  }));
}

/**
 * Replays confirmed + planned rounds from scratch and checks:
 * structure (disjoint pairs, byes = unmatched attendees), tag overlap,
 * no repeated meetings, per-round objectives vs brute force optimum.
 */
function validateAll(
  participants: Participant[],
  totalRounds: number,
  attendance: string[][],
  confirmed: RoundResult[],
  plan: RoundResult[],
): void {
  const state = buildSchedulerState(participants);
  const idxOf = new Map(state.ids.map((id, i) => [id, i]));
  const paired = new Set<string>();
  const byeCounts = new Array<number>(participants.length).fill(0);
  equal(confirmed.length + plan.length, totalRounds, "confirmed + plan covers all rounds");
  const all = [...confirmed, ...plan];
  for (let r = 0; r < totalRounds; r++) {
    const round = all[r];
    equal(round.round, r, "round indices are sequential");
    const attSet = new Set(attendance[r]);
    const inPairs = new Set<string>();
    for (const pair of round.pairs) {
      ok(attSet.has(pair.a) && attSet.has(pair.b), `round ${r}: pair members attend`);
      ok(pair.a !== pair.b, `round ${r}: no self pair`);
      ok(!inPairs.has(pair.a) && !inPairs.has(pair.b), `round ${r}: pairs disjoint`);
      inPairs.add(pair.a);
      inPairs.add(pair.b);
      const key = pair.a < pair.b ? `${pair.a}|${pair.b}` : `${pair.b}|${pair.a}`;
      ok(!paired.has(key), `round ${r}: no repeated meeting ${key}`);
      paired.add(key);
      const i = idxOf.get(pair.a)!;
      const j = idxOf.get(pair.b)!;
      const common = state.tagMasks[i] & state.tagMasks[j];
      ok(common !== 0n, `round ${r}: pair shares a tag`);
      const expectTags: string[] = [];
      for (let b = 0; b < state.tagNames.length; b++) {
        if (common & (1n << BigInt(b))) expectTags.push(state.tagNames[b]);
      }
      deepEqual(pair.commonTags, expectTags, `round ${r}: common tags listed`);
    }
    for (const id of round.byes) {
      ok(attSet.has(id), `round ${r}: bye attends`);
      ok(!inPairs.has(id), `round ${r}: bye not paired`);
    }
    equal(inPairs.size + round.byes.length, attSet.size, `round ${r}: everyone accounted for`);
    // objectives vs brute force
    const attendees = [...attSet].map((id) => idxOf.get(id)!);
    const attMasks = attendees.map((i) => state.tagMasks[i]);
    const attByes = attendees.map((i) => byeCounts[i]);
    // blocked must be evaluated against the pre-round paired set; this
    // round's pairs were added above, so remove them first.
    for (const pair of round.pairs) {
      const key = pair.a < pair.b ? `${pair.a}|${pair.b}` : `${pair.b}|${pair.a}`;
      paired.delete(key);
    }
    const blocked = (a: number, b: number) => {
      const x = state.ids[attendees[a]];
      const y = state.ids[attendees[b]];
      return paired.has(x < y ? `${x}|${y}` : `${y}|${x}`);
    };
    const want = bruteForceObjectives(attMasks, attByes, blocked);
    const idToPos = new Map<string, number>();
    attendees.forEach((p, pos) => idToPos.set(state.ids[p], pos));
    const got = objectivesOf(round, attendees.map((_, pos) => pos), idToPos, attByes);
    deepEqual(got, want, `round ${r}: objectives optimal`);
    // apply round
    for (const pair of round.pairs) {
      const key = pair.a < pair.b ? `${pair.a}|${pair.b}` : `${pair.b}|${pair.a}`;
      paired.add(key);
    }
    for (const id of round.byes) byeCounts[idxOf.get(id)!]++;
  }
}

test("full plan: every round is optimal vs brute force (small)", () => {
  const rand = mulberry32(42);
  const participants = makeParticipants(7, 5, rand, 0.6);
  const ev = new ActivityEvent(participants, 4);
  const attendance: string[][] = [];
  for (let r = 0; r < 4; r++) {
    attendance.push(participants.map((p) => p.id).filter(() => rand() < 0.85));
  }
  const plan = ev.generateSchedule(attendance);
  equal(plan.length, 4);
  validateAll(participants, 4, attendance, [], ev.getSchedule());
});

test("confirm two rounds, then modify future attendance repeatedly", () => {
  const rand = mulberry32(7);
  const participants = makeParticipants(8, 6, rand, 0.6);
  const totalRounds = 4;
  const ev = new ActivityEvent(participants, totalRounds);
  const attendance: string[][] = [];
  for (let r = 0; r < totalRounds; r++) {
    attendance.push(participants.map((p) => p.id).filter(() => rand() < 0.9));
  }
  ev.generateSchedule(attendance);

  const c0 = ev.confirmNextRound();
  const c1 = ev.confirmNextRound();
  equal(c0.round, 0);
  equal(c1.round, 1);
  const confirmedSnapshot = ev.getConfirmedRounds();

  // bye counts come from confirmed history only
  const expectByes: Record<string, number> = {};
  for (const p of participants) expectByes[p.id] = 0;
  for (const c of [c0, c1]) for (const id of c.byes) expectByes[id]++;
  deepEqual(ev.getByeCounts(), expectByes);

  // modify future attendance several times; confirmed must stay intact
  for (let k = 0; k < 5; k++) {
    const round = 2 + Math.floor(rand() * 2);
    attendance[round] = participants.map((p) => p.id).filter(() => rand() < 0.8);
    const plan = ev.updateAttendance(round, attendance[round]);
    equal(plan.length, totalRounds - 2);
    deepEqual(ev.getConfirmedRounds(), confirmedSnapshot, "confirmed rounds unchanged");
    deepEqual(ev.getByeCounts(), expectByes, "bye counts still from confirmed only");
    validateAll(participants, totalRounds, attendance, ev.getConfirmedRounds(), plan);
  }

  // re-generating repeatedly must not accumulate anything
  const planA = ev.generateSchedule();
  const planB = ev.generateSchedule();
  deepEqual(planA, planB);
  deepEqual(ev.getByeCounts(), expectByes);
  validateAll(participants, totalRounds, attendance, ev.getConfirmedRounds(), planA);

  // confirm the rest; every confirmed round matches the plan that was current
  const currentPlan = ev.getSchedule();
  const c2 = ev.confirmNextRound();
  deepEqual(c2, currentPlan[0]);
  const c3 = ev.confirmNextRound();
  deepEqual(c3, currentPlan[1]);
  equal(ev.getConfirmedRounds().length, totalRounds);
  equal(ev.getSchedule().length, 0);
});

test("confirming round by round stays optimal vs brute force", () => {
  const rand = mulberry32(2024);
  const participants = makeParticipants(7, 5, rand, 0.55);
  const totalRounds = 4;
  const ev = new ActivityEvent(participants, totalRounds);
  const attendance: string[][] = [];
  for (let r = 0; r < totalRounds; r++) {
    attendance.push(participants.map((p) => p.id).filter(() => rand() < 0.9));
  }
  ev.generateSchedule(attendance);
  for (let r = 0; r < totalRounds; r++) {
    validateAll(participants, totalRounds, attendance, ev.getConfirmedRounds(), ev.getSchedule());
    ev.confirmNextRound();
  }
  validateAll(participants, totalRounds, attendance, ev.getConfirmedRounds(), []);
});

test("fairness rotates byes across rounds (triangle)", () => {
  const participants: Participant[] = [
    { id: "A", tags: ["x"] },
    { id: "B", tags: ["x"] },
    { id: "C", tags: ["x"] },
  ];
  const ev = new ActivityEvent(participants, 3);
  ev.generateSchedule();
  const byeOf: string[] = [];
  for (let r = 0; r < 3; r++) {
    const round = ev.confirmNextRound();
    equal(round.pairs.length, 1);
    equal(round.byes.length, 1);
    byeOf.push(round.byes[0]);
  }
  deepEqual([...byeOf].sort(), ["A", "B", "C"], "each participant sits out exactly once");
  deepEqual(ev.getByeCounts(), { A: 1, B: 1, C: 1 });
});

test("validation errors", () => {
  const participants: Participant[] = [
    { id: "A", tags: ["x"] },
    { id: "B", tags: ["x"] },
  ];
  // duplicate ids
  let threw = false;
  try {
    new ActivityEvent([{ id: "A", tags: [] }, { id: "A", tags: [] }], 2);
  } catch {
    threw = true;
  }
  ok(threw, "duplicate ids rejected");
  // bad round counts
  for (const bad of [0, 13, 2.5, -1]) {
    threw = false;
    try {
      new ActivityEvent(participants, bad);
    } catch {
      threw = true;
    }
    ok(threw, `totalRounds=${bad} rejected`);
  }
  const ev = new ActivityEvent(participants, 2);
  // unknown attendee
  threw = false;
  try {
    ev.generateSchedule([["A", "ZZZ"], ["A"]]);
  } catch {
    threw = true;
  }
  ok(threw, "unknown attendee rejected");
  // wrong attendance length
  threw = false;
  try {
    ev.generateSchedule([["A"]]);
  } catch {
    threw = true;
  }
  ok(threw, "attendance length mismatch rejected");
  ev.generateSchedule([["A", "B"], ["A"]]);
  ev.confirmNextRound();
  // modifying a confirmed round
  threw = false;
  try {
    ev.updateAttendance(0, ["A"]);
  } catch {
    threw = true;
  }
  ok(threw, "confirmed round attendance is immutable");
  // confirming past the end
  ev.confirmNextRound();
  threw = false;
  try {
    ev.confirmNextRound();
  } catch {
    threw = true;
  }
  ok(threw, "confirming past the last round rejected");
});

test("generateSchedule ignores attendance entries of confirmed rounds", () => {
  const participants: Participant[] = [
    { id: "A", tags: ["x"] },
    { id: "B", tags: ["x"] },
    { id: "C", tags: ["x"] },
  ];
  const ev = new ActivityEvent(participants, 2);
  ev.generateSchedule([["A", "B", "C"], ["A", "B", "C"]]);
  const c0 = ev.confirmNextRound();
  // pass a different (would-be illegal) attendance for round 0: ignored
  const plan = ev.generateSchedule([["A"], ["A", "B"]]);
  deepEqual(ev.getConfirmedRounds(), [c0]);
  equal(plan.length, 1);
  equal(plan[0].round, 1);
  validateAll(participants, 2, [["A", "B", "C"], ["A", "B"]], ev.getConfirmedRounds(), plan);
});

test("returned schedules are snapshots; mutating them does not corrupt state", () => {
  const participants: Participant[] = [
    { id: "A", tags: ["x"] },
    { id: "B", tags: ["x"] },
    { id: "C", tags: ["x"] },
    { id: "D", tags: ["x"] },
  ];
  const ev = new ActivityEvent(participants, 2);
  const plan = ev.generateSchedule();
  const before = JSON.stringify(ev.getSchedule());
  plan[0].pairs.length = 0;
  plan[0].byes.length = 0;
  equal(JSON.stringify(ev.getSchedule()), before, "internal plan unaffected by mutation");
  const c0 = ev.confirmNextRound();
  c0.pairs.length = 0;
  equal(ev.getConfirmedRounds()[0].pairs.length, 2, "confirmed history unaffected");
});
