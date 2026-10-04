# MindForge Canvas Outline

Export a MindForge Canvas concept graph to a hierarchical Markdown outline,
entirely in memory. Built for consulting teams that turn canvas concept
relations into report outlines.

## Install & test

```sh
npm install
npm test
```

Requires only Node.js (>= 18). The single dev dependency is TypeScript.

## Usage

```ts
import { exportOutline } from "mindforge-canvas-outline";

const result = exportOutline({
  nodes: [
    { id: 1, title: "Root cause", x: 0, y: 0 },
    { id: 2, title: "Factor A", x: 2, y: 1 },
    { id: 3, title: "Shared effect", x: 3, y: 2 },
  ],
  edges: [
    { from: 1, to: 2 },
    { from: 2, to: 3 },
    { from: 3, to: 1 },
  ],
});

console.log(result.markdown);
// - Root cause (#1)
//   - Factor A (#2)
//     - Shared effect (#3)
//       - → Root cause (#1)
```

## Model

- Input: a directed graph (`CanvasGraph`) with unique positive integer node
  ids, string titles, integer coordinates, and at most one edge per ordered
  node pair. Cycles, self-loops and isolated nodes are allowed. The graph is
  not mutated.
- Every node appears exactly once as a **full entry**, either at the top
  level or under a single parent. A parent link always follows an original
  edge and the hierarchy is acyclic.
- Every original edge that is not a parent link is kept as a **reference
  entry** under its source node (`- → Title (#id)`), identifying the target
  id without expanding it. Each edge becomes exactly one parent link or one
  reference — none added, none lost.

## Optimality

Among all legal hierarchies the export picks, in order:

1. the fewest top-level full entries;
2. the smallest total spatial cost of parent links
   (`|Δx| + |Δy|` per link; references are free);
3. the numerically smallest parent-id sequence (nodes ordered by ascending
   id, top-level nodes recorded as `0`).

The three objectives are packed into a single `bigint` weight per edge and
solved exactly with Edmonds' maximum branching algorithm
(`src/branching.ts`), so the result is a provable global optimum, not a
greedy approximation. The optimum is unique because the parent-id sequence
fully determines the hierarchy, and the output is independent of the input
array ordering — same graph, byte-identical Markdown.

## Result shape

```ts
interface OutlineResult {
  roots: OutlineEntry[];              // top-level full entries (id ascending)
  parents: ReadonlyMap<number, number>; // nodeId -> parentId (0 = top level)
  totalCost: number;                  // total spatial cost of parent links
  markdown: string;                   // nested list, ends with "\n"
}
```

`OutlineEntry` carries `nodeId`, `title`, `parentId`, `children`
(id ascending) and `references` (target id ascending), so callers can
inspect or re-render the hierarchy themselves.

## Development

- `npm run build` — compile `src/` to `dist/` with `tsc`.
- `npm test` — build, then run the Node.js test runner suites in `test/`:
  global-optimum cross-checks against an independent brute-force solver,
  node/edge-set reconstruction, determinism under input shuffling, input
  validation, and a randomized fuzz comparison.
