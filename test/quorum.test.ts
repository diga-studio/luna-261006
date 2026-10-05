import assert from "node:assert/strict";
import test from "node:test";
import { BoardScheduler } from "../src/index.js";

const utc = (iso: string): number => Date.parse(`${iso}Z`);

// 2024-06-02 is a Sunday (weekday 0); 2024-06-03 Monday (1), etc.
const DAY = utc("2024-06-02T00:00:00");

function threeDirectorBoard(): BoardScheduler {
  const scheduler = new BoardScheduler();
  scheduler.setRoster([
    { id: "A", timeZone: "UTC" },
    { id: "B", timeZone: "UTC" },
    { id: "C", timeZone: "UTC" },
  ]);
  return scheduler;
}

const dayQuery = {
  rangeStartMs: DAY,
  rangeEndMs: DAY + 24 * 60 * 60_000,
  durationMinutes: 60,
} as const;

test("rotating attendance never reaches quorum for the whole meeting", () => {
  const scheduler = threeDirectorBoard();
  // quorum = ceil(3 * 60%) = 2. A covers 09:00-10:00, B only the first
  // half, C only the second half: instantaneous quorum holds, but no
  // 60-minute meeting keeps 2 directors throughout.
  scheduler.setWeeklyAvailability("A", [{ startDay: 0, startMinute: 540, endMinute: 600 }]);
  scheduler.setWeeklyAvailability("B", [{ startDay: 0, startMinute: 540, endMinute: 570 }]);
  scheduler.setWeeklyAvailability("C", [{ startDay: 0, startMinute: 570, endMinute: 600 }]);
  assert.deepEqual(scheduler.findCandidates(dayQuery), []);
});

test("touching windows merge, so 09:00 becomes a candidate", () => {
  const scheduler = threeDirectorBoard();
  scheduler.setWeeklyAvailability("A", [{ startDay: 0, startMinute: 540, endMinute: 600 }]);
  scheduler.setWeeklyAvailability("B", [
    { startDay: 0, startMinute: 540, endMinute: 570 },
    { startDay: 0, startMinute: 570, endMinute: 600 },
  ]);
  scheduler.setWeeklyAvailability("C", [{ startDay: 0, startMinute: 570, endMinute: 600 }]);
  assert.deepEqual(scheduler.findCandidates(dayQuery), [
    { firstStartMs: DAY + 540 * 60_000, lastStartMs: DAY + 540 * 60_000 },
  ]);
});

test("uninvited and availability-less directors still count in the denominator", () => {
  const scheduler = threeDirectorBoard();
  scheduler.setWeeklyAvailability("A", [{ startDay: 0, startMinute: 540, endMinute: 600 }]);
  // B and C have no availability. quorum = ceil(3*60%) = 2, A alone is 1.
  assert.deepEqual(scheduler.findCandidates(dayQuery), []);
  // Inviting only A does not shrink the denominator either.
  assert.deepEqual(
    scheduler.findCandidates({ ...dayQuery, inviteeIds: ["A"] }),
    [],
  );
  // Lowering quorum to 34% (ceil(3*0.34)=2) still fails; 33% -> 1 passes.
  assert.deepEqual(
    scheduler.findCandidates({ ...dayQuery, quorumPercent: 34 }),
    [],
  );
  const ok = scheduler.findCandidates({ ...dayQuery, quorumPercent: 33 });
  assert.deepEqual(ok, [
    { firstStartMs: DAY + 540 * 60_000, lastStartMs: DAY + 540 * 60_000 },
  ]);
});

test("quorum rounds up: 5 directors at 60% need 3", () => {
  const scheduler = new BoardScheduler();
  scheduler.setRoster(
    ["A", "B", "C", "D", "E"].map((id) => ({ id, timeZone: "UTC" })),
  );
  for (const id of ["A", "B", "C", "D", "E"]) {
    scheduler.setWeeklyAvailability(id, [
      { startDay: 0, startMinute: 540, endMinute: 600 },
    ]);
  }
  const twoOnly = scheduler.findCandidates({ ...dayQuery, inviteeIds: ["A", "B"] });
  assert.deepEqual(twoOnly, []);
  const three = scheduler.findCandidates({ ...dayQuery, inviteeIds: ["A", "B", "C"] });
  assert.deepEqual(three, [
    { firstStartMs: DAY + 540 * 60_000, lastStartMs: DAY + 540 * 60_000 },
  ]);
});

test("cross-week window (Saturday 22:00 -> Monday 02:00 local) works", () => {
  const scheduler = new BoardScheduler();
  scheduler.setRoster([{ id: "solo", timeZone: "UTC" }]);
  // startDay 6 (Saturday) 22:00, endMinute 02:00 < startMinute => next day,
  // and chained via a second window to cross into the next week:
  // Sat 22:00 -> Sun 02:00, plus Sun 22:00 -> Mon 02:00.
  scheduler.setWeeklyAvailability("solo", [
    { startDay: 6, startMinute: 22 * 60, endMinute: 2 * 60 },
    { startDay: 0, startMinute: 22 * 60, endMinute: 2 * 60 },
  ]);
  // 2024-06-08 is a Saturday. Search the whole weekend in UTC.
  const sat = utc("2024-06-08T00:00:00");
  const result = scheduler.findCandidates({
    rangeStartMs: sat,
    rangeEndMs: sat + 3 * 24 * 60 * 60_000,
    durationMinutes: 240,
    quorumPercent: 100,
  });
  assert.deepEqual(result, [
    { firstStartMs: sat + 22 * 60 * 60_000, lastStartMs: sat + 22 * 60 * 60_000 },
    {
      firstStartMs: sat + 46 * 60 * 60_000,
      lastStartMs: sat + 46 * 60 * 60_000,
    },
  ]);
});

test("meeting must fit inside the search range; boundaries are minute-aligned", () => {
  const scheduler = new BoardScheduler();
  scheduler.setRoster([{ id: "solo", timeZone: "UTC" }]);
  scheduler.setWeeklyAvailability("solo", [
    { startDay: 0, startMinute: 0, endMinute: 23 * 60 + 59 },
  ]);
  // Range covers only 10:00-12:00 UTC on Sunday; 60-minute meetings may
  // start 10:00..11:00 inclusive even though availability extends further.
  const result = scheduler.findCandidates({
    rangeStartMs: DAY + 10 * 60 * 60_000,
    rangeEndMs: DAY + 12 * 60 * 60_000,
    durationMinutes: 60,
    quorumPercent: 100,
  });
  assert.deepEqual(result, [
    {
      firstStartMs: DAY + 10 * 60 * 60_000,
      lastStartMs: DAY + 11 * 60 * 60_000,
    },
  ]);
});

test("range longer than duration is required", () => {
  const scheduler = new BoardScheduler();
  scheduler.setRoster([{ id: "solo", timeZone: "UTC" }]);
  scheduler.setWeeklyAvailability("solo", [
    { startDay: 0, startMinute: 0, endMinute: 23 * 60 + 59 },
  ]);
  const result = scheduler.findCandidates({
    rangeStartMs: DAY,
    rangeEndMs: DAY + 30 * 60_000,
    durationMinutes: 60,
    quorumPercent: 100,
  });
  assert.deepEqual(result, []);
});

test("adjacent qualifying minutes merge even when attendee sets differ", () => {
  const scheduler = threeDirectorBoard();
  // A: 09:00-10:00, B: 09:30-10:30. quorum 33% of 3 -> ceil(0.99) = 1:
  // 30-min meetings may start 09:00..10:00; the attending director changes
  // at 09:31 (A's last feasible start is 09:30, B covers the rest), yet the
  // qualifying minutes are consecutive and must form a single run.
  scheduler.setWeeklyAvailability("A", [{ startDay: 0, startMinute: 540, endMinute: 600 }]);
  scheduler.setWeeklyAvailability("B", [{ startDay: 0, startMinute: 570, endMinute: 630 }]);
  const result = scheduler.findCandidates({
    ...dayQuery,
    durationMinutes: 30,
    quorumPercent: 33,
    inviteeIds: ["A", "B"],
  });
  assert.deepEqual(result, [
    { firstStartMs: DAY + 540 * 60_000, lastStartMs: DAY + 600 * 60_000 },
  ]);
});

test("invalid inputs are rejected", () => {
  const scheduler = threeDirectorBoard();
  assert.throws(() =>
    scheduler.findCandidates({ ...dayQuery, rangeStartMs: DAY + 1 }),
  );
  assert.throws(() =>
    scheduler.findCandidates({ ...dayQuery, durationMinutes: 0 }),
  );
  assert.throws(() =>
    scheduler.findCandidates({ ...dayQuery, inviteeIds: ["ZZ"] }),
  );
  assert.throws(() =>
    scheduler.setWeeklyAvailability("A", [
      { startDay: 0, startMinute: 60, endMinute: 60 },
    ]),
  );
  assert.throws(() =>
    scheduler.setRoster([{ id: "X", timeZone: "Not/AZone" }]),
  );
});
