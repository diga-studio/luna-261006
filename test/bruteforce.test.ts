import { test } from "node:test";
import assert from "node:assert/strict";
import { optimizePacks, type PackOption } from "../src/optimize.js";
import { toGrams } from "../src/units.js";
import { ZERO, add, compare, mulInt, sub, toDecimalString, type Rational } from "../src/rational.js";
import type { Unit } from "../src/index.js";

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

interface Key {
  shortage: Rational;
  price: bigint;
  excess: Rational;
  packs: number;
}

function keyOf(grams: Rational, required: Rational, price: bigint, packs: number): Key {
  const diff = sub(grams, required);
  return {
    shortage: compare(diff, ZERO) < 0 ? sub(required, grams) : ZERO,
    price,
    excess: compare(diff, ZERO) > 0 ? diff : ZERO,
    packs,
  };
}

function keyCompare(a: Key, b: Key): number {
  const byShortage = compare(a.shortage, b.shortage);
  if (byShortage !== 0) return byShortage;
  if (a.price !== b.price) return a.price < b.price ? -1 : 1;
  const byExcess = compare(a.excess, b.excess);
  if (byExcess !== 0) return byExcess;
  return a.packs - b.packs;
}

function keyToString(key: Key): string {
  return `shortage=${toDecimalString(key.shortage)} price=${key.price} excess=${toDecimalString(key.excess)} packs=${key.packs}`;
}

/** Enumerate every legal combination and keep the best by the same for order. */
function bruteForce(required: Rational, options: PackOption[]): Key {
  let best: Key | undefined;
  const counts = new Array<number>(options.length).fill(0);
  function walk(i: number, grams: Rational, price: bigint, packs: number): void {
    if (i === options.length) {
      const key = keyOf(grams, required, price, packs);
      if (!best || keyCompare(key, best) < 0) best = key;
      return;
    }
    const option = options[i]!;
    for (let count = 0; count <= option.stock; count += 1) {
      counts[i] = count;
      walk(
        i + 1,
        add(grams, mulInt(option.sizeGrams, BigInt(count))),
        price + BigInt(option.priceCents) * BigInt(count),
        packs + count,
      );
    }
    counts[i] = 0;
  }
  walk(0, ZERO, 0n, 0);
  return best!;
}

const SIZE_POOL: Array<{ value: string; unit: Unit }> = [
  { value: "50", unit: "g" },
  { value: "100", unit: "g" },
  { value: "250", unit: "g" },
  { value: "8", unit: "oz" },
  { value: "1", unit: "lb" },
  { value: "0.5", unit: "kg" },
];

const REQUIRED_POOL: Array<{ value: string; unit: Unit }> = [
  { value: "300", unit: "g" },
  { value: "750", unit: "g" },
  { value: "1", unit: "kg" },
  { value: "1.5", unit: "kg" },
  { value: "2", unit: "lb" },
  { value: "24", unit: "oz" },
  { value: "0", unit: "g" },
];

test("optimizer matches exhaustive enumeration on randomized small cases", () => {
  const rand = mulberry32(20261006);
  for (let trial = 0; trial < 400; trial += 1) {
    const required = toGrams(REQUIRED_POOL[Math.floor(rand() * REQUIRED_POOL.length)]!);
    const optionCount = 1 + Math.floor(rand() * 4);
    const options: PackOption[] = [];
    for (let i = 0; i < optionCount; i += 1) {
      const size = SIZE_POOL[Math.floor(rand() * SIZE_POOL.length)]!;
      options.push({
        skuId: `sku-${i}`,
        sizeGrams: toGrams(size),
        priceCents: 30 + Math.floor(rand() * 570),
        stock: Math.floor(rand() * 4),
      });
    }
    const expected = bruteForce(required, options);
    const actual = optimizePacks(required, options);
    const actualKey = keyOf(
      actual.totalGrams,
      required,
      actual.totalPriceCents,
      actual.selections.reduce((sum, sel) => sum + sel.packs, 0),
    );
    assert.equal(
      keyCompare(actualKey, expected),
      0,
      `trial ${trial}: required=${toDecimalString(required)}g options=${JSON.stringify(
        options.map((o) => ({
          size: toDecimalString(o.sizeGrams),
          price: o.priceCents,
          stock: o.stock,
        })),
      )} expected=[${keyToString(expected)}] actual=[${keyToString(actualKey)}]`,
    );
    // The reported metrics must be self-consistent.
    assert.equal(compare(actual.shortageGrams, expected.shortage), 0);
    assert.equal(compare(actual.excessGrams, expected.excess), 0);
  }
});
