# review-panel-planner

Batch judge assignment for creative review. Given a snapshot of judges,
review tasks and project history, `plan` produces complete review panels
that are globally optimal, or a checkable deficiency certificate explaining
why no complete assignment exists. `verify` independently re-checks any
result. Inputs are immutable for the duration of a call.

## Usage

```ts
import { plan, verify, type PlanInput } from "review-panel-planner";

const result = plan(input);
if (result.ok) {
  // result.assignments: taskId -> complete panel (locked judges included)
  // result.objectives: { loadSquares, unadoptedPreferences }
} else {
  // result.deficiency.taskIds: witness set of tasks that cannot be staffed
}
const valid = verify(input, result);
```

## Model

- Each judge has `baseLoad` and a batch `capacity` (0..20). Final load is
  `baseLoad` plus batch assignments, locked pairs included.
- Each task needs 1..5 distinct judges and may declare locked judges
  (assumed eligible and within limits) and preferred judges (soft objective).
- Creators and stakeholders may never review their own project. Appeal
  tasks additionally exclude every judge from all historical rounds of the
  project; normal tasks may reuse historical judges.

## Optimality

Feasible results are globally optimal in lexicographic order:

1. minimize the sum of squared final loads over all judges;
2. among those, minimize the number of unadopted preferred (task, judge)
   pairs.

The planner solves a single convex min-cost flow (successive shortest
paths): judge-to-sink arcs carry the marginal squared-load costs, and
non-preferred candidate edges carry a unit cost scaled below the load
granularity, so no enumeration of assignments is needed.

## Deficiency evidence

When infeasible, `plan` returns a non-empty task set `S` (the min-cut
witness). After deducting all locked occupancy, the remaining slots of `S`
strictly exceed the sum over judges of `min(remaining capacity, tasks in S
still open to that judge)`. `verify` recomputes this inequality from the
input; it never trusts a success flag and never accepts "search failed".

## Development

```sh
npm install
npm test
```

Tests cover an exhaustive small-scale reference (including appeal history
across rounds, lock/capacity interaction and load-vs-preference conflicts),
tamper-resistant deficiency certificates, and a full-scale instance
(300 tasks, 200 judges, 1200 slots, <60k candidate pairs) that plans in
well under 30 seconds and is invariant under input reordering.
