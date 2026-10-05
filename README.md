# activity-matcher

In-process TypeScript library for scheduling multi-round 1:1 interest-based
networking at events. No I/O, no services: all state lives in process memory
and the host program calls the library directly.

## Model

- An event has a fixed roster of participants, each with a set of interest
  tags, and at most 12 rounds of 1:1 meetings.
- Each round has its own attendance list; participants may miss any rounds.
- Two people can be paired only if they share at least one tag and have not
  met before in this event. There are no two-sided groups.
- Each attendee joins at most one pair per round. Attendees left without a
  pair get a *bye*; absent participants do not.

Each round is planned greedily with three lexicographic objectives
(later objectives never compensate earlier ones):

1. maximize the number of pairs;
2. minimize the sum of squared cumulative bye counts (fairness);
3. maximize the total number of common tags over all pairs.

Rounds are planned in order; confirmed rounds and earlier tentative rounds
count as history for repetition and bye tracking. Only **confirmed** rounds
are official history: generating a schedule is tentative and repeatable,
and re-planning discards all unconfirmed results before rescheduling the
remaining rounds against the new attendance lists.

## Usage

```ts
import { ActivityEvent } from "activity-matcher";

const ev = new ActivityEvent(
  [
    { id: "alice", tags: ["go", "chess"] },
    { id: "bob", tags: ["go", "hiking"] },
    { id: "carol", tags: ["chess"] },
  ],
  4, // rounds (1..12)
);

// attendance: one entry per round (0-based); entries for confirmed
// rounds are ignored. Omit to assume everyone attends every round.
const plan = ev.generateSchedule([
  ["alice", "bob", "carol"],
  ["alice", "bob"],
  ["alice", "bob", "carol"],
  ["alice", "carol"],
]);
// plan: RoundResult[] = [{ round, pairs: [{a, b, commonTags}], byes }]

const round0 = ev.confirmNextRound(); // make round 0 official history

// attendance changed for a future round -> re-plan all unconfirmed rounds
const newPlan = ev.updateAttendance(2, ["alice", "bob"]);

ev.getSchedule();        // current tentative plan (unconfirmed rounds)
ev.getConfirmedRounds(); // official history
ev.getByeCounts();       // cumulative byes from confirmed rounds only
```

All returned values are snapshots; mutating them does not affect the event.

## Implementation notes

- `src/matching.ts`: maximum weight matching in general graphs (Edmonds'
  blossom, primal-dual, O(n^3)) over typed arrays.
- `src/scheduler.ts`: encodes the three lexicographic objectives into one
  integer edge weight (`CARD_MULT + NODE_MULT * (wu + wv) + commonTags`,
  with multipliers chosen so higher objectives always dominate) and tags as
  64-bit masks, so common-tag count is a popcount.
- `src/event.ts`: roster/attendance state, confirmed history, tentative
  re-planning.

Scale: 300 participants, 64 tags, 12 rounds. A full 12-round (re)plan takes
well under 15 s (≈0.6 s dense, ≈0.05 s sparse on a laptop) and a few MiB of
working memory.

## Develop

```sh
npm install   # only fetches typescript (devDependency)
npm test      # tsc + node --test
```

Tests include brute-force verification of the per-round objectives on small
graphs, confirm/re-plan scenarios, and 300x64x12 scale tests for dense and
sparse interest distributions.
