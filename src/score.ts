import type { Mentor, Newcomer } from "./types.js";

export const DEPARTMENT_SCORE = 30;
export const LOCATION_SCORE = 10;
export const INTEREST_SCORE_EACH = 5;
export const INTEREST_SCORE_CAP = 25;
export const TENURE_SCORE = 20;

/** Fixed compatibility components (everything except the load term). */
export function pairStaticScore(newcomer: Newcomer, mentor: Mentor): number {
  let score = 0;
  if (newcomer.department === mentor.department) score += DEPARTMENT_SCORE;
  if (newcomer.location === mentor.location) score += LOCATION_SCORE;
  let shared = 0;
  for (const tag of newcomer.interests) {
    if (mentor.interests.has(tag)) shared += 1;
  }
  score += Math.min(shared * INTEREST_SCORE_EACH, INTEREST_SCORE_CAP);
  // All candidates have been pre-vetted to have >= 6 months tenure.
  score += TENURE_SCORE;
  return score;
}

/** Load term given a mentor's final load (1..3). */
export function loadTerm(finalLoad: number): number {
  switch (finalLoad) {
    case 1:
      return 15;
    case 2:
      return 7.5;
    case 3:
      return 0;
    default:
      throw new Error(`invalid final load: ${finalLoad}`);
  }
}

/**
 * Marginal load-term contribution of the `batchCount`-th batch newcomer
 * (forced or planned) under a mentor with the given historical load,
 * summed over every batch newcomer under that mentor. With b batch
 * newcomers the final load is historical + b and the batch load terms sum
 * to b * loadTerm(historical + b); this returns the delta from b - 1 to b.
 */
export function marginalLoadScore(batchCount: number, historical: number): number {
  const total = (b: number): number => (b === 0 ? 0 : b * loadTerm(historical + b));
  return total(batchCount) - total(batchCount - 1);
}
