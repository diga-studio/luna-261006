import type { RoundResult } from "../src/types.js";

/** Lexicographic objectives of one round: maximize pairs, then minimize
 *  sum of squared cumulative bye counts, then maximize common-tag sum. */
export interface Objectives {
  pairs: number;
  byeSquares: number;
  tagSum: number;
}

export function popcount(x: bigint): number {
  let c = 0;
  while (x !== 0n) {
    x &= x - 1n;
    c++;
  }
  return c;
}

function better(a: Objectives, b: Objectives): boolean {
  if (a.pairs !== b.pairs) return a.pairs > b.pairs;
  if (a.byeSquares !== b.byeSquares) return a.byeSquares < b.byeSquares;
  return a.tagSum > b.tagSum;
}

/**
 * Exhaustively computes the optimal objectives of a round.
 * @param tagMasks  tag bitmask per attendee
 * @param byeCounts cumulative bye count per attendee (before this round)
 * @param blocked   (i, j) -> pair already met before (attendee indices)
 */
export function bruteForceObjectives(
  tagMasks: bigint[],
  byeCounts: number[],
  blocked: (i: number, j: number) => boolean,
): Objectives {
  const n = tagMasks.length;
  const can: boolean[][] = [];
  const score: number[][] = [];
  for (let i = 0; i < n; i++) {
    can.push(new Array<boolean>(n).fill(false));
    score.push(new Array<number>(n).fill(0));
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const common = tagMasks[i] & tagMasks[j];
      if (common !== 0n && !blocked(i, j)) {
        can[i][j] = can[j][i] = true;
        score[i][j] = score[j][i] = popcount(common);
      }
    }
  }
  const done = new Array<boolean>(n).fill(false); // processed in the recursion
  const paired = new Array<boolean>(n).fill(false); // actually matched to someone
  let best: Objectives | null = null;
  function go(pairs: number, tagSum: number): void {
    let i = 0;
    while (i < n && done[i]) i++;
    if (i === n) {
      let byeSquares = 0;
      for (let k = 0; k < n; k++) {
        const c = byeCounts[k] + (paired[k] ? 0 : 1);
        byeSquares += c * c;
      }
      const cur: Objectives = { pairs, byeSquares, tagSum };
      if (best === null || better(cur, best)) best = cur;
      return;
    }
    done[i] = true;
    for (let j = i + 1; j < n; j++) {
      if (!done[j] && can[i][j]) {
        done[j] = true;
        paired[i] = paired[j] = true;
        go(pairs + 1, tagSum + score[i][j]);
        paired[i] = paired[j] = false;
        done[j] = false;
      }
    }
    go(pairs, tagSum); // i sits out this round (stays done during recursion)
    done[i] = false;
  }
  go(0, 0);
  return best!;
}

/**
 * Computes the objectives achieved by an actual round result.
 * @param attendeeIdx indices (into tagMasks/byeCounts) of this round's attendees
 */
export function objectivesOf(
  result: RoundResult,
  attendeeIdx: number[],
  idToPos: Map<string, number>,
  byeCounts: number[],
): Objectives {
  const byePos = new Set<number>();
  for (const id of result.byes) byePos.add(idToPos.get(id)!);
  let byeSquares = 0;
  for (const idx of attendeeIdx) {
    const pos = idx;
    const c = byeCounts[pos] + (byePos.has(pos) ? 1 : 0);
    byeSquares += c * c;
  }
  let tagSum = 0;
  for (const p of result.pairs) tagSum += p.commonTags.length;
  return { pairs: result.pairs.length, byeSquares, tagSum };
}

/** Deterministic PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
