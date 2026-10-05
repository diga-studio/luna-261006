/**
 * Fenwick (binary indexed) tree over compressed event dates where every node
 * keeps its own update history as parallel (sequence, cumulative weight)
 * arrays. Updates arrive with globally non-decreasing sequence numbers
 * (revision order), so each node's history is sorted by sequence and a
 * historical query "only updates with seq <= seqLimit" is a binary search
 * inside each visited node.
 */
export class FenwickHistory {
  readonly size: number;
  private readonly seqs: number[][];
  private readonly sums: bigint[][];

  constructor(size: number) {
    this.size = size;
    this.seqs = new Array<number[]>(size + 1);
    this.sums = new Array<bigint[]>(size + 1);
    for (let i = 0; i <= size; i++) {
      this.seqs[i] = [];
      this.sums[i] = [];
    }
  }

  /** Appends an update at a 0-based compressed date index. seq must be non-decreasing across calls. */
  add(dateIndex: number, seq: number, weight: bigint): void {
    for (let i = dateIndex + 1; i <= this.size; i += i & -i) {
      const sums = this.sums[i];
      const previous = sums.length === 0 ? 0n : sums[sums.length - 1];
      this.seqs[i].push(seq);
      sums.push(previous + weight);
    }
  }

  /** Sum of weights with dateIndex <= bound (0-based, inclusive) and seq <= seqLimit. */
  prefixSum(bound: number, seqLimit: number): bigint {
    let total = 0n;
    for (let i = bound + 1; i > 0; i -= i & -i) {
      const seqs = this.seqs[i];
      let lo = 0;
      let hi = seqs.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (seqs[mid] <= seqLimit) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0) total += this.sums[i][lo - 1];
    }
    return total;
  }
}
