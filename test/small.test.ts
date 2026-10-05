import assert from 'node:assert/strict';
import test from 'node:test';
import { buildIndex, search } from '../src/index.js';
import type { CandidateInput, FilterNode, Query, ScoringLeaf } from '../src/index.js';
import { oracleSearch } from './oracle.js';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomCandidates(rand: () => number, count: number): CandidateInput[] {
  const tags = ['ta', 'tb', 'tc', 'td'];
  const skills = ['sa', 'sb', 'sc', 'sd', 'se', 'sf'];
  const candidates: CandidateInput[] = [];
  for (let i = 0; i < count; i += 1) {
    const myTags = tags.filter(() => rand() < 0.4);
    const versionCount = 1 + Math.floor(rand() * 3);
    const resumes = [];
    for (let v = 0; v < versionCount; v += 1) {
      resumes.push({
        id: `v${Math.floor(rand() * 3)}${v}`,
        skills: skills.filter(() => rand() < 0.4),
        experienceMonths: Math.floor(rand() * 121),
      });
    }
    candidates.push({ id: `c${String(i).padStart(3, '0')}`, tags: myTags, resumes });
  }
  return candidates;
}

function randomFilter(rand: () => number, depth: number): FilterNode {
  const leaf = (): FilterNode => ({
    op: 'leaf',
    leaf:
      rand() < 0.5
        ? { kind: 'tag', value: `t${'abcd'[Math.floor(rand() * 4)]}` }
        : { kind: 'skill', value: `s${'abcdef'[Math.floor(rand() * 6)]}` },
  });
  if (depth === 0 || rand() < 0.45) {
    return leaf();
  }
  const kind = rand();
  if (kind < 0.34) {
    return { op: 'not', child: randomFilter(rand, depth - 1) };
  }
  const arity = 2 + Math.floor(rand() * 2);
  const children = Array.from({ length: arity }, () => randomFilter(rand, depth - 1));
  return kind < 0.67 ? { op: 'and', children } : { op: 'or', children };
}

function randomQuery(rand: () => number): Query {
  const scoringCount = Math.floor(rand() * 13);
  const scoring: ScoringLeaf[] = Array.from({ length: scoringCount }, () => ({
    leaf:
      rand() < 0.3
        ? { kind: 'tag', value: `t${'abcd'[Math.floor(rand() * 4)]}` }
        : { kind: 'skill', value: `s${'abcdef'[Math.floor(rand() * 6)]}` },
    weight: 1 + Math.floor(rand() * 100),
  }));
  return {
    filter: randomFilter(rand, 3),
    scoring,
    experienceTargetMonths: Math.floor(rand() * 121),
    k: 1 + Math.floor(rand() * 10),
  };
}

test('random small datasets match brute-force oracle', () => {
  for (let trial = 0; trial < 300; trial += 1) {
    const rand = mulberry32(trial * 7919 + 13);
    const candidates = randomCandidates(rand, 5 + Math.floor(rand() * 25));
    const index = buildIndex(candidates);
    const queryCount = 1 + Math.floor(rand() * 3);
    for (let q = 0; q < queryCount; q += 1) {
      const query = randomQuery(rand);
      let observed = 0;
      const seen = new Set<string>();
      const actual = search(index, query, {
        onVersionScored: (event) => {
          observed += 1;
          seen.add(`${event.candidateId}${event.versionId}`);
        },
      });
      const expected = oracleSearch(candidates, query);
      assert.deepEqual(
        actual.results,
        expected.results,
        `trial ${trial} query ${q}: ${JSON.stringify(query)}`,
      );
      assert.equal(actual.scoredVersions, observed, 'observer count must equal scoredVersions');
      assert.equal(seen.size, observed, 'each scored version must be reported once');
    }
  }
});

test('qualification cannot be assembled across versions', () => {
  const candidates: CandidateInput[] = [
    {
      id: 'split',
      tags: ['t'],
      resumes: [
        { id: 'va', skills: ['s1'], experienceMonths: 10 },
        { id: 'vb', skills: ['s2'], experienceMonths: 10 },
      ],
    },
    {
      id: 'whole',
      tags: ['t'],
      resumes: [{ id: 'va', skills: ['s1', 's2'], experienceMonths: 10 }],
    },
  ];
  const index = buildIndex(candidates);
  const query: Query = {
    filter: {
      op: 'and',
      children: [
        { op: 'leaf', leaf: { kind: 'skill', value: 's1' } },
        { op: 'leaf', leaf: { kind: 'skill', value: 's2' } },
      ],
    },
    scoring: [
      { leaf: { kind: 'skill', value: 's1' }, weight: 5 },
      { leaf: { kind: 'skill', value: 's2' }, weight: 7 },
    ],
    experienceTargetMonths: 10,
    k: 10,
  };
  const actual = search(index, query);
  assert.deepEqual(
    actual.results.map((r) => r.candidateId),
    ['whole'],
  );
  assert.equal(actual.results[0].score, 5 + 7 + 60);
});

test('candidate and version ties are stable', () => {
  const candidates: CandidateInput[] = [
    {
      id: 'cb',
      tags: [],
      resumes: [
        { id: 'vz', skills: ['s'], experienceMonths: 30 },
        { id: 'va', skills: ['s'], experienceMonths: 30 },
      ],
    },
    {
      id: 'ca',
      tags: [],
      resumes: [{ id: 'vm', skills: ['s'], experienceMonths: 30 }],
    },
  ];
  const index = buildIndex(candidates);
  const query: Query = {
    filter: { op: 'leaf', leaf: { kind: 'skill', value: 's' } },
    scoring: [{ leaf: { kind: 'skill', value: 's' }, weight: 10 }],
    experienceTargetMonths: 30,
    k: 2,
  };
  const actual = search(index, query);
  assert.deepEqual(
    actual.results.map((r) => [r.candidateId, r.witnessVersionId, r.score]),
    [
      ['ca', 'vm', 70],
      ['cb', 'va', 70],
    ],
    'equal scores sort by candidate id; witness is smallest version id',
  );
});

test('fewer than k qualifying candidates returns all of them', () => {
  const candidates: CandidateInput[] = [
    { id: 'c1', tags: ['x'], resumes: [{ id: 'v1', skills: [], experienceMonths: 0 }] },
    { id: 'c2', tags: ['x'], resumes: [{ id: 'v2', skills: [], experienceMonths: 200 }] },
  ];
  const index = buildIndex(candidates);
  const query: Query = {
    filter: { op: 'leaf', leaf: { kind: 'tag', value: 'x' } },
    scoring: [],
    experienceTargetMonths: 50,
    k: 20,
  };
  const actual = search(index, query);
  assert.deepEqual(
    actual.results.map((r) => [r.candidateId, r.score]),
    [
      ['c1', 10],
      ['c2', 0],
    ],
  );
});
