import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RetainEdgePreview } from '../src/engine';
import { DEFAULT_BASE_RULE } from '../src/rules';
import type {
  CandidateRule,
  MigrationDirection,
  ParamKey,
  PreviewResult,
  StudentInput,
  Tier,
} from '../src/types';
import { TIERS } from '../src/types';
import {
  makeRng,
  naiveExplanations,
  randomCandidate,
  randomStudents,
  resolveForTest,
  scoreOf,
  tierOf,
} from './helpers';

/** Naive per-student preview, straight from the spec. */
function naivePreview(
  students: StudentInput[],
  candidate: CandidateRule,
): { migration: Record<Tier, Record<Tier, number>>; explanations: Map<string, Map<string, number>> } {
  const resolved = resolveForTest(DEFAULT_BASE_RULE, candidate);
  const migration = {
    low: { low: 0, mid: 0, high: 0 },
    mid: { low: 0, mid: 0, high: 0 },
    high: { low: 0, mid: 0, high: 0 },
  } as Record<Tier, Record<Tier, number>>;
  const explanations = new Map<string, Map<string, number>>();
  for (const student of students) {
    const baseTier = tierOf(scoreOf(student.indicators, DEFAULT_BASE_RULE), DEFAULT_BASE_RULE);
    const candidateTier = tierOf(scoreOf(student.indicators, resolved), resolved);
    migration[baseTier][candidateTier]++;
    if (baseTier === candidateTier) continue;
    const direction = `${baseTier}->${candidateTier}`;
    let directionMap = explanations.get(direction);
    if (!directionMap) {
      directionMap = new Map();
      explanations.set(direction, directionMap);
    }
    for (const params of naiveExplanations(student.indicators, DEFAULT_BASE_RULE, resolved)) {
      const key = [...params].sort().join('|');
      directionMap.set(key, (directionMap.get(key) ?? 0) + 1);
    }
  }
  return { migration, explanations };
}

function assertPreviewMatchesNaive(
  actual: PreviewResult,
  naive: ReturnType<typeof naivePreview>,
): void {
  for (const from of TIERS) {
    for (const to of TIERS) {
      assert.equal(
        actual.migration[from][to],
        naive.migration[from][to],
        `migration ${from}->${to}`,
      );
    }
  }
  const actualDirections = Object.keys(actual.explanations).sort();
  const naiveDirections = [...naive.explanations.keys()].sort();
  assert.deepEqual(actualDirections, naiveDirections);
  for (const direction of naiveDirections) {
    const actualEntries = new Map(
      (actual.explanations[direction as MigrationDirection] ?? []).map(
        (entry: { params: ParamKey[]; count: number }) => [
          [...entry.params].sort().join('|'),
          entry.count,
        ],
      ),
    );
    assert.deepEqual(actualEntries, naive.explanations.get(direction), `direction ${direction}`);
  }
}

test('preview matches naive per-student recompute on random data', () => {
  const rng = makeRng(42);
  const students = randomStudents(5000, rng);
  const engine = new RetainEdgePreview(students);
  assert.equal(engine.size, 5000);
  for (let trial = 0; trial < 50; trial++) {
    const candidate = randomCandidate(rng, DEFAULT_BASE_RULE, 0.7);
    const actual = engine.preview(candidate);
    assert.equal(actual.totalStudents, 5000);
    let total = 0;
    for (const from of TIERS) for (const to of TIERS) total += actual.migration[from][to];
    assert.equal(total, 5000, 'migration matrix must account for every student');
    assertPreviewMatchesNaive(actual, naivePreview(students, candidate));
  }
});

test('explanation counts may exceed migration counts (students with multiple explanations)', () => {
  // First three indicators hit: base 60 (mid); candidate weights 40/25/20
  // move them to high with two explanations each.
  const students: StudentInput[] = [
    {
      id: 'A',
      indicators: {
        gpaBelow2: true,
        attendanceBelow75: true,
        aidIncomplete: true,
        undeclaredOver30Credits: false,
        withdrew2Plus: false,
        firstGeneration: false,
      },
    },
  ];
  const engine = new RetainEdgePreview(students);
  const result = engine.preview({
    weights: { gpaBelow2: 40, attendanceBelow75: 25, aidIncomplete: 20 },
  });
  assert.equal(result.migration.mid.high, 1);
  const entries = result.explanations['mid->high'] ?? [];
  const explanationTotal = entries.reduce((sum, entry) => sum + entry.count, 0);
  assert.equal(entries.length, 2);
  assert.equal(explanationTotal, 2, 'one student, two explanations');
});

test('previewStudent reports before/after score, tier and explanations', () => {
  const students: StudentInput[] = [
    {
      id: 'A',
      indicators: {
        gpaBelow2: true,
        attendanceBelow75: true,
        aidIncomplete: true,
        undeclaredOver30Credits: false,
        withdrew2Plus: false,
        firstGeneration: false,
      },
    },
  ];
  const engine = new RetainEdgePreview(students);
  const candidate: CandidateRule = {
    weights: { gpaBelow2: 40, attendanceBelow75: 25, aidIncomplete: 20 },
  };
  const preview = engine.previewStudent('A', candidate);
  assert.equal(preview.baseScore, 60);
  assert.equal(preview.baseTier, 'mid');
  assert.equal(preview.candidateScore, 85);
  assert.equal(preview.candidateTier, 'high');
  assert.equal(preview.changed, true);
  assert.deepEqual(
    preview.explanations.map((params) => [...params].sort()),
    [['weight:gpaBelow2'], ['weight:aidIncomplete', 'weight:attendanceBelow75']].map((e) =>
      [...e].sort(),
    ),
  );

  const unchanged = engine.previewStudent('A', {});
  assert.equal(unchanged.changed, false);
  assert.deepEqual(unchanged.explanations, []);

  assert.throws(() => engine.previewStudent('NOPE', candidate), /unknown student id/);
});

test('previews are independent: repeated and interleaved previews do not pollute state', () => {
  const rng = makeRng(7);
  const students = randomStudents(2000, rng);
  const engine = new RetainEdgePreview(students);
  const candidateA = randomCandidate(rng, DEFAULT_BASE_RULE, 0.9);
  const candidateB = randomCandidate(rng, DEFAULT_BASE_RULE, 0.9);

  const first = engine.preview(candidateA);
  engine.preview(candidateB);
  engine.preview({ midThreshold: 80, highThreshold: 90 });
  const again = engine.preview(candidateA);
  assert.deepEqual(again, first);

  // Base rule is untouched.
  assert.deepEqual(engine.getBaseRule(), DEFAULT_BASE_RULE);
  // An empty candidate still yields the pure base distribution.
  const identity = engine.preview({});
  assert.equal(identity.migration.low.mid + identity.migration.low.high, 0);
  assert.equal(identity.migration.mid.low + identity.migration.mid.high, 0);
  assert.equal(identity.migration.high.low + identity.migration.high.mid, 0);
  assert.deepEqual(identity.explanations, {});
});

test('mutating the returned rule or the input candidate does not affect later previews', () => {
  const rng = makeRng(99);
  const engine = new RetainEdgePreview(randomStudents(500, rng));
  const candidate: CandidateRule = { weights: { gpaBelow2: 90 }, midThreshold: 10 };
  const before = engine.preview(candidate);
  before.resolvedRule.weights.gpaBelow2 = 1;
  before.resolvedRule.midThreshold = 99;
  candidate.weights = { gpaBelow2: 3 };
  candidate.midThreshold = 55;
  const after = engine.preview({ weights: { gpaBelow2: 90 }, midThreshold: 10 });
  assert.deepEqual(after.migration, before.migration);
  assert.deepEqual(engine.getBaseRule(), DEFAULT_BASE_RULE);
});

test('constructor rejects duplicate ids and bad input', () => {
  const indicators = {
    gpaBelow2: false,
    attendanceBelow75: false,
    aidIncomplete: false,
    undeclaredOver30Credits: false,
    withdrew2Plus: false,
    firstGeneration: false,
  };
  assert.throws(
    () =>
      new RetainEdgePreview([
        { id: 'A', indicators },
        { id: 'A', indicators },
      ]),
    /duplicate student id/,
  );
  assert.throws(
    () => new RetainEdgePreview([{ id: '', indicators }]),
    /non-empty string/,
  );
  assert.throws(
    () => new RetainEdgePreview([], { ...DEFAULT_BASE_RULE, midThreshold: 70, highThreshold: 70 }),
    RangeError,
  );
});

test('preview rejects invalid candidates', () => {
  const engine = new RetainEdgePreview(randomStudents(10, makeRng(1)));
  assert.throws(() => engine.preview({ midThreshold: 80 }), RangeError);
  assert.throws(() => engine.preview({ weights: { gpaBelow2: 1.5 } }), RangeError);
  assert.throws(() => engine.preview({ weights: { gpaBelow2: 101 } }), RangeError);
  assert.throws(() => engine.preview({ highThreshold: 0 }), RangeError);
});
