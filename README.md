# flow-readiness-checker

Publish-time data-readiness checker for workflow definitions, called directly
by the designer. Flow definitions and analysis results live in memory only.

## Model

- A flow is a validated DAG of at most 200 nodes: one `entry`, plus
  `condition` (two outgoing edges: true/false), `action` (one outgoing edge)
  and `end` (no outgoing edge) nodes. Each execution follows a single path;
  merges never imply parallel joins.
- At most 40 boolean switches are supplied once before execution and never
  change. A condition node tests exactly one switch.
- At most 40 business fields, all absent at start. An action declares
  `requires` and `produces`. If any required field is absent, execution fails
  immediately at that action (all missing fields are recorded, nothing is
  produced); otherwise its produced fields exist from then on.

## API

```ts
import { analyzeFlow, replayFlow } from 'flow-readiness-checker';

const result = analyzeFlow(flow);
// result.safe === true            -> every switch input reaches an end node
// result.reports: Array<{
//   nodeId, field,                -> a reachable first-failure combination
//   witness: boolean[],           -> complete switch input that provably
// }                                  triggers exactly this first failure

const replay = replayFlow(flow, [true, false, /* ... */]);
// { ok: true,  path }                        -> reached an end node
// { ok: false, path, failedNode, missingFields } -> first failure
```

`analyzeFlow` returns a (node, field) combination iff some switch input makes
the execution fail there first with that field missing. Multiple fields
missing at the same action are reported as separate combinations. Missing
fields that could only occur after an earlier failure are not reported.

## How it works

The analysis is a symbolic exploration over all `2^switches` inputs at once.
Per node it keeps two exact BDDs (`src/bdd.ts`) over the switch variables:
the inputs that reach the node without an earlier failure, and — per field —
the inputs on which the field exists on arrival. Propagation follows the DAG
in topological order; action successors only receive contributions gated by
the action's success condition, so states from different paths are never
merged into an execution that cannot happen. A report's witness is one
satisfying assignment of `reach(node) AND NOT present(node, field)`.

This keeps the 40-switch / 162-node pipeline scenario (over 2^80 paths) at
single-digit milliseconds and a few hundred KB of BDD nodes.

`replayFlow` is an independent plain interpreter and never consumes analysis
results.

## Develop

```sh
npm install   # only devDependency: typescript
npm test      # compiles src+test, runs node:test suites
npm run build # emits dist/ (library entry: dist/index.js)
```

Tests (`test/`):

- `scenarios.test.ts` — repeated-condition protection, divergent branch
  production used after a merge, and earlier-failure shadowing.
- `crosscheck.test.ts` — randomized flows: the report set equals the
  brute-force set of first failures over all inputs, and every witness
  reproduces its first failure.
- `scale.test.ts` — the 40-switch, 162-node pipeline: safe version reports
  nothing; one-mismatch version reports exactly `(u20, F20)`; both well
  within 10 s and 256 MiB.
- `bdd.test.ts` — BDD operations against truth-table evaluation.
