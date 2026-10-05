# HireCircle Local

Static in-memory candidate search library. Exposes two operations:

- `buildIndex(candidates)` — builds a query-independent inverted index over
  candidate tags and per-version skills. Contains no query state, so one
  index serves arbitrary weights and experience targets.
- `search(index, query, options?)` — exact top-k candidate ranking.

## Model

Each candidate has an id, a tag set, and 1–3 resume versions. A version has
a version id, a skill set, and integer experience months. Tags belong to the
candidate; skills and experience belong to the version.

A query carries:

- `filter`: an AND/OR/NOT tree whose leaves are exact tag/skill containment.
  Only versions passing the whole filter may rank — qualifications are never
  assembled across versions.
- `scoring`: up to 12 weighted leaves (integer weights 1–100) using the same
  match semantics; they need not appear in the filter.
- `experienceTargetMonths`: versions earn `max(0, 60 - |actual - target|)`.
- `k`: number of candidates to return.

A version's score is the sum of hit scoring weights plus the experience
bonus. A candidate's score is its best qualifying version's score; the
witness version breaks ties by smallest version id. Results are sorted by
score descending, then candidate id ascending, with no duplicate candidates.

## Exactness and scoring work

`search` never scores the full matching version set. Filters evaluate as set
algebra over posting lists; ranking uses WAND with a dynamic threshold (and
a distance-ordered scan for scoring-free queries), so only versions that can
still reach the running k-th best score are fully evaluated. The result is
still exact.

`SearchOutput.scoredVersions` counts every distinct resume version that
underwent query-dependent scoring (weighted contribution, experience
distance, or per-version upper bound) during the call — including query
preparation, dedup, and explanation phases. `SearchOptions.onVersionScored`
is an injectable observer invoked once per scored version so tests can
cross-check the statistic independently.

## Develop

```sh
npm install
npm test
```

Tests: randomized small-scale comparison against a brute-force oracle
(including split-qualification and tie cases), plus a fixed-seed 50k
candidate / 150k version benchmark asserting exact top-20 results and
`scoredVersions <= 2000` across 5 different queries on one index.
