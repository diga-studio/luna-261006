import assert from 'node:assert/strict';
import test from 'node:test';
import { buildIndex, search } from '../src/api.js';
import { oracleSearch } from './oracle.js';
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function randInt(rnd, lo, hi) {
    return lo + Math.floor(rnd() * (hi - lo + 1));
}
function pickSubset(rnd, pool, maxSize) {
    const size = randInt(rnd, 0, Math.min(maxSize, pool.length));
    const copy = [...pool];
    const out = [];
    for (let i = 0; i < size; i++) {
        out.push(copy.splice(Math.floor(rnd() * copy.length), 1)[0]);
    }
    return out;
}
const TAGS = ['t0', 't1', 't2', 't3', 't4', 't5'];
const SKILLS = ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7'];
function randomCandidate(rnd, i) {
    const resumes = [];
    const n = randInt(rnd, 1, 3);
    for (let v = 0; v < n; v++) {
        resumes.push({
            versionId: `c${i}v${v}-${randInt(rnd, 0, 3)}`,
            skills: pickSubset(rnd, SKILLS, 5),
            experienceMonths: randInt(rnd, 0, 240),
        });
    }
    return { id: `cand-${String(i).padStart(3, '0')}`, tags: pickSubset(rnd, TAGS, 3), resumes };
}
function randomFilter(rnd, depth) {
    const leaf = () => rnd() < 0.5
        ? { op: 'tag', tag: TAGS[randInt(rnd, 0, TAGS.length - 1)] }
        : { op: 'skill', skill: SKILLS[randInt(rnd, 0, SKILLS.length - 1)] };
    if (depth === 0 || rnd() < 0.4)
        return leaf();
    const kind = rnd();
    if (kind < 0.33)
        return { op: 'not', child: randomFilter(rnd, depth - 1) };
    const n = randInt(rnd, 2, 3);
    const children = Array.from({ length: n }, () => randomFilter(rnd, depth - 1));
    return kind < 0.66 ? { op: 'and', children } : { op: 'or', children };
}
function randomQuery(rnd) {
    const scoring = [];
    const n = randInt(rnd, 1, 12);
    for (let i = 0; i < n; i++) {
        scoring.push({
            kind: rnd() < 0.5 ? 'tag' : 'skill',
            value: rnd() < 0.5 ? TAGS[randInt(rnd, 0, TAGS.length - 1)] : SKILLS[randInt(rnd, 0, SKILLS.length - 1)],
            weight: randInt(rnd, 1, 100),
        });
    }
    return {
        filter: randomFilter(rnd, 3),
        scoring,
        targetExperienceMonths: randInt(rnd, 0, 240),
        k: randInt(rnd, 1, 15),
    };
}
function assertHitsEqual(actual, expected) {
    assert.equal(actual.length, expected.length, 'hit count');
    for (let i = 0; i < expected.length; i++) {
        assert.equal(actual[i].candidateId, expected[i].candidateId, `hit[${i}].candidateId`);
        assert.equal(actual[i].score, expected[i].score, `hit[${i}].score`);
        assert.equal(actual[i].witnessVersionId, expected[i].witnessVersionId, `hit[${i}].witnessVersionId`);
        assert.deepEqual(actual[i].matchedScoring, expected[i].matchedScoring, `hit[${i}].matchedScoring`);
    }
}
test('random small data with nested filters matches oracle', () => {
    for (let trial = 0; trial < 60; trial++) {
        const rnd = mulberry32(1000 + trial);
        const candidates = Array.from({ length: 40 }, (_, i) => randomCandidate(rnd, i));
        const index = buildIndex(candidates);
        for (let q = 0; q < 10; q++) {
            const query = randomQuery(rnd);
            const observed = [];
            const result = search(index, query, {
                onScoreVersion: (o) => observed.push(`${o.candidateId}/${o.versionId}`),
            });
            assertHitsEqual(result.hits, oracleSearch(candidates, query));
            assert.equal(new Set(observed).size, observed.length, 'observer fires once per resume');
            assert.equal(result.scoredVersions, observed.length, 'scoredVersions matches observer count');
        }
    }
});
test('qualification cannot combine skills across versions', () => {
    const candidates = [
        {
            id: 'split',
            tags: ['base'],
            resumes: [
                { versionId: 'split-a', skills: ['x', 'y'], experienceMonths: 10 },
                { versionId: 'split-b', skills: ['z', 'w'], experienceMonths: 10 },
            ],
        },
        {
            id: 'whole',
            tags: ['base'],
            resumes: [{ versionId: 'whole-a', skills: ['x', 'y', 'z', 'w'], experienceMonths: 10 }],
        },
    ];
    const query = {
        filter: {
            op: 'and',
            children: [
                { op: 'tag', tag: 'base' },
                { op: 'skill', skill: 'x' },
                { op: 'skill', skill: 'z' },
            ],
        },
        scoring: [
            { kind: 'skill', value: 'x', weight: 10 },
            { kind: 'skill', value: 'z', weight: 10 },
        ],
        targetExperienceMonths: 10,
        k: 10,
    };
    const result = search(buildIndex(candidates), query);
    assertHitsEqual(result.hits, oracleSearch(candidates, query));
    assert.deepEqual(result.hits.map((h) => h.candidateId), ['whole']);
});
test('candidate and version ties are stable', () => {
    // c-tie-a and c-tie-b have identical best scores; version ties inside c-multi.
    const candidates = [
        {
            id: 'c-tie-b',
            tags: ['base'],
            resumes: [{ versionId: 'v1', skills: ['x'], experienceMonths: 100 }],
        },
        {
            id: 'c-tie-a',
            tags: ['base'],
            resumes: [{ versionId: 'v9', skills: ['x'], experienceMonths: 100 }],
        },
        {
            id: 'c-multi',
            tags: ['base'],
            resumes: [
                { versionId: 'v5', skills: ['x'], experienceMonths: 100 },
                { versionId: 'v3', skills: ['x'], experienceMonths: 100 },
                { versionId: 'v4', skills: [], experienceMonths: 100 },
            ],
        },
    ];
    const query = {
        filter: { op: 'tag', tag: 'base' },
        scoring: [{ kind: 'skill', value: 'x', weight: 50 }],
        targetExperienceMonths: 100,
        k: 3,
    };
    const expected = oracleSearch(candidates, query);
    const first = search(buildIndex(candidates), query);
    assertHitsEqual(first.hits, expected);
    // c-multi wins (110 vs 110? no: v4 scores 60) -> witness must be v3 (tie v3/v5 at 110)
    const multi = first.hits.find((h) => h.candidateId === 'c-multi');
    assert.equal(multi.score, 110);
    assert.equal(multi.witnessVersionId, 'v3');
    // candidate tie between c-tie-a and c-tie-b: lexicographic order, stable across runs
    assert.deepEqual(first.hits.map((h) => h.candidateId), ['c-multi', 'c-tie-a', 'c-tie-b']);
    const second = search(buildIndex(candidates), query);
    assert.deepEqual(second.hits, first.hits);
});
test('experience-only query (no scoring leaves)', () => {
    const rnd = mulberry32(7);
    const candidates = Array.from({ length: 30 }, (_, i) => randomCandidate(rnd, i));
    const index = buildIndex(candidates);
    const query = {
        filter: { op: 'or', children: [{ op: 'tag', tag: 't1' }, { op: 'skill', skill: 's2' }] },
        scoring: [],
        targetExperienceMonths: 77,
        k: 9,
    };
    const result = search(index, query);
    assertHitsEqual(result.hits, oracleSearch(candidates, query));
});
