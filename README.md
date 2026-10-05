# trace-coverage

In-memory traceability coverage analysis for frozen project baselines
(安全关键系统的追溯覆盖分析). Pure TypeScript library: the caller freezes a
baseline, passes it in, and calls the analyzer directly. No service layer,
no persistence, no mutation during analysis.

## Usage

```ts
import { createAnalyzer, ArtifactKind, TestVerdict } from "trace-coverage";

const analyzer = createAnalyzer({
  requirements: [{ id: "R1", kind: ArtifactKind.Requirement }],
  designItems: [{ id: "D1", kind: ArtifactKind.DesignItem }],
  testCases: [{ id: "T1", kind: ArtifactKind.TestCase, verdict: TestVerdict.Passed }],
  links: [{ from: "R1", to: "D1" }, { from: "D1", to: "T1" }],
});

analyzer.coverageFor("R1");  // per-requirement coverage
analyzer.allCoverage();      // coverage for every requirement
analyzer.summary();          // whole-baseline summary
analyzer.impactOf("R1");     // downstream impact scope (start excluded)
```

## Semantics

- Links are directed downstream (`from -> to`). Requirements may point to
  sub-requirements (acyclic), design items or test cases; design items may
  point to design items (cycles allowed) or test cases; test cases are sinks.
- Duplicate links, converging (diamond) paths and paths around design cycles
  never cause double counting: each artifact is counted once per requirement.
- A requirement's pass rate divides passed tests by **all** reachable tests
  (failed and not-executed included). Only a requirement with zero reachable
  tests is a traceability gap.
- The baseline summary deduplicates tests shared between requirements and
  ignores orphan tests (traced by no requirement). It is never an average of
  per-requirement rates. Ratios are `null` (no data) when the denominator
  is zero.
- Impact queries follow links only in their given direction; reverse-only
  connections are never traversed.

## Implementation

The trace graph is condensed into a DAG (Tarjan SCC over design items;
sub-requirement links are already acyclic). Each component's reachable-test
set is computed once as a bitset union of its children's sets, so highly
shared subgraphs are processed exactly once and overlaps are impossible to
double count. Impact queries use iterative BFS over the same directed
adjacency, guaranteeing identical semantics.

## Performance

Validated by `test/scale.test.ts` at the full required scale
(20000 requirements / 40000 design items / 10000 test cases / ~132k links,
including a 20000-long design chain, a 10000-node design cycle and a hub
where every requirement reaches 9800 tests): analysis completes in well
under 1 s (budget: 20 s) with an RSS delta of ~150 MiB (budget: 384 MiB).
The test prints the measured time and memory on every run.

## Development

Requires Node.js >= 22 (test runner glob support). No runtime dependencies.

```
npm install
npm test        # compiles src + tests, runs the node:test suite
npm run build   # emits dist/ (library only)
```
