import assert from 'node:assert/strict';
import test from 'node:test';
import { buildIndex, search } from '../src/index.js';
import type { CandidateInput, Query, ScoringLeaf } from '../src/index.js';
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

const CANDIDATES = 50_000;
const VERSIONS_PER_CANDIDATE = 3;
const SKILL_COUNT = 24;
const QUERY_COUNT = 5;
const SCORING_PER_QUERY = 12;
const K = 20;
const SCORED_VERSION_LIMIT = 2000;

function generateCandidates(seed: number): CandidateInput[] {
  const rand = mulberry32(seed);
  const skills = Array.from({ length: SKILL_COUNT }, (_, i) => `skill${i}`);
  const candidates: CandidateInput[] = [];
  for (let i = 0; i < CANDIDATES; i += 1) {
    const resumes = [];
    for (let v = 0; v < VERSIONS_PER_CANDIDATE; v += 1) {
      resumes.push({
        id: `c${i}v${v}`,
        skills: skills.filter(() => rand() < 0.5),
        experienceMonths: Math.floor(rand() * 241),
      });
    }
    candidates.push({ id: `cand${String(i).padStart(6, '0')}`, tags: ['base'], resumes });
  }
  return candidates;
}

function generateQueries(seed: number): Query[] {
  const rand = mulberry32(seed);
  const queries: Query[] = [];
  for (let q = 0; q < QUERY_COUNT; q += 1) {
    const pool = Array.from({ length: SKILL_COUNT }, (_, i) => i);
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const scoring: ScoringLeaf[] = pool.slice(0, SCORING_PER_QUERY).map((skillIndex) => ({
      leaf: { kind: 'skill', value: `skill${skillIndex}` },
      weight: 50 + Math.floor(rand() * 51),
    }));
    queries.push({
      filter: { op: 'leaf', leaf: { kind: 'tag', value: 'base' } },
      scoring,
      experienceTargetMonths: Math.floor(rand() * 241),
      k: K,
    });
  }
  return queries;
}

test(
  '50k candidates x 3 versions: exact top-20 with bounded scoring work',
  { timeout: 120_000 },
  () => {
    const candidates = generateCandidates(20261005);
    const index = buildIndex(candidates);
    const queries = generateQueries(987654321);

    for (let q = 0; q < queries.length; q += 1) {
      const query = queries[q];
      let observed = 0;
      const seen = new Set<string>();
      const started = performance.now();
      const actual = search(index, query, {
        onVersionScored: (event) => {
          observed += 1;
          seen.add(`${event.candidateId}${event.versionId}`);
        },
      });
      const elapsed = performance.now() - started;
      const expected = oracleSearch(candidates, query);

      assert.deepEqual(actual.results, expected.results, `query ${q} results must match oracle`);
      assert.equal(actual.results.length, K, `query ${q} must return exactly k results`);
      assert.equal(
        actual.scoredVersions,
        observed,
        `query ${q}: observer count must equal scoredVersions`,
      );
      assert.equal(seen.size, observed, `query ${q}: scored versions must be distinct`);
      assert.ok(
        actual.scoredVersions <= SCORED_VERSION_LIMIT,
        `query ${q}: scoredVersions ${actual.scoredVersions} exceeds ${SCORED_VERSION_LIMIT}`,
      );
      console.log(
        `query ${q}: scoredVersions=${actual.scoredVersions} elapsed=${elapsed.toFixed(1)}ms`,
      );
    }
  },
);
