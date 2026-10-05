# board-meeting-scheduler

In-process TypeScript library that finds candidate start minutes for board
meetings across time zones, with correct DST handling and whole-meeting
quorum semantics. No service layer, no persistence: the roster, weekly
availability and query results all live in process memory.

## Requirements

Node.js 18+ (uses `Intl` and `node:test`). No runtime dependencies.

```sh
npm install
npm test        # builds with tsc, then runs the test suite
npm run build   # emit dist/ only
```

## API

```ts
import { BoardScheduler } from "./src/index.js";

const scheduler = new BoardScheduler();

// Replace the serving-director roster (id + IANA time zone per director).
scheduler.setRoster([
  { id: "alice", timeZone: "America/New_York" },
  { id: "bob", timeZone: "Australia/Lord_Howe" },
]);

// Replace one director's weekly availability. Windows are local wall-clock,
// half-open, and repeat on the director's local calendar (never on a fixed
// UTC offset). endMinute < startMinute ends the window the next day;
// windows may cross weeks, overlap, or touch.
scheduler.setWeeklyAvailability("alice", [
  { startDay: 0, startMinute: 90, endMinute: 150 }, // Sunday 01:30-02:30 local
]);

// Query candidate start minutes.
const runs = scheduler.findCandidates({
  rangeStartMs: Date.parse("2024-11-03T00:00:00Z"), // inclusive, minute-aligned
  rangeEndMs: Date.parse("2024-11-04T00:00:00Z"),   // exclusive, minute-aligned
  durationMinutes: 45,                              // real elapsed minutes
  inviteeIds: ["alice", "bob"],                     // optional; default: all
  quorumPercent: 60,                                // optional; default: 60
});
// => [{ firstStartMs, lastStartMs }, ...] maximal runs of consecutive valid
//    start minutes; both bounds are themselves valid starts. Empty if none.
```

## Semantics

- **Quorum** is `ceil(rosterSize * quorumPercent / 100)`. Uninvited or
  unavailable serving directors still count in the denominator; only invited
  directors can count as attendees.
- A director counts only if available for **every** real minute of the
  meeting; rotating attendance does not qualify. Each director's windows are
  merged before counting, so overlapping windows never double-count.
- DST: availability follows the local wall clock. Spring-forward gaps remove
  local times; fall-back folds evaluate each occurrence separately. Zone
  shifts need not be whole hours (e.g. Australia/Lord_Howe shifts 30 min).
- Meetings and the search range are half-open UTC intervals; candidate
  starts fall on whole UTC minutes and the meeting must fit inside the
  range. Adjacent qualifying minutes merge into one run even when the
  attending set changes.

Supported date range: 2020-2035. Calls are serial; mutate configuration
only between queries.
