import { maxWeightMatching, WeightedEdge } from "./matching.js";
import type { MatchPair, RoundResult } from "./types.js";

/**
 * Immutable per-participant data used by the scheduler.
 * Tags are pre-encoded as a bitmask (bit i = tag i), so common-tag
 * count is a popcount of the AND of two masks.
 */
export interface SchedulerState {
  ids: string[];
  tagMasks: bigint[];
  tagNames: string[];
}

export function buildSchedulerState(participants: Array<{ id: string; tags: string[] }>): SchedulerState {
  const ids: string[] = [];
  const tagMasks: bigint[] = [];
  const tagNames: string[] = [];
  const tagToBit = new Map<string, number>();
  for (const p of participants) {
    let mask = 0n;
    for (const t of p.tags) {
      let bit = tagToBit.get(t);
      if (bit === undefined) {
        bit = tagNames.length;
        tagNames.push(t);
        tagToBit.set(t, bit);
      }
      mask |= 1n << BigInt(bit);
    }
    ids.push(p.id);
    tagMasks.push(mask);
  }
  return { ids, tagMasks, tagNames };
}

function popcount(x: bigint): number {
  let c = 0;
  while (x !== 0n) {
    x &= x - 1n;
    c++;
  }
  return c;
}

// Lexicographic objective encoding into a single integer weight:
//   weight = CARD_MULT * 1            (per matched pair: maximize pair count)
//          + NODE_MULT * (wu + wv)    (per matched vertex: minimize bye-square sum)
//          + commonTags              (per pair: maximize shared-tag sum)
// Each level must dominate any possible total of the levels below it.
// Bounds: at most 150 pairs per round, at most 12 cumulative byes per
// participant (wi = 2*byes+1 <= 25), at most 64 common tags per pair.
const MAX_PAIRS = 150;
const MAX_TAG_PER_PAIR = 64;
const MAX_NODE_WEIGHT = 25;
const MAX_TAG_SUM = MAX_PAIRS * MAX_TAG_PER_PAIR; // 9600
const NODE_MULT = MAX_TAG_SUM + 1; // 9601
const CARD_MULT = NODE_MULT * (2 * MAX_PAIRS * MAX_NODE_WEIGHT) + MAX_TAG_SUM + 1; // 72017101

export interface RoundPlan {
  result: RoundResult;
  /** Participant indices matched this round, as [i, j] with i < j. */
  pairIndices: Array<[number, number]>;
}

/**
 * Plans a single round: chooses pairs among attendees maximizing,
 * lexicographically, (1) number of pairs, (2) negative sum of squared
 * cumulative bye counts, (3) total common-tag count.
 *
 * @param attendees  participant indices present this round
 * @param isPaired   (i, j) -> already met in a previous round (i < j)
 * @param byeCounts  cumulative bye counts before this round
 */
export function planRound(
  state: SchedulerState,
  round: number,
  attendees: number[],
  isPaired: (i: number, j: number) => boolean,
  byeCounts: number[],
): RoundPlan {
  const { ids, tagMasks, tagNames } = state;
  const local = new Map<number, number>();
  attendees.forEach((p, idx) => local.set(p, idx));
  const edges: WeightedEdge[] = [];
  const commons: bigint[] = []; // common-tag mask per edge, parallel to edges
  for (let a = 0; a < attendees.length; a++) {
    const i = attendees[a];
    const wi = 2 * byeCounts[i] + 1;
    for (let b = a + 1; b < attendees.length; b++) {
      const j = attendees[b];
      if (isPaired(i, j)) continue;
      const common = tagMasks[i] & tagMasks[j];
      if (common === 0n) continue;
      const wj = 2 * byeCounts[j] + 1;
      edges.push({
        u: a,
        v: b,
        w: CARD_MULT + NODE_MULT * (wi + wj) + popcount(common),
      });
      commons.push(common);
    }
  }
  const matched = maxWeightMatching(attendees.length, edges);
  const edgeKey = new Map<string, bigint>();
  for (let k = 0; k < edges.length; k++) {
    edgeKey.set(`${edges[k].u},${edges[k].v}`, commons[k]);
  }
  const pairs: MatchPair[] = [];
  const pairIndices: Array<[number, number]> = [];
  const matchedLocal = new Set<number>();
  for (const [la, lb] of matched) {
    matchedLocal.add(la);
    matchedLocal.add(lb);
    const i = attendees[la];
    const j = attendees[lb];
    pairIndices.push(i < j ? [i, j] : [j, i]);
    const common = edgeKey.get(`${la},${lb}`)!;
    const commonTags: string[] = [];
    for (let bit = 0; bit < tagNames.length; bit++) {
      if (common & (1n << BigInt(bit))) commonTags.push(tagNames[bit]);
    }
    pairs.push({ a: ids[i], b: ids[j], commonTags });
  }
  const byes: string[] = [];
  for (let a = 0; a < attendees.length; a++) {
    if (!matchedLocal.has(a)) byes.push(ids[attendees[a]]);
  }
  return { result: { round, pairs, byes }, pairIndices };
}
