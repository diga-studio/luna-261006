import assert from 'node:assert/strict';
import test from 'node:test';
import { buildIndex, search } from '../src/api.js';
import type { Candidate, Query, ScoringItem } from '../src/api.js';
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

const SKILL_COUNT = 24;
const CANDIDATE_COUNT = 50000;

function generateCandidates(seed: number): Candidate[] {
  const rnd = mulberry32(seed);
  const skills = Array.from({ length: SKILL_COUNT }, (_, i) => `skill-${i}`);
  const candidates: Candidate[] = [];
  for (let i = 0; i < CANDIDATE_COUNT; i++) {
    const resumes = [];
    for (let v = 0; v < 3; v++) {
      resumes.push({
        versionId: `c${i}-v${v}`,
        skills: skills.filter(() => rnd() < 0.5),
        experienceMonths: Math.floor(rnd() * 241),
      });
    }
    candidates.push({ id: `candidate-${i}`, tags: ['base'], resumes });
  }
  return candidates;
}

function generateQueries(seed: number, count: number): Query[] {
  const rnd = mulberry32(seed);
  const queries: Query[] = [];
  for (let q = 0; q < count; q++) {
    const pool = Array.from({ length: SKILL_COUNT }, (_, i) => i);
    const scoring: ScoringItem[] = [];
    for (let s = 0; s < 12; s++) {
      const skillIdx = pool.splice(Math.floor(rnd() * pool.length), 1)[0]!;
      scoring.push({
        kind: 'skill',
        value: `skill-${skillIdx}`,
        weight: 50 + Math.floor(rnd() * 51),
      });
    }
    queries.push({
      filter: { op: 'tag', tag: 'base' },
      scoring,
      targetExperienceMonths: Math.floor(rnd() * 241),
      k: 20,
    });
  }
  return queries;
}

test('50k candidates x 3 versions: exact top-20 with bounded scoring work', () => {
  const candidates = generateCandidates(20261005);
  const index = buildIndex(candidates);
  const queries = generateQueries(777, 5);
  for (const query of queries) {
    const observed = new Set<string>();
    let observationCalls = 0;
    const result = search(index, query, {
      onScoreVersion: (o) => {
        observationCalls++;
        observed.add(`${o.candidateId}/${o.versionId}`);
      },
    });
    const expected = oracleSearch(candidates, query);
    assert.equal(result.hits.length, expected.length, 'hit count');
    for (let i = 0; i < expected.length; i++) {
      assert.equal(result.hits[i]!.candidateId, expected[i]!.candidateId, `hit[${i}].candidateId`);
      assert.equal(result.hits[i]!.score, expected[i]!.score, `hit[${i}].score`);
      assert.equal(result.hits[i]!.witnessVersionId, expected[i]!.witnessVersionId, `hit[${i}].witness`);
      assert.deepEqual(result.hits[i]!.matchedScoring, expected[i]!.matchedScoring, `hit[${i}].matched`);
    }
    assert.equal(observationCalls, observed.size, 'observer fires once per distinct resume');
    assert.equal(result.scoredVersions, observed.size, 'scoredVersions matches observer');
    assert.ok(
      result.scoredVersions <= 2000,
      `scoredVersions ${result.scoredVersions} exceeds 2000`,
    );
  }
});
