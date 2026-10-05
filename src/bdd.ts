interface BddNode {
  /** Variable index; -1 for terminals. */
  v: number;
  lo: number;
  hi: number;
}

/**
 * Reduced ordered binary decision diagram (ROBDD) over switch variables.
 * Represents, exactly and compactly, sets of switch inputs such as
 * "node N is reachable" or "field F is present at node N".
 *
 * Node 0 is the `false` terminal, node 1 the `true` terminal.
 * Variable ordering is the switch index (ascending from the root).
 */
export class Bdd {
  static readonly FALSE = 0;
  static readonly TRUE = 1;

  private readonly nodes: BddNode[] = [
    { v: -1, lo: 0, hi: 0 },
    { v: -1, lo: 1, hi: 1 },
  ];
  private readonly unique = new Map<string, number>();
  private readonly notCache = new Map<number, number>();
  private readonly andCache = new Map<string, number>();
  private readonly orCache = new Map<string, number>();

  /** BDD for the literal "switch v is true". */
  variable(v: number): number {
    return this.mk(v, Bdd.FALSE, Bdd.TRUE);
  }

  not(a: number): number {
    if (a === Bdd.FALSE) return Bdd.TRUE;
    if (a === Bdd.TRUE) return Bdd.FALSE;
    const cached = this.notCache.get(a);
    if (cached !== undefined) return cached;
    const n = this.nodes[a]!;
    const result = this.mk(n.v, this.not(n.lo), this.not(n.hi));
    this.notCache.set(a, result);
    return result;
  }

  and(a: number, b: number): number {
    return this.apply(true, a, b);
  }

  or(a: number, b: number): number {
    return this.apply(false, a, b);
  }

  /**
   * One complete satisfying assignment over `varCount` variables,
   * or null when the formula is unsatisfiable. Variables not
   * constrained by the formula are assigned `false`.
   */
  oneSat(root: number, varCount: number): boolean[] | null {
    if (root === Bdd.FALSE) return null;
    const assignment = new Array<boolean>(varCount).fill(false);
    let current = root;
    while (current !== Bdd.TRUE) {
      const n = this.nodes[current]!;
      if (n.lo !== Bdd.FALSE) {
        current = n.lo;
      } else {
        assignment[n.v] = true;
        current = n.hi;
      }
    }
    return assignment;
  }

  /** Number of allocated BDD nodes (diagnostics / memory tests). */
  get size(): number {
    return this.nodes.length;
  }

  /** Evaluates the formula for one complete variable assignment. */
  evaluate(root: number, input: boolean[]): boolean {
    let current = root;
    while (current > Bdd.TRUE) {
      const n = this.nodes[current]!;
      current = input[n.v] ? n.hi : n.lo;
    }
    return current === Bdd.TRUE;
  }

  private mk(v: number, lo: number, hi: number): number {
    if (lo === hi) return lo;
    const key = v + ',' + lo + ',' + hi;
    const existing = this.unique.get(key);
    if (existing !== undefined) return existing;
    const id = this.nodes.length;
    this.nodes.push({ v, lo, hi });
    this.unique.set(key, id);
    return id;
  }

  private apply(isAnd: boolean, a: number, b: number): number {
    if (isAnd) {
      if (a === Bdd.FALSE || b === Bdd.FALSE) return Bdd.FALSE;
      if (a === Bdd.TRUE) return b;
      if (b === Bdd.TRUE) return a;
    } else {
      if (a === Bdd.TRUE || b === Bdd.TRUE) return Bdd.TRUE;
      if (a === Bdd.FALSE) return b;
      if (b === Bdd.FALSE) return a;
    }
    if (a === b) return a;
    const key = a < b ? a + ',' + b : b + ',' + a;
    const cache = isAnd ? this.andCache : this.orCache;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const na = this.nodes[a]!;
    const nb = this.nodes[b]!;
    let v: number;
    let aLo: number;
    let aHi: number;
    let bLo: number;
    let bHi: number;
    if (na.v < nb.v) {
      v = na.v;
      aLo = na.lo;
      aHi = na.hi;
      bLo = b;
      bHi = b;
    } else if (na.v > nb.v) {
      v = nb.v;
      aLo = a;
      aHi = a;
      bLo = nb.lo;
      bHi = nb.hi;
    } else {
      v = na.v;
      aLo = na.lo;
      aHi = na.hi;
      bLo = nb.lo;
      bHi = nb.hi;
    }
    const lo = this.apply(isAnd, aLo, bLo);
    const hi = this.apply(isAnd, aHi, bHi);
    const result = this.mk(v, lo, hi);
    cache.set(key, result);
    return result;
  }
}
