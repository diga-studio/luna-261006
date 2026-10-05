import { test } from "node:test";
import assert from "node:assert/strict";
import { BlacklistVerifier, hammingDistance, parseHash, } from "../src/index.js";
import { formatHash } from "../src/hash.js";
import { flipBits, mulberry32, randomDistinctPositions, randomHex, randomWords, } from "./helpers.js";
const RECORD_COUNT = 1000000;
const QUERY_COUNT = 10000;
const VERIFY_BUDGET_MS = 10000;
const MEMORY_BUDGET_BYTES = 768 * 1024 * 1024;
let peakRssSample = 0;
function sampleRss() {
    peakRssSample = Math.max(peakRssSample, process.memoryUsage().rss);
}
function peakRssBytes() {
    sampleRss();
    const maxRss = process.resourceUsage().maxRSS;
    // Linux and macOS report maxRSS in KiB, Windows in bytes.
    const fromMaxRss = process.platform === "win32" ? maxRss : maxRss * 1024;
    return Math.max(peakRssSample, fromMaxRss);
}
function mib(bytes) {
    return (bytes / 1024 / 1024).toFixed(1);
}
const scenarios = [
    {
        name: "scattered bits",
        makeRecordHash: (rng) => randomHex(rng),
        makeMissHash: (rng) => randomHex(rng),
    },
    {
        name: "shared high 16 bits",
        makeRecordHash: (rng) => {
            const w = randomWords(rng);
            return formatHash([w[0], w[1], w[2], 0x5a3c]);
        },
        makeMissHash: (rng) => {
            const w = randomWords(rng);
            return formatHash([w[0], w[1], w[2], 0x5a3c]);
        },
    },
];
for (const scenario of scenarios) {
    test(`perf: 1M records / 10k queries (${scenario.name})`, { timeout: 600000 }, () => {
        const rng = mulberry32(scenario.name === "scattered bits" ? 7 : 8);
        const verifier = new BlacklistVerifier();
        // Bulk load (excluded from the verification time budget).
        const loadStart = Date.now();
        const recordHashes = new Array(RECORD_COUNT);
        const recordWords = new Uint16Array(RECORD_COUNT * 4);
        for (let batch = 0; batch < RECORD_COUNT / 100000; batch++) {
            const entries = [];
            for (let i = 0; i < 100000; i++) {
                const index = batch * 100000 + i;
                const hash = scenario.makeRecordHash(rng);
                recordHashes[index] = hash;
                const words = parseHash(hash);
                recordWords[index * 4] = words[0];
                recordWords[index * 4 + 1] = words[1];
                recordWords[index * 4 + 2] = words[2];
                recordWords[index * 4 + 3] = words[3];
                entries.push({ evidenceId: index + 1, hash });
            }
            verifier.addBatch(entries);
        }
        const loadMs = Date.now() - loadStart;
        assert.equal(verifier.size, RECORD_COUNT);
        sampleRss();
        // Known misses: with 1M records a random query can still land within
        // distance 6 of some record, so miss queries are selected by a
        // (non-timed) pre-pass and only queries that truly miss are kept.
        const collectMisses = (count) => {
            const misses = [];
            while (misses.length < count) {
                const candidates = [];
                for (let i = 0; i < count; i++) {
                    candidates.push(scenario.makeMissHash(rng));
                }
                const preResults = verifier.verifyBatch(candidates);
                for (let i = 0; i < candidates.length; i++) {
                    if (preResults[i] === null && misses.length < count) {
                        misses.push(candidates[i]);
                    }
                }
            }
            return misses;
        };
        const missPool = collectMisses(QUERY_COUNT + 4000);
        // Mixed batch: 6k known hits (0..6 flipped bits) + 4k known misses.
        const queries = [];
        const expectedMaxDistance = [];
        let missCursor = 0;
        for (let i = 0; i < QUERY_COUNT; i++) {
            if (i % 5 < 3) {
                const recordIndex = Math.floor(rng() * RECORD_COUNT);
                const flips = randomDistinctPositions(rng, i % 7);
                queries.push(flipBits(recordHashes[recordIndex], flips));
                expectedMaxDistance.push(flips.length);
            }
            else {
                queries.push(missPool[missCursor++]);
                expectedMaxDistance.push(null);
            }
        }
        const verifyStart = Date.now();
        const results = verifier.verifyBatch(queries);
        const verifyMs = Date.now() - verifyStart;
        sampleRss();
        let hits = 0;
        for (let i = 0; i < QUERY_COUNT; i++) {
            const expected = expectedMaxDistance[i];
            const actual = results[i];
            if (expected === null) {
                assert.equal(actual, null, `query ${i} should miss`);
            }
            else {
                assert.ok(actual !== null, `query ${i} should hit`);
                assert.ok(actual.distance <= expected, `query ${i} distance ${actual.distance} > ${expected}`);
                const citedDistance = hammingDistance(parseHash(recordHashes[actual.evidenceId - 1]), parseHash(queries[i]));
                assert.equal(citedDistance, actual.distance, `query ${i} cited evidence inconsistent`);
                hits++;
            }
        }
        // All-miss batch: 10k queries that must all miss.
        const missQueries = missPool.slice(missCursor);
        assert.equal(missQueries.length, QUERY_COUNT);
        const missStart = Date.now();
        const missResults = verifier.verifyBatch(missQueries);
        const missMs = Date.now() - missStart;
        sampleRss();
        for (const result of missResults) {
            assert.equal(result, null);
        }
        // Exactness spot check: 100 queries against a full exact scan.
        const spotQueries = [];
        for (let i = 0; i < 100; i++) {
            if (i % 2 === 0) {
                const recordIndex = Math.floor(rng() * RECORD_COUNT);
                const flips = randomDistinctPositions(rng, Math.floor(rng() * 9));
                spotQueries.push(flipBits(recordHashes[recordIndex], flips));
            }
            else {
                spotQueries.push(scenario.makeMissHash(rng));
            }
        }
        const spotActual = verifier.verifyBatch(spotQueries);
        const popcount16 = new Uint8Array(0x10000);
        for (let i = 1; i < popcount16.length; i++) {
            popcount16[i] = popcount16[i >> 1] + (i & 1);
        }
        for (let q = 0; q < spotQueries.length; q++) {
            const queryWords = parseHash(spotQueries[q]);
            let bestDistance = 7;
            let bestEvidenceId = -1;
            for (let r = 0; r < RECORD_COUNT; r++) {
                const offset = r * 4;
                const distance = popcount16[(recordWords[offset] ^ queryWords[0]) & 0xffff] +
                    popcount16[(recordWords[offset + 1] ^ queryWords[1]) & 0xffff] +
                    popcount16[(recordWords[offset + 2] ^ queryWords[2]) & 0xffff] +
                    popcount16[(recordWords[offset + 3] ^ queryWords[3]) & 0xffff];
                if (distance > 6) {
                    continue;
                }
                const evidenceId = r + 1;
                if (bestEvidenceId === -1 ||
                    distance < bestDistance ||
                    (distance === bestDistance && evidenceId < bestEvidenceId)) {
                    bestDistance = distance;
                    bestEvidenceId = evidenceId;
                }
            }
            const expected = bestEvidenceId === -1
                ? null
                : { evidenceId: bestEvidenceId, distance: bestDistance };
            assert.deepEqual(spotActual[q], expected, `spot query ${q}`);
        }
        const peak = peakRssBytes();
        console.log(`  [${scenario.name}] load ${loadMs}ms, ` +
            `verify 10k mixed ${verifyMs}ms (${hits} hits), ` +
            `verify 10k all-miss ${missMs}ms, ` +
            `peak RSS ${mib(peak)} MiB`);
        assert.ok(verifyMs < VERIFY_BUDGET_MS, `mixed verify took ${verifyMs}ms > ${VERIFY_BUDGET_MS}ms`);
        assert.ok(missMs < VERIFY_BUDGET_MS, `all-miss verify took ${missMs}ms > ${VERIFY_BUDGET_MS}ms`);
        assert.ok(peak < MEMORY_BUDGET_BYTES, `peak RSS ${mib(peak)} MiB exceeds 768 MiB`);
    });
}
