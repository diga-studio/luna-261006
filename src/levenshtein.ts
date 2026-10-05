/**
 * Unit-cost Levenshtein distance: insertion, deletion, substitution
 * each cost 1. Adjacent transposition is NOT a distinct operation.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const substitution = prev[j - 1] + (ca === b.charCodeAt(j - 1) ? 0 : 1);
      const deletion = prev[j] + 1;
      const insertion = curr[j - 1] + 1;
      curr[j] = Math.min(substitution, deletion, insertion);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[n];
}
