import { test } from "node:test";
import assert from "node:assert/strict";
import { levenshtein } from "../src/levenshtein.js";

/** Independent naive implementation: direct recursive definition, memoized. */
function naiveLevenshtein(a: string, b: string): number {
  const memo = new Map<string, number>();
  const solve = (i: number, j: number): number => {
    if (i === 0) return j;
    if (j === 0) return i;
    const key = `${i},${j}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    const cost = a[i - 1] === b[j - 1] ? 0 : 1;
    const value = Math.min(
      solve(i - 1, j) + 1,
      solve(i, j - 1) + 1,
      solve(i - 1, j - 1) + cost,
    );
    memo.set(key, value);
    return value;
  };
  return solve(a.length, b.length);
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("known values incl. transposition counting as two edits", () => {
  assert.equal(levenshtein("kitten", "sitting"), 3);
  assert.equal(levenshtein("abc", "abc"), 0);
  assert.equal(levenshtein("ab", "ba"), 2);
  assert.equal(levenshtein("", ""), 0);
  assert.equal(levenshtein("", "abc"), 3);
  assert.equal(levenshtein("abc", ""), 3);
});

test("matches naive implementation on seeded random strings with repeated chars", () => {
  const rand = mulberry32(20261006);
  const alphabet = "aabbcc"; // small alphabet with repeated chars to force collisions
  const randomName = (): string => {
    const len = 1 + Math.floor(rand() * 7);
    let s = "";
    for (let i = 0; i < len; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
    return s;
  };
  for (let caseIndex = 0; caseIndex < 3000; caseIndex++) {
    const a = randomName();
    const b = randomName();
    assert.equal(levenshtein(a, b), naiveLevenshtein(a, b), `mismatch for ${a} vs ${b}`);
  }
});
