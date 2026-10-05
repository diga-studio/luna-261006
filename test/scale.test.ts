import { test } from "node:test";
import { ok, equal } from "node:assert/strict";
import { ActivityEvent } from "../src/event.js";
import type { Participant, RoundResult } from "../src/types.js";
import { mulberry32 } from "./helpers.js";

const N = 300;
const N_TAGS = 64;
const ROUNDS = 12;
const TIME_LIMIT_MS = 15_000;
const MEM_LIMIT_BYTES = 256 * 1024 * 1024;

function checkPlanIntegrity(plan: RoundResult[], confirmed: RoundResult[]): void {
  const seen = new Set<string>();
  for (const round of [...confirmed, ...plan]) {
    const inPairs = new Set<string>();
    for (const pair of round.pairs) {
      ok(pair.commonTags.length > 0, "pair shares at least one tag");
      ok(!inPairs.has(pair.a) && !inPairs.has(pair.b), "one pair per person per round");
      inPairs.add(pair.a);
      inPairs.add(pair.b);
      const key = pair.a < pair.b ? `${pair.a}|${pair.b}` : `${pair.b}|${pair.a}`;
      ok(!seen.has(key), `no repeated meeting across the event: ${key}`);
      seen.add(key);
    }
    for (const id of round.byes) ok(!inPairs.has(id), "bye is not paired");
  }
}

function runScale(name: string, makeTags: (i: number, rand: () => number) => string[]): void {
  const rand = mulberry32(20261005);
  const participants: Participant[] = Array.from({ length: N }, (_, i) => ({
    id: `P${i}`,
    tags: makeTags(i, rand),
  }));
  const ev = new ActivityEvent(participants, ROUNDS);
  const attendance: string[][] = Array.from({ length: ROUNDS }, () =>
    participants.map((p) => p.id).filter(() => rand() < 0.9),
  );
  const t0 = Date.now();
  const plan = ev.generateSchedule(attendance);
  const genMs = Date.now() - t0;
  equal(plan.length, ROUNDS);
  checkPlanIntegrity(plan, []);
  ok(genMs < TIME_LIMIT_MS, `${name}: full 12-round generation took ${genMs}ms (< ${TIME_LIMIT_MS}ms)`);

  // confirm two rounds, change future attendance, re-plan
  ev.confirmNextRound();
  ev.confirmNextRound();
  const t1 = Date.now();
  attendance[7] = participants.map((p) => p.id).filter(() => rand() < 0.75);
  const replanned = ev.updateAttendance(7, attendance[7]);
  const replanMs = Date.now() - t1;
  equal(replanned.length, ROUNDS - 2);
  checkPlanIntegrity(replanned, ev.getConfirmedRounds());
  ok(replanMs < TIME_LIMIT_MS, `${name}: replan took ${replanMs}ms (< ${TIME_LIMIT_MS}ms)`);

  const mem = process.memoryUsage();
  ok(mem.heapUsed < MEM_LIMIT_BYTES, `${name}: heapUsed ${(mem.heapUsed / 1048576).toFixed(1)} MiB`);
  ok(mem.rss < MEM_LIMIT_BYTES, `${name}: rss ${(mem.rss / 1048576).toFixed(1)} MiB`);
  console.log(`  ${name}: generate=${genMs}ms replan=${replanMs}ms heap=${(mem.heapUsed / 1048576).toFixed(1)}MiB rss=${(mem.rss / 1048576).toFixed(1)}MiB`);
}

test("scale: 300 participants, 64 tags, 12 rounds, dense interests", () => {
  runScale("dense", (_i, rand) =>
    Array.from({ length: N_TAGS }, (_, t) => `t${t}`).filter(() => rand() < 0.5),
  );
});

test("scale: 300 participants, 64 tags, 12 rounds, sparse interests", () => {
  runScale("sparse", (_i, rand) => [
    `t${Math.floor(rand() * N_TAGS)}`,
    `t${Math.floor(rand() * N_TAGS)}`,
  ]);
});
