// Summary of an event sequence for one rule with k stages.
// cell[a][b] (0-based, 0 <= a <= b < k) counts subsequences of the sequence
// that match stages a..b (inclusive) in order. Cells with a > b are unused
// and always 0n. Combining two sequences concatenates them, which makes
// mergeSummaries an associative monoid product with zeroSummary as identity.
export type Summary = bigint[][];

export function zeroSummary(k: number): Summary {
  const cells: Summary = new Array(k);
  for (let a = 0; a < k; a++) {
    cells[a] = new Array<bigint>(k).fill(0n);
  }
  return cells;
}

export function baseSummary(k: number, matchedStages: readonly boolean[]): Summary {
  const cells = zeroSummary(k);
  for (let j = 0; j < k; j++) {
    if (matchedStages[j]) cells[j][j] = 1n;
  }
  return cells;
}

export function mergeSummaries(k: number, left: Summary, right: Summary): Summary {
  const out = zeroSummary(k);
  for (let a = 0; a < k; a++) {
    const rowL = left[a];
    const rowR = right[a];
    const rowOut = out[a];
    for (let b = a; b < k; b++) {
      // Chains matching stages a..b in left++right: entirely in left,
      // entirely in right, or split after stage m (a..m in left,
      // m+1..b in right). Every left event precedes every right event,
      // so any pair of partial chains concatenates into a valid chain.
      let acc = rowL[b] + rowR[b];
      for (let m = a; m < b; m++) {
        const leftPart = rowL[m];
        if (leftPart === 0n) continue;
        const rightPart = right[m + 1][b];
        if (rightPart === 0n) continue;
        acc += leftPart * rightPart;
      }
      rowOut[b] = acc;
    }
  }
  return out;
}
