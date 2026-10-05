# traceability-coverage

In-memory traceability coverage analysis over a frozen project baseline,
for safety-critical audits: which requirements are covered by tests, and
which downstream artifacts a requirement change impacts.

## Model

A `Baseline` holds requirements, design items, test cases and directed
`TraceLink`s (`fromId` -> `toId`). Requirements may link to
sub-requirements, design items or test cases; design items may link to
design items or test cases (cycles allowed); test cases have no outgoing
links. Link direction defines downstream impact — bidirectional UI
navigation does not. Duplicate links, converging paths and cycles never
double-count an artifact.

## API

```js
const { createAnalyzer, analyzeBaseline, queryImpact } = require("traceability-coverage");

const analyzer = createAnalyzer(baseline); // frozen, in-memory
const { requirements, summary } = analyzer.analyze();
const impact = analyzer.queryImpact("REQ-1");
```

- `analyze()` — per-requirement reachable/passed test counts and pass
  rate (denominator includes failed and not-executed tests; `null` when
  a requirement has no reachable tests, which is the only traceability
  gap), plus a baseline summary: ratio of requirements with tests, and
  the pass rate over the deduplicated union of traced tests (orphan
  tests excluded; `null` when the denominator is zero).
- `queryImpact(requirementId)` — all downstream sub-requirements, design
  items and test cases, each once, excluding the start requirement;
  never follows links backwards.

## Performance

Sized for 20k requirements / 40k design items / 10k test cases / 300k
links. Reachability is computed over the SCC condensation of the
requirement/design graph with bitset propagation, so highly shared
graphs, 20k-deep chains and 15k-node cycles complete in well under the
20 s / 384 MiB budget (measured ~0.2 s, ~170 MiB rss including the
baseline itself).

## Develop

```sh
npm install
npm test   # builds src/ with tsc, then runs node:test suites in test/
```
