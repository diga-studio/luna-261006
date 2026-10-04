import test from "node:test";
import assert from "node:assert/strict";
import { advance, elapsed, inspectLead, BusinessCalendar } from "../src/index";

const MIN = 60_000;
const HOUR = 3_600_000;

const dstFallbackDay: BusinessCalendar = {
  timeZone: "America/New_York",
  weekly: {},
  exceptions: { "2024-11-03": [{ start: "01:30", end: "01:45" }] },
};

test("fall-back day: repeated wall clock counts twice", () => {
  const from = Date.parse("2024-11-03T05:00:00Z");
  const to = Date.parse("2024-11-03T07:00:00Z");
  assert.equal(elapsed(dstFallbackDay, from, to), 30 * MIN);
});

test("fall-back day: advance walks across the closed gap", () => {
  const from = Date.parse("2024-11-03T05:00:00Z");
  assert.equal(advance(dstFallbackDay, from, 20 * MIN), Date.parse("2024-11-03T06:35:00Z"));
});

const weekdayCalendar: BusinessCalendar = {
  timeZone: "UTC",
  weekly: {
    1: [{ start: "09:00", end: "13:00" }],
    3: [{ start: "09:00", end: "13:00" }],
  },
  exceptions: { "2024-03-06": [] },
};

const createdAt = Date.parse("2024-03-04T09:00:00Z"); // Monday open

test("exactly 4h elapsed at close is not timed out", () => {
  const duringClose = Date.parse("2024-03-04T18:00:00Z");
  const result = inspectLead(weekdayCalendar, createdAt, null, duringClose);
  assert.equal(result.elapsedMs, 4 * HOUR);
  assert.equal(result.timedOut, false);
});

test("exception rest day does not add elapsed time", () => {
  const restDay = Date.parse("2024-03-06T12:00:00Z"); // Wednesday, overridden closed
  const result = inspectLead(weekdayCalendar, createdAt, null, restDay);
  assert.equal(result.elapsedMs, 4 * HOUR);
  assert.equal(result.timedOut, false);
});

test("times out 1ms after business resumes", () => {
  const afterReopen = Date.parse("2024-03-11T09:00:00.001Z"); // next Monday
  const result = inspectLead(weekdayCalendar, createdAt, null, afterReopen);
  assert.equal(result.elapsedMs, 4 * HOUR + 1);
  assert.equal(result.timedOut, true);
});

test("follow-up during closed period keeps lead within SLA forever", () => {
  const firstActionAt = Date.parse("2024-03-04T18:00:00Z"); // closed, 4h elapsed
  const later = Date.parse("2024-03-20T12:00:00Z");
  const result = inspectLead(weekdayCalendar, createdAt, firstActionAt, later);
  assert.equal(result.elapsedMs, 4 * HOUR);
  assert.equal(result.timedOut, false);
});

test("late follow-up still reports timed out", () => {
  const firstActionAt = Date.parse("2024-03-11T10:00:00Z"); // 5h business elapsed
  const later = Date.parse("2024-03-20T12:00:00Z");
  const result = inspectLead(weekdayCalendar, createdAt, firstActionAt, later);
  assert.equal(result.elapsedMs, 5 * HOUR);
  assert.equal(result.timedOut, true);
});

test("advance returns the close instant when budget ends exactly at close", () => {
  assert.equal(advance(weekdayCalendar, createdAt, 4 * HOUR), Date.parse("2024-03-04T13:00:00Z"));
});

test("advance with zero budget returns from", () => {
  assert.equal(advance(weekdayCalendar, createdAt, 0), createdAt);
});

test("overlapping windows are unioned", () => {
  const cal: BusinessCalendar = {
    timeZone: "UTC",
    weekly: { 1: [{ start: "09:00", end: "11:00" }, { start: "10:00", end: "12:00" }] },
  };
  const from = Date.parse("2024-03-04T08:00:00Z");
  const to = Date.parse("2024-03-04T14:00:00Z");
  assert.equal(elapsed(cal, from, to), 3 * HOUR);
});

test("window ending at 24:00 runs to midnight", () => {
  const cal: BusinessCalendar = {
    timeZone: "UTC",
    weekly: { 1: [{ start: "22:00", end: "24:00" }] },
  };
  const from = Date.parse("2024-03-04T20:00:00Z");
  const to = Date.parse("2024-03-05T01:00:00Z");
  assert.equal(elapsed(cal, from, to), 2 * HOUR);
});

test("spring-forward day: skipped wall clock has no duration", () => {
  const cal: BusinessCalendar = {
    timeZone: "America/New_York",
    weekly: {},
    exceptions: { "2024-03-10": [{ start: "01:30", end: "03:30" }] },
  };
  const from = Date.parse("2024-03-10T05:00:00Z");
  const to = Date.parse("2024-03-10T09:00:00Z");
  // 01:30-02:00 EST (05:00-07:00Z wall gap at 02:00) + 03:00-03:30 EDT = 1h real time.
  assert.equal(elapsed(cal, from, to), HOUR);
  assert.equal(advance(cal, from, HOUR), Date.parse("2024-03-10T07:30:00Z"));
});
