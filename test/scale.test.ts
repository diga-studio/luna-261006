import assert from "node:assert/strict";
import test from "node:test";
import { BoardScheduler } from "../src/index.js";
import type { WeeklyWindow } from "../src/index.js";

const MIN = 60_000;
const DAY_MIN = 24 * 60;

const TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "America/Santiago",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Europe/Helsinki",
  "Africa/Casablanca",
  "Asia/Dubai",
  "Asia/Kathmandu",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Australia/Lord_Howe",
  "Pacific/Auckland",
  "Pacific/Chatham",
];

test("300 directors x 10 windows x 20 zones over 180 days finishes well under 20s", () => {
  const scheduler = new BoardScheduler();
  const roster = Array.from({ length: 300 }, (_, i) => ({
    id: `D${i}`,
    timeZone: TIMEZONES[i % TIMEZONES.length]!,
  }));
  scheduler.setRoster(roster);
  for (let i = 0; i < roster.length; i += 1) {
    const windows: WeeklyWindow[] = [];
    for (let w = 0; w < 10; w += 1) {
      const startDay = (i + w) % 7;
      const startMinute = ((i * 37 + w * 149) % (DAY_MIN - 120));
      windows.push({
        startDay: startDay as WeeklyWindow["startDay"],
        startMinute,
        endMinute: startMinute + 90,
      });
    }
    scheduler.setWeeklyAvailability(`D${i}`, windows);
  }
  const rangeStartMs = Date.parse("2026-01-01T00:00:00Z");
  const rangeEndMs = rangeStartMs + 180 * DAY_MIN * MIN;
  const started = performance.now();
  const result = scheduler.findCandidates({
    rangeStartMs,
    rangeEndMs,
    durationMinutes: 60,
    quorumPercent: 5,
  });
  const elapsedMs = performance.now() - started;
  assert.ok(result.length > 0, "expected some candidate runs");
  assert.ok(
    elapsedMs < 20_000,
    `query took ${elapsedMs.toFixed(0)}ms, expected < 20000ms`,
  );
  // Every returned run must be non-empty and minute-aligned.
  for (const iv of result) {
    assert.ok(iv.lastStartMs >= iv.firstStartMs);
    assert.equal(iv.firstStartMs % MIN, 0);
    assert.equal(iv.lastStartMs % MIN, 0);
  }
  console.log(`    scale query: ${elapsedMs.toFixed(0)}ms, ${result.length} runs`);
});
