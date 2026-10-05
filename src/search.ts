import { unwrap } from './build.js';
import type { BuiltIndex } from './build.js';
import { evaluateFilter } from './filter.js';
import type {
  Index,
  Query,
  ScoredHit,
  SearchOptions,
  SearchOutput,
  SearchResultItem,
} from './types.js';

const MAX_EXP_BONUS = 60;
const EXHAUSTED = Number.MAX_SAFE_INTEGER;

interface Term {
  /** Sorted version slots matching the scoring leaf (unfiltered). */
  readonly postings: readonly number[];
  readonly weight: number;
  readonly leafIndex: number;
  /** Cursor into postings; always points at a qualifying slot or end. */
  pos: number;
}

function lowerBound(arr: readonly number[], target: number, from: number): number {
  let lo = from;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < target) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function contains(arr: readonly number[], target: number): boolean {
  const at = lowerBound(arr, target, 0);
  return at < arr.length && arr[at] === target;
}

export function searchImpl(index: Index, query: Query, options?: SearchOptions): SearchOutput {
  const idx = unwrap(index);
  const k = Math.max(0, Math.floor(query.k));
  if (k === 0 || idx.versions.length === 0) {
    return { results: [], scoredVersions: 0 };
  }

  // Set-algebra filter evaluation: no per-version scoring work.
  const qualifying = evaluateFilter(idx, query.filter);
  const qualifyingSlots: number[] = [];
  for (let slot = 0; slot < qualifying.length; slot += 1) {
    if (qualifying[slot] === 1) {
      qualifyingSlots.push(slot);
    }
  }
  if (qualifyingSlots.length === 0) {
    return { results: [], scoredVersions: 0 };
  }

  const target = query.experienceTargetMonths;
  const observer = options?.onVersionScored;
  const candidateCount = idx.candidateIds.length;

  const bestScore = new Int32Array(candidateCount).fill(-1);
  const bestSlot = new Int32Array(candidateCount).fill(-1);
  const bestMatched: (readonly ScoredHit[] | null)[] = new Array(candidateCount).fill(null);
  // The k largest candidate best-so-far scores, ascending.
  const topScores: number[] = [];
  let scoredVersions = 0;

  const threshold = (): number =>
    topScores.length === k ? topScores[0] - 1 : -1;

  const noteCandidate = (candidate: number, oldScore: number, newScore: number): void => {
    if (oldScore >= 0) {
      const at = lowerBound(topScores, oldScore, 0);
      if (at < topScores.length && topScores[at] === oldScore) {
        topScores.splice(at, 1);
      }
    }
    if (topScores.length < k || newScore > topScores[0]) {
      const at = lowerBound(topScores, newScore, 0);
      topScores.splice(at, 0, newScore);
      if (topScores.length > k) {
        topScores.shift();
      }
    }
  };

  const terms: Term[] = [];
  for (let i = 0; i < query.scoring.length; i += 1) {
    const { leaf, weight } = query.scoring[i];
    const postings =
      leaf.kind === 'tag'
        ? idx.tagPostings.get(leaf.value)
        : idx.skillPostings.get(leaf.value);
    if (postings !== undefined && postings.length > 0) {
      terms.push({ postings, weight, leafIndex: i, pos: 0 });
    }
  }

  /** Scores one qualifying version exactly and records it. This is the only
   *  place per-version query-dependent work happens. */
  const scoreVersion = (slot: number): void => {
    scoredVersions += 1;
    const rec = idx.versions[slot];
    observer?.({
      candidateId: idx.candidateIds[rec.candidateIndex],
      versionId: rec.versionId,
    });
    let score =
      MAX_EXP_BONUS - Math.abs(rec.experienceMonths - target);
    if (score < 0) {
      score = 0;
    }
    const matched: ScoredHit[] = [];
    for (const term of terms) {
      if (contains(term.postings, slot)) {
        score += term.weight;
        matched.push({ leaf: query.scoring[term.leafIndex].leaf, weight: term.weight });
      }
    }
    const candidate = rec.candidateIndex;
    const old = bestScore[candidate];
    if (
      score > old ||
      (score === old && rec.versionId < idx.versions[bestSlot[candidate]].versionId)
    ) {
      bestScore[candidate] = score;
      bestSlot[candidate] = slot;
      bestMatched[candidate] = matched;
      noteCandidate(candidate, old, score);
    }
  };

  if (terms.length === 0) {
    runExperienceOnly(idx, qualifying, target, k, topScores, scoreVersion);
  } else {
    runWand(idx, qualifying, qualifyingSlots, terms, threshold, scoreVersion);
  }

  const ranked: { candidate: number; score: number }[] = [];
  for (let candidate = 0; candidate < candidateCount; candidate += 1) {
    if (bestScore[candidate] >= 0) {
      ranked.push({ candidate, score: bestScore[candidate] });
    }
  }
  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      (idx.candidateIds[a.candidate] < idx.candidateIds[b.candidate]
        ? -1
        : idx.candidateIds[a.candidate] > idx.candidateIds[b.candidate]
          ? 1
          : 0),
  );

  const results: SearchResultItem[] = ranked.slice(0, k).map(({ candidate, score }) => ({
    candidateId: idx.candidateIds[candidate],
    score,
    witnessVersionId: idx.versions[bestSlot[candidate]].versionId,
    matchedScoring: bestMatched[candidate] ?? [],
  }));

  return { results, scoredVersions };
}

function advance(term: Term, qualifying: Uint8Array, targetSlot: number): void {
  let pos = lowerBound(term.postings, targetSlot, term.pos);
  while (pos < term.postings.length && qualifying[term.postings[pos]] === 0) {
    pos += 1;
  }
  term.pos = pos;
}

function currentOf(term: Term): number {
  return term.pos < term.postings.length ? term.postings[term.pos] : EXHAUSTED;
}

/**
 * Exact WAND (weak AND) top-k evaluation with a dynamic threshold.
 * Only pivot-aligned versions are fully scored; every version whose score
 * could reach the running k-th best candidate score is guaranteed to be
 * evaluated, so the final top-k is exact.
 */
function runWand(
  idx: BuiltIndex,
  qualifying: Uint8Array,
  qualifyingSlots: number[],
  terms: Term[],
  threshold: () => number,
  scoreVersion: (slot: number) => void,
): void {
  // A zero-weight term over all qualifying versions: versions matching no
  // scoring leaf still earn the experience bonus and must be considered
  // whenever the threshold is below the maximum bonus.
  const universe: Term = { postings: qualifyingSlots, weight: 0, leafIndex: -1, pos: 0 };
  const active: Term[] = [universe, ...terms];
  for (const term of active) {
    advance(term, qualifying, 0);
  }

  for (;;) {
    active.sort((a, b) => currentOf(a) - currentOf(b));
    if (currentOf(active[0]) === EXHAUSTED) {
      return;
    }

    const limit = threshold();
    let cumulative = 0;
    let pivot = -1;
    for (let i = 0; i < active.length; i += 1) {
      const current = currentOf(active[i]);
      if (current === EXHAUSTED) {
        break;
      }
      cumulative += active[i].weight;
      if (cumulative + MAX_EXP_BONUS > limit) {
        pivot = i;
        break;
      }
    }
    if (pivot < 0) {
      return;
    }

    const pivotSlot = currentOf(active[pivot]);
    if (currentOf(active[0]) === pivotSlot) {
      scoreVersion(pivotSlot);
      for (const term of active) {
        if (currentOf(term) === pivotSlot) {
          advance(term, qualifying, pivotSlot + 1);
        }
      }
    } else {
      for (let i = 0; i < pivot; i += 1) {
        if (currentOf(active[i]) < pivotSlot) {
          advance(active[i], qualifying, pivotSlot);
        }
      }
    }
  }
}

/**
 * Ranking path for queries without scoring leaves: score depends only on
 * experience distance, so versions are visited in non-increasing score
 * order around the target and the scan stops as soon as no unseen version
 * can reach the running k-th best candidate score.
 */
function runExperienceOnly(
  idx: BuiltIndex,
  qualifying: Uint8Array,
  target: number,
  k: number,
  topScores: number[],
  scoreVersion: (slot: number) => void,
): void {
  const ordered = idx.slotsByExperience;
  const experiences = ordered.map((slot) => idx.versions[slot].experienceMonths);

  const hi0 = lowerBound(experiences, target, 0);
  let lo = hi0 - 1;
  let hi = hi0;

  for (;;) {
    const loDist = lo >= 0 ? target - experiences[lo] : Number.MAX_SAFE_INTEGER;
    const hiDist = hi < ordered.length ? experiences[hi] - target : Number.MAX_SAFE_INTEGER;
    const nextDist = Math.min(loDist, hiDist);
    if (nextDist === Number.MAX_SAFE_INTEGER) {
      return;
    }
    if (topScores.length === k) {
      const bestPossible = Math.max(0, MAX_EXP_BONUS - nextDist);
      if (bestPossible < topScores[0]) {
        return;
      }
    }
    if (loDist <= hiDist) {
      if (qualifying[ordered[lo]] === 1) {
        scoreVersion(ordered[lo]);
      }
      lo -= 1;
    } else {
      if (qualifying[ordered[hi]] === 1) {
        scoreVersion(ordered[hi]);
      }
      hi += 1;
    }
  }
}
