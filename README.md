# review-panel-planner

Batch judge assignment for creative review panels (normal reviews and
appeals), with global optimality guarantees and verifiable infeasibility
certificates.

## Usage

```ts
import { plan, verify } from "review-panel-planner";

const result = plan(input); // { judges, tasks, projects }
if (result.ok) {
  // result.assignments: taskId -> full panel (locked + assigned)
  // result.objectives: { load, unmetPreferences }
} else {
  // result.deficiency: { taskIds, demand, supply } -- Hall-style certificate
}
const report = verify(input, result); // independent re-check
```

## Rules

- A project's creator and stakeholders may never review it; appeal tasks
  additionally exclude judges from **all** historical rounds of the project.
- Locked (task, judge) pairs are kept as-is and consume judge capacity.
- Preferences are soft: they never override the load objective.

## Optimality

`plan` returns a globally optimal assignment: it first minimizes the sum of
squared final loads (`baseLoad` + batch assignments, locks included), then
minimizes the number of unused preferred pairs among all load-optimal
solutions. This is solved exactly as a single min-cost flow (convex load
costs via unit-capacity expansion, lexicographic objectives via cost
scaling) — no enumeration of assignments, no heuristics.

When infeasible, `plan` returns a deficiency certificate: a non-empty task
set `S` whose remaining slot demand (after deducting locks) strictly exceeds
every judge's total possible contribution to `S` (min of remaining capacity
and the number of tasks in `S` the judge can still legally serve). `verify`
recomputes both sides and confirms the inequality.

## Develop

```sh
npm install
npm test   # build + typecheck + unit/deficiency/scale tests
npm run build
```
