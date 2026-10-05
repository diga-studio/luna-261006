const INF = Number.POSITIVE_INFINITY;

/**
 * Unit-cost Levenshtein distance: insertion, deletion, substitution
 * each cost 1. Adjacent transposition is NOT a primitive operation.
 */
export function levenshtein(a: string, b: string): number {
  return levenshteinWithin(a, b, Math.max(a.length, b.length));
}

/**
 * Returns the Levenshtein distance between a and b, or a value greater
 * than maxDistance when the true distance exceeds maxDistance.
 *
 * Banded dynamic programming: only cells with |i - j| <= maxDistance are
 * computed, which is sufficient because any alignment leaving that band
 * costs more than maxDistance.
 */
export function levenshteinWithin(a: string, b: string, maxDistance: number): number {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > maxDistance) {
    return maxDistance + 1;
  }
  if (la === 0) {
    return lb;
  }
  if (lb === 0) {
    return la;
  }

  // prev[j] = distance between a[0..i) and b[0..j), row by row.
  let prev: number[] = new Array<number>(lb + 1);
  let curr: number[] = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j++) {
    prev[j] = j <= maxDistance ? j : INF;
  }

  for (let i = 1; i <= la; i++) {
    const lo = Math.max(1, i - maxDistance);
    const hi = Math.min(lb, i + maxDistance);
    curr[0] = i <= maxDistance ? i : INF;
    for (let j = 1; j < lo; j++) {
      curr[j] = INF;
    }
    const ca = a.charCodeAt(i - 1);
    let rowMin = INF;
    for (let j = lo; j <= hi; j++) {
      const substitution = prev[j - 1] + (ca === b.charCodeAt(j - 1) ? 0 : 1);
      const deletion = prev[j] + 1;
      const insertion = curr[j - 1] + 1;
      const value = Math.min(substitution, deletion, insertion);
      curr[j] = value;
      if (value < rowMin) {
        rowMin = value;
      }
    }
    for (let j = hi + 1; j <= lb; j++) {
      curr[j] = INF;
    }
    if (rowMin > maxDistance) {
      // Every cell in this row already exceeds the bound, and distances
      // can only grow along any path to the bottom-right cell.
      return maxDistance + 1;
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }

  const result = prev[lb];
  return result > maxDistance ? maxDistance + 1 : result;
}
