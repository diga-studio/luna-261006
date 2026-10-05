# rule-graph

In-memory online modification library for a rule dependency graph.
`A depends on B` means `B` must execute before `A`. The rule id set is
fixed at creation; only cross-rule references change. No condition
evaluation, no action execution, no persistence.

## API

```ts
import { createGraph } from './src/index.ts';

const g = createGraph([
  { id: 'a', dependsOn: ['b'] },
  { id: 'b', dependsOn: [] },
]);

const result = g.applyBatch({
  remove: [{ from: 'a', to: 'b' }],
  add: [{ from: 'b', to: 'a' }],
});
// result.ok === true, or result.ok === false with result.cycle:
// a closed rule-id sequence where every adjacent pair is a reference
// in the rejected batch's final candidate graph.
// Every call also returns result.stats (per-commit access statistics).

const { refs, order } = g.snapshot();
// refs: every current reference; order: an execution order where each
// reference's `to` precedes its `from`.
```

- `applyBatch` is atomic: removals apply before additions; the batch is
  accepted iff the final graph is acyclic. On rejection the graph and the
  execution order are exactly as before the call (undo log rollback).
- Cycle detection is finished before `applyBatch` returns; the witness
  never contains removed references.
- Incremental work only: edge insertions use the Pearce–Kelly dynamic
  topological sort, touching just the affected region of the order —
  local edits never traverse or copy the whole graph.
- `stats` counts every read/write of rule records, reference records and
  order slots (including reorder and rollback work, excluding `snapshot`).

## Requirements & scripts

Node.js >= 22.18 (native TypeScript type stripping; no build step needed).

```sh
npm install   # installs typescript (dev only, for typechecking)
npm test      # tsc --noEmit && node --test "test/*.test.ts"
```

## Layout

- `src/types.ts` — public types (`Rule`, `Ref`, `Batch`, `CommitStats`, ...).
- `src/graph.ts` — `IncrementalGraph`: adjacency maps, Kahn's algorithm at
  construction, Pearce–Kelly incremental reordering, cycle witness
  reconstruction, undo-log rollback, access accounting.
- `test/` — scenario tests (batch reversal, joint cycles, witness checks,
  rejection integrity), a randomized differential test against a naive
  oracle, and scale tests (100k-node chain with 20k commits; a 32-node
  component beside a 100k-node background graph with per-commit access
  limits).
