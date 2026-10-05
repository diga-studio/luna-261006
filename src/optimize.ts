import type { Rational } from "./rational.js";
import { ZERO, add, compare, max, mulInt, sub } from "./rational.js";

/** A pack option for one ingredient, with size already converted to grams. */
export interface PackOption {
  skuId: string;
  sizeGrams: Rational;
  priceCents: number;
  stock: number;
}

export interface PackSelection {
  skuId: string;
  packs: number;
}

export interface OptimizeResult {
  selections: PackSelection[];
  totalGrams: Rational;
  totalPriceCents: bigint;
  /** max(0, required - totalGrams) */
  shortageGrams: Rational;
  /** max(0, totalGrams - required) */
  excessGrams: Rational;
}

interface Candidate {
  counts: number[];
  grams: Rational;
  price: bigint;
  packs: number;
  shortage: Rational;
  excess: Rational;
}

function metrics(grams: Rational, required: Rational): { shortage: Rational; excess: Rational } {
  const diff = sub(grams, required);
  return {
    shortage: compare(diff, ZERO) < 0 ? sub(required, grams) : ZERO,
    excess: compare(diff, ZERO) > 0 ? diff : ZERO,
  };
}

/** Lexicographic order: shortage, price, excess, packs. Negative = a is better. */
function compareCandidate(
  a: Pick<Candidate, "shortage" | "price" | "excess" | "packs">,
  b: Pick<Candidate, "shortage" | "price" | "excess" | "packs">,
): number {
  const byShortage = compare(a.shortage, b.shortage);
  if (byShortage !== 0) return byShortage;
  if (a.price !== b.price) return a.price < b.price ? -1 : 1;
  const byExcess = compare(a.excess, b.excess);
  if (byExcess !== 0) return byExcess;
  return a.packs - b.packs;
}

/**
 * Choose pack counts for one ingredient.
 *
 * Lexicographic objective:
 *  1. minimize shortage (so a covering solution always wins when one exists);
 *  2. minimize total price;
 *  3. minimize excess;
 *  4. minimize number of packs.
 */
export function optimizePacks(
  requiredGrams: Rational,
  options: PackOption[],
): OptimizeResult {
  const usable = options.filter((o) => o.stock > 0);
  const empty: OptimizeResult = {
    selections: [],
    totalGrams: ZERO,
    totalPriceCents: 0n,
    shortageGrams: compare(requiredGrams, ZERO) > 0 ? requiredGrams : ZERO,
    excessGrams: ZERO,
  };
  if (compare(requiredGrams, ZERO) <= 0 || usable.length === 0) {
    return empty;
  }

  // suffixMax[i] = total grams purchasable from options[i..end].
  const suffixMax: Rational[] = new Array<Rational>(usable.length + 1);
  suffixMax[usable.length] = ZERO;
  for (let i = usable.length - 1; i >= 0; i -= 1) {
    const option = usable[i] as PackOption;
    suffixMax[i] = add(
      suffixMax[i + 1] as Rational,
      mulInt(option.sizeGrams, BigInt(option.stock)),
    );
  }

  let best: Candidate | undefined;

  function consider(counts: number[], grams: Rational, price: bigint, packs: number): void {
    const { shortage, excess } = metrics(grams, requiredGrams);
    const candidate: Candidate = {
      counts: counts.slice(),
      grams,
      price,
      packs,
      shortage,
      excess,
    };
    if (!best || compareCandidate(candidate, best) < 0) {
      best = candidate;
    }
  }

  function search(
    index: number,
    counts: number[],
    grams: Rational,
    price: bigint,
    packs: number,
  ): void {
    // Stopping here is always a legal candidate.
    consider(counts, grams, price, packs);

    // Already covered: extra packs only add price and excess.
    if (compare(grams, requiredGrams) >= 0) return;

    if (index === usable.length) return;

    if (best) {
      // Best shortage this branch could still reach.
      const reachable = add(grams, suffixMax[index] as Rational);
      const branchShortage =
        compare(reachable, requiredGrams) >= 0 ? ZERO : sub(requiredGrams, reachable);
      if (compare(branchShortage, best.shortage) > 0) return;
      // Prices are positive: once the shortage cannot be improved, any further
      // purchase strictly increases the price past the current best, and the
      // stop-here candidate was already considered above.
      if (compare(branchShortage, best.shortage) === 0 && price >= best.price) return;
    }

    const option = usable[index] as PackOption;
    for (let count = 0; count <= option.stock; count += 1) {
      counts[index] = count;
      search(
        index + 1,
        counts,
        add(grams, mulInt(option.sizeGrams, BigInt(count))),
        price + BigInt(option.priceCents) * BigInt(count),
        packs + count,
      );
    }
    counts[index] = 0;
  }

  search(0, new Array<number>(usable.length).fill(0), ZERO, 0n, 0);

  const winner = best as Candidate;
  return {
    selections: usable
      .map((option, i) => ({ skuId: option.skuId, packs: winner.counts[i] as number }))
      .filter((selection) => selection.packs > 0),
    totalGrams: winner.grams,
    totalPriceCents: winner.price,
    shortageGrams: winner.shortage,
    excessGrams: winner.excess,
  };
}
