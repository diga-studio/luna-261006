import { test } from "node:test";
import assert from "node:assert/strict";
import { enumerateLocalDates, localToUtc } from "../src/timezone.js";

test("spring forward: nonexistent 02:30 shifts by the actual 1h gap to 03:30", () => {
  assert.equal(
    localToUtc("America/New_York", "2025-03-09", "02:30"),
    "2025-03-09T07:30:00.000Z",
  );
});

test("spring forward: 03:30 exists and maps to the same 07:30Z", () => {
  assert.equal(
    localToUtc("America/New_York", "2025-03-09", "03:30"),
    "2025-03-09T07:30:00.000Z",
  );
});

test("fall back: repeated 01:30 resolves to the earlier UTC instant", () => {
  assert.equal(
    localToUtc("America/New_York", "2025-11-02", "01:30"),
    "2025-11-02T05:30:00.000Z",
  );
});

test("30-minute gap: 02:15 shifts by 30 minutes to 02:45, not to gap end", () => {
  // Lord Howe Island springs forward 02:00 -> 02:30 on 2025-10-05.
  assert.equal(
    localToUtc("Australia/Lord_Howe", "2025-10-05", "02:15"),
    "2025-10-04T15:45:00.000Z",
  );
});

test("30-minute overlap: repeated 02:15 resolves to the earlier UTC instant", () => {
  // Lord Howe Island falls back 02:30 -> 02:00 on 2025-04-06.
  assert.equal(
    localToUtc("Australia/Lord_Howe", "2025-04-06", "02:15"),
    "2025-04-05T15:45:00.000Z",
  );
});

test("whole skipped local date produces no instant", () => {
  // Pacific/Apia skipped 2011-12-30 entirely.
  assert.equal(localToUtc("Pacific/Apia", "2011-12-30", "08:00"), null);
  assert.equal(localToUtc("Pacific/Apia", "2011-12-30", "00:00"), null);
  assert.equal(localToUtc("Pacific/Apia", "2011-12-30", "23:59"), null);
});

test("dates around a skipped day still resolve", () => {
  assert.equal(
    localToUtc("Pacific/Apia", "2011-12-29", "08:00"),
    "2011-12-29T18:00:00.000Z",
  );
  assert.equal(
    localToUtc("Pacific/Apia", "2011-12-31", "08:00"),
    "2011-12-30T18:00:00.000Z",
  );
});

test("enumerateLocalDates is end-exclusive", () => {
  assert.deepEqual(enumerateLocalDates("2025-03-08", "2025-03-11"), [
    "2025-03-08",
    "2025-03-09",
    "2025-03-10",
  ]);
  assert.deepEqual(enumerateLocalDates("2025-03-08", "2025-03-08"), []);
});
