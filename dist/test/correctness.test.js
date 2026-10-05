import { test } from "node:test";
import assert from "node:assert/strict";
import { BlacklistVerifier, hammingDistance, parseHash, } from "../src/index.js";
import { formatHash } from "../src/hash.js";
import { BruteForce, flipBits, mulberry32, randomDistinctPositions, randomHex, randomWords, } from "./helpers.js";
test("parseHash round-trips and hammingDistance counts all 64 bits", () => {
    const zero = parseHash("0000000000000000");
    const topBit = parseHash("8000000000000000");
    assert.equal(hammingDistance(zero, topBit), 1);
    const allOnes = parseHash("ffffffffffffffff");
    assert.equal(hammingDistance(zero, allOnes), 64);
    assert.equal(hammingDistance(allOnes, allOnes), 0);
    assert.equal(formatHash(parseHash("0123456789abcdef")), "0123456789abcdef");
    assert.throws(() => parseHash("123"));
    assert.throws(() => parseHash("zzzzzzzzzzzzzzzz"));
});
test("boundary: distance 6 hits, distance 7 misses", () => {
    const verifier = new BlacklistVerifier();
    verifier.addBatch([{ evidenceId: 1, hash: "0000000000000000" }]);
    const at6 = flipBits("0000000000000000", [0, 1, 2, 3, 4, 5]);
    const at7 = flipBits("0000000000000000", [0, 1, 2, 3, 4, 5, 6]);
    assert.deepEqual(verifier.verifyBatch([at6]), [{ evidenceId: 1, distance: 6 }]);
    assert.deepEqual(verifier.verifyBatch([at7]), [null]);
});
test("most significant bit participates in the comparison", () => {
    const verifier = new BlacklistVerifier();
    verifier.addBatch([{ evidenceId: 9, hash: "0000000000000000" }]);
    assert.deepEqual(verifier.verifyBatch(["8000000000000000"]), [
        { evidenceId: 9, distance: 1 },
    ]);
    const far = flipBits("8000000000000000", [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(verifier.verifyBatch([far]), [null]);
});
test("nearest evidence wins over smallest evidence id", () => {
    const verifier = new BlacklistVerifier();
    verifier.addBatch([
        { evidenceId: 1, hash: flipBits("0000000000000000", [0, 1, 2, 3, 4]) },
        { evidenceId: 2, hash: flipBits("0000000000000000", [0, 1]) },
    ]);
    assert.deepEqual(verifier.verifyBatch(["0000000000000000"]), [
        { evidenceId: 2, distance: 2 },
    ]);
});
test("equal distance ties resolve to the smallest evidence id", () => {
    const verifier = new BlacklistVerifier();
    verifier.addBatch([
        { evidenceId: 50, hash: flipBits("0000000000000000", [0]) },
        { evidenceId: 7, hash: flipBits("0000000000000000", [1]) },
        { evidenceId: 33, hash: flipBits("0000000000000000", [2]) },
    ]);
    assert.deepEqual(verifier.verifyBatch(["0000000000000000"]), [
        { evidenceId: 7, distance: 1 },
    ]);
});
test("replacing an evidence id swaps its hash atomically", () => {
    const verifier = new BlacklistVerifier();
    verifier.addBatch([{ evidenceId: 5, hash: "0000000000000000" }]);
    verifier.addBatch([{ evidenceId: 5, hash: "ffffffffffffffff" }]);
    assert.equal(verifier.size, 1);
    assert.deepEqual(verifier.verifyBatch(["0000000000000000"]), [null]);
    assert.deepEqual(verifier.verifyBatch(["ffffffffffffffff"]), [
        { evidenceId: 5, distance: 0 },
    ]);
});
test("shared hashes: removing one id keeps the others; removing the last clears the hit", () => {
    const verifier = new BlacklistVerifier();
    const shared = "0123456789abcdef";
    verifier.addBatch([
        { evidenceId: 11, hash: shared },
        { evidenceId: 22, hash: shared },
        { evidenceId: 33, hash: shared },
    ]);
    assert.deepEqual(verifier.verifyBatch([shared]), [
        { evidenceId: 11, distance: 0 },
    ]);
    verifier.removeBatch([11]);
    assert.deepEqual(verifier.verifyBatch([shared]), [
        { evidenceId: 22, distance: 0 },
    ]);
    verifier.removeBatch([22, 33]);
    assert.deepEqual(verifier.verifyBatch([shared]), [null]);
    assert.equal(verifier.size, 0);
});
test("removing the current best evidence falls back to the next best", () => {
    const verifier = new BlacklistVerifier();
    verifier.addBatch([
        { evidenceId: 1, hash: "0000000000000000" },
        { evidenceId: 2, hash: flipBits("0000000000000000", [0, 1]) },
    ]);
    assert.deepEqual(verifier.verifyBatch(["0000000000000000"]), [
        { evidenceId: 1, distance: 0 },
    ]);
    verifier.removeBatch([1]);
    assert.deepEqual(verifier.verifyBatch(["0000000000000000"]), [
        { evidenceId: 2, distance: 2 },
    ]);
    verifier.removeBatch([2]);
    assert.deepEqual(verifier.verifyBatch(["0000000000000000"]), [null]);
});
test("repeated removal of the same id is a no-op", () => {
    const verifier = new BlacklistVerifier();
    verifier.addBatch([{ evidenceId: 3, hash: "aaaaaaaaaaaaaaaa" }]);
    verifier.removeBatch([3, 3]);
    verifier.removeBatch([3]);
    assert.equal(verifier.size, 0);
    verifier.removeBatch([999]);
    assert.equal(verifier.size, 0);
});
test("invalid input is rejected and rejects the whole batch", () => {
    const verifier = new BlacklistVerifier();
    assert.throws(() => verifier.addBatch([{ evidenceId: 0, hash: "0000000000000000" }]));
    assert.throws(() => verifier.addBatch([{ evidenceId: 1.5, hash: "0000000000000000" }]));
    assert.throws(() => verifier.addBatch([{ evidenceId: 1, hash: "not-a-hash" }]));
    assert.throws(() => verifier.addBatch([
        { evidenceId: 1, hash: "0000000000000000" },
        { evidenceId: 2, hash: "broken" },
    ]));
    assert.equal(verifier.size, 0);
    assert.throws(() => verifier.verifyBatch(["xyz"]));
});
function runFuzz(seed, clustered) {
    const rng = mulberry32(seed);
    const verifier = new BlacklistVerifier();
    const reference = new BruteForce();
    const liveIds = [];
    const makeHash = () => {
        if (clustered) {
            const words = randomWords(rng);
            return formatHash([words[0], words[1], words[2], 0x9e4c]);
        }
        return randomHex(rng);
    };
    const makeQuery = () => {
        const roll = rng();
        if (liveIds.length > 0 && roll < 0.5) {
            const id = liveIds[Math.floor(rng() * liveIds.length)];
            const base = reference.records.get(id);
            if (base) {
                const flips = randomDistinctPositions(rng, Math.floor(rng() * 9));
                return flipBits(formatHash(base), flips);
            }
        }
        if (clustered) {
            const words = randomWords(rng);
            return formatHash([words[0], words[1], words[2], 0x9e4c]);
        }
        return randomHex(rng);
    };
    for (let round = 0; round < 25; round++) {
        const adds = [];
        const addCount = Math.floor(rng() * 120);
        for (let i = 0; i < addCount; i++) {
            let evidenceId;
            if (liveIds.length > 0 && rng() < 0.3) {
                evidenceId = liveIds[Math.floor(rng() * liveIds.length)];
            }
            else {
                evidenceId = 1 + Math.floor(rng() * 1000000);
            }
            adds.push({ evidenceId, hash: makeHash() });
        }
        verifier.addBatch(adds);
        reference.add(adds);
        for (const entry of adds) {
            if (!liveIds.includes(entry.evidenceId)) {
                liveIds.push(entry.evidenceId);
            }
        }
        const removes = [];
        const removeCount = Math.floor(rng() * 60);
        for (let i = 0; i < removeCount; i++) {
            if (liveIds.length > 0 && rng() < 0.8) {
                removes.push(liveIds[Math.floor(rng() * liveIds.length)]);
            }
            else {
                removes.push(1 + Math.floor(rng() * 1000000));
            }
        }
        verifier.removeBatch(removes);
        reference.remove(removes);
        for (let i = liveIds.length - 1; i >= 0; i--) {
            if (removes.includes(liveIds[i])) {
                liveIds.splice(i, 1);
            }
        }
        const queries = [];
        for (let i = 0; i < 150; i++) {
            queries.push(makeQuery());
        }
        const actual = verifier.verifyBatch(queries);
        const expected = queries.map((q) => reference.verify(q));
        assert.deepEqual(actual, expected, `round ${round} mismatch (seed ${seed})`);
        assert.equal(verifier.size, reference.records.size);
    }
}
test("fuzz: scattered hashes stay consistent with full exact scan", () => {
    runFuzz(42, false);
});
test("fuzz: hashes sharing the high 16 bits stay consistent with full exact scan", () => {
    runFuzz(1337, true);
});
