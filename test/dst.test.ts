import assert from "node:assert/strict";
import test from "node:test";
import { BoardScheduler } from "../src/index.js";
import type { CandidateInterval } from "../src/index.js";

const MIN = 60_000;
const utc = (iso: string): number => Date.parse(`${iso}Z`);
const isoMin = (ms: number): string => new Date(ms).toISOString().slice(0, 16);

function singleDirector(
  timeZone: string,
  windows: readonly { startDay: 0|1|2|3|4|5|6; startMinute: number; endMinute: number }[],
): BoardScheduler {
  const scheduler = new BoardScheduler();
  scheduler.setRoster([{ id: "solo", timeZone }]);
  scheduler.setWeeklyAvailability("solo", windows);
  return scheduler;
}

function starts(intervals: CandidateInterval[]): string[] {
  const out: string[] = [];
  for (const iv of intervals) {
    for (let ms = iv.firstStartMs; ms <= iv.lastStartMs; ms += MIN) {
      out.push(isoMin(ms));
    }
  }
  return out;
}

test("fall-back: repeated wall clock counts twice, only UTC 06:30-06:45 qualify", () => {
  // America/New_York, Sunday 01:30-02:30 local. On 2024-11-03 the wall
  // interval 01:30-02:00 happens twice (UTC 05:30-06:00 and 06:30-07:00)
  // and 02:00-02:30 once (UTC 07:00-07:30). A 45-minute meeting fits only
  // inside the second stretch: starts UTC 06:30..06:45.
  const scheduler = singleDirector("America/New_York", [
    { startDay: 0, startMinute: 90, endMinute: 150 },
  ]);
  const result = scheduler.findCandidates({
    rangeStartMs: utc("2024-11-03T00:00:00"),
    rangeEndMs: utc("2024-11-04T00:00:00"),
    durationMinutes: 45,
    quorumPercent: 100,
  });
  assert.deepEqual(result, [
    { firstStartMs: utc("2024-11-03T06:30:00"), lastStartMs: utc("2024-11-03T06:45:00") },
  ]);
  assert.deepEqual(
    starts(result),
    Array.from({ length: 16 }, (_, i) => isoMin(utc("2024-11-03T06:30:00") + i * MIN)),
  );
});

test("spring-forward: window entirely inside the gap yields nothing", () => {
  // 2024-03-10 America/New_York jumps 02:00 -> 03:00; local 02:00-03:00
  // never happens, so a window covering exactly that must not produce any
  // availability that day.
  const scheduler = singleDirector("America/New_York", [
    { startDay: 0, startMinute: 120, endMinute: 180 },
  ]);
  const result = scheduler.findCandidates({
    rangeStartMs: utc("2024-03-10T00:00:00"),
    rangeEndMs: utc("2024-03-11T00:00:00"),
    durationMinutes: 1,
    quorumPercent: 100,
  });
  assert.deepEqual(result, []);
});

test("spring-forward: window partially in the gap keeps only real minutes", () => {
  // Local 01:30-02:30 on 2024-03-10: only 01:30-02:00 exists
  // (UTC 06:30-07:00). 02:00-02:30 is skipped.
  const scheduler = singleDirector("America/New_York", [
    { startDay: 0, startMinute: 90, endMinute: 150 },
  ]);
  const result = scheduler.findCandidates({
    rangeStartMs: utc("2024-03-10T00:00:00"),
    rangeEndMs: utc("2024-03-11T00:00:00"),
    durationMinutes: 1,
    quorumPercent: 100,
  });
  assert.deepEqual(result, [
    { firstStartMs: utc("2024-03-10T06:30:00"), lastStartMs: utc("2024-03-10T06:59:00") },
  ]);
});

test("Lord Howe: half-hour spring forward removes 02:00-02:30 only", () => {
  // 2024-10-06 Australia/Lord_Howe jumps 02:00 -> 02:30 (+10:30 -> +11:00).
  // Window 01:00-03:00 local keeps 01:00-02:00 (UTC 14:30-15:30 prev day)
  // and 02:30-03:00 (UTC 15:30-16:00); the UTC pieces touch and merge.
  const scheduler = singleDirector("Australia/Lord_Howe", [
    { startDay: 0, startMinute: 60, endMinute: 180 },
  ]);
  const result = scheduler.findCandidates({
    rangeStartMs: utc("2024-10-05T12:00:00"),
    rangeEndMs: utc("2024-10-06T12:00:00"),
    durationMinutes: 1,
    quorumPercent: 100,
  });
  assert.deepEqual(result, [
    { firstStartMs: utc("2024-10-05T14:30:00"), lastStartMs: utc("2024-10-05T15:59:00") },
  ]);
});

test("Lord Howe: half-hour fall back repeats 01:30-02:00", () => {
  // 2024-04-07 Lord Howe falls back 02:00 -> 01:30 (+11:00 -> +10:30).
  // Window 01:30-02:00 local occurs twice: UTC 14:30-15:00 and 15:00-15:30,
  // merging into one 60-minute UTC stretch.
  const scheduler = singleDirector("Australia/Lord_Howe", [
    { startDay: 0, startMinute: 90, endMinute: 120 },
  ]);
  const result = scheduler.findCandidates({
    rangeStartMs: utc("2024-04-06T12:00:00"),
    rangeEndMs: utc("2024-04-07T12:00:00"),
    durationMinutes: 45,
    quorumPercent: 100,
  });
  assert.deepEqual(result, [
    { firstStartMs: utc("2024-04-06T14:30:00"), lastStartMs: utc("2024-04-06T14:45:00") },
  ]);
});

test("Lord Howe: window inside the half-hour gap vanishes", () => {
  const scheduler = singleDirector("Australia/Lord_Howe", [
    { startDay: 0, startMinute: 120, endMinute: 150 },
  ]);
  const result = scheduler.findCandidates({
    rangeStartMs: utc("2024-10-05T12:00:00"),
    rangeEndMs: utc("2024-10-06T12:00:00"),
    durationMinutes: 1,
    quorumPercent: 100,
  });
  assert.deepEqual(result, []);
});
