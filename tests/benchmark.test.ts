import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { RetainEdgePreview } from '../src/engine';
import { DEFAULT_BASE_RULE } from '../src/rules';
import type { CandidateRule, StudentInput, Tier } from '../src/types';
import { TIERS } from '../src/types';
import { makeRng, randomCandidate, randomIndicators, resolveForTest, scoreOf, tierOf } from './helpers';

const STUDENT_COUNT = 1_000_000;
const CANDIDATE_COUNT = 1000;
const PREVIEW_BUDGET_MS = 10_000;

function* generateStudents(count: number, rng: () => number): Iterable<StudentInput> {
  for (let i = 0; i < count; i++) {
    yield { id: `S${i}`, indicators: randomIndicators(rng) };
  }
}

test(
  `benchmark: ${STUDENT_COUNT} students x ${CANDIDATE_COUNT} candidate previews within ${PREVIEW_BUDGET_MS}ms`,
  { timeout: 300_000 },
  () => {
    const rng = makeRng(0xc0ffee);

    // Load (excluded from the timing budget per spec).
    const loadStart = performance.now();
    const engine = new RetainEdgePreview(generateStudents(STUDENT_COUNT, rng));
    const loadMs = performance.now() - loadStart;
    assert.equal(engine.size, STUDENT_COUNT);

    // Keep the indicator masks for the naive full recompute cross-check.
    const masksRng = makeRng(0xc0ffee);
    const masks = new Uint8Array(STUDENT_COUNT);
    for (let i = 0; i < STUDENT_COUNT; i++) {
      const indicators = randomIndicators(masksRng);
      let mask = 0;
      const keys = Object.keys(indicators) as (keyof typeof indicators)[];
      keys.forEach((key, bit) => {
        if (indicators[key]) mask |= 1 << bit;
      });
      masks[i] = mask;
    }

    // 1000 distinct valid candidates.
    const candidateRng = makeRng(1234);
    const seen = new Set<string>();
    const candidates: CandidateRule[] = [];
    while (candidates.length < CANDIDATE_COUNT) {
      const candidate = randomCandidate(candidateRng, DEFAULT_BASE_RULE, 0.5);
      const key = JSON.stringify(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(candidate);
    }

    // Timed section: 1000 full previews, each including explanation stats.
    const previewStart = performance.now();
    const results = candidates.map((candidate) => engine.preview(candidate));
    const previewMs = performance.now() - previewStart;

    console.log(
      `[benchmark] load=${loadMs.toFixed(0)}ms (excluded) | ` +
        `${CANDIDATE_COUNT} previews over ${STUDENT_COUNT} students: ` +
        `${previewMs.toFixed(0)}ms total, ${(previewMs / CANDIDATE_COUNT).toFixed(2)}ms/preview`,
    );
    assert.ok(
      previewMs <= PREVIEW_BUDGET_MS,
      `previews took ${previewMs.toFixed(0)}ms, budget is ${PREVIEW_BUDGET_MS}ms`,
    );

    // Every preview must include explanation statistics for changed directions.
    for (const result of results) {
      for (const from of TIERS) {
        for (const to of TIERS) {
          if (from === to) continue;
          const moved = result.migration[from][to];
          const direction = `${from}->${to}` as const;
          const entries = result.explanations[direction] ?? [];
          if (moved === 0) {
            assert.equal(entries.length, 0, `${direction}: no movers, no explanations`);
          } else {
            assert.ok(entries.length > 0, `${direction}: ${moved} movers but no explanations`);
            const explanationTotal = entries.reduce((sum, entry) => sum + entry.count, 0);
            assert.ok(
              explanationTotal >= moved,
              `${direction}: explanation count ${explanationTotal} < movers ${moved}`,
            );
          }
        }
      }
    }

    // Migration counts must match a naive per-student recompute over all 1M
    // students, for a sample of candidates.
    const compiledBase = DEFAULT_BASE_RULE;
    for (const index of [0, CANDIDATE_COUNT >> 1, CANDIDATE_COUNT - 1]) {
      const resolved = resolveForTest(compiledBase, candidates[index]!);
      const naiveMigration: Record<Tier, Record<Tier, number>> = {
        low: { low: 0, mid: 0, high: 0 },
        mid: { low: 0, mid: 0, high: 0 },
        high: { low: 0, mid: 0, high: 0 },
      };
      for (let i = 0; i < STUDENT_COUNT; i++) {
        const mask = masks[i]!;
        const indicators = {
          gpaBelow2: Boolean(mask & 1),
          attendanceBelow75: Boolean(mask & 2),
          aidIncomplete: Boolean(mask & 4),
          undeclaredOver30Credits: Boolean(mask & 8),
          withdrew2Plus: Boolean(mask & 16),
          firstGeneration: Boolean(mask & 32),
        };
        const baseTier = tierOf(scoreOf(indicators, compiledBase), compiledBase);
        const candidateTier = tierOf(scoreOf(indicators, resolved), resolved);
        naiveMigration[baseTier][candidateTier]++;
      }
      for (const from of TIERS) {
        for (const to of TIERS) {
          assert.equal(
            results[index]!.migration[from][to],
            naiveMigration[from][to],
            `candidate #${index} ${from}->${to}`,
          );
        }
      }
    }
  },
);
