/**
 * Reduced ordered binary decision diagram (ROBDD) manager.
 * Node ids 0 and 1 are the FALSE and TRUE terminals.
 * Variable ordering is the order in which variables are created.
 */
export type Bdd = number;

interface Node {
  varIndex: number;
  low: Bdd;
  high: Bdd;
}

export class BddManager {
  readonly FALSE: Bdd = 0;
  readonly TRUE: Bdd = 1;

  private readonly nodes: Node[] = [];
  private readonly unique = new Map<string, Bdd>();
  private readonly varIndexes = new Map<string, number>();
  private readonly varNames: string[] = [];
  private readonly applyCache = new Map<string, Bdd>();

  variable(name: string): Bdd {
    let index = this.varIndexes.get(name);
    if (index === undefined) {
      index = this.varNames.length;
      this.varIndexes.set(name, index);
      this.varNames.push(name);
    }
    return this.mk(index, this.FALSE, this.TRUE);
  }

  varCount(): number {
    return this.varNames.length;
  }

  varName(index: number): string {
    const name = this.varNames[index];
    if (name === undefined) throw new Error(`unknown variable index ${index}`);
    return name;
  }

  private mk(varIndex: number, low: Bdd, high: Bdd): Bdd {
    if (low === high) return low;
    const key = `${varIndex}:${low}:${high}`;
    const existing = this.unique.get(key);
    if (existing !== undefined) return existing;
    const id = this.nodes.length + 2;
    this.nodes.push({ varIndex, low, high });
    this.unique.set(key, id);
    return id;
  }

  private node(id: Bdd): Node {
    const n = this.nodes[id - 2];
    if (n === undefined) throw new Error(`invalid BDD node ${id}`);
    return n;
  }

  not(a: Bdd): Bdd {
    return this.apply("not", a, this.FALSE);
  }

  and(a: Bdd, b: Bdd): Bdd {
    return this.apply("and", a, b);
  }

  or(a: Bdd, b: Bdd): Bdd {
    return this.apply("or", a, b);
  }

  private apply(op: "not" | "and" | "or", a: Bdd, b: Bdd): Bdd {
    // Terminal cases.
    if (op === "not" && a < 2) return a === 0 ? 1 : 0;
    if (op === "and") {
      if (a === 0 || b === 0) return 0;
      if (a === 1) return b;
      if (b === 1) return a;
    }
    if (op === "or") {
      if (a === 1 || b === 1) return 1;
      if (a === 0) return b;
      if (b === 0) return a;
    }
    const key = op === "not" ? `n:${a}` : `${op}:${Math.min(a, b)}:${Math.max(a, b)}`;
    const cached = this.applyCache.get(key);
    if (cached !== undefined) return cached;

    const topVar = op === "not" ? this.node(a).varIndex : Math.min(this.node(a).varIndex, this.node(b).varIndex);
    const split = (id: Bdd): [Bdd, Bdd] => {
      if (id < 2) return [id, id];
      const n = this.node(id);
      return n.varIndex === topVar ? [n.low, n.high] : [id, id];
    };
    const [aLow, aHigh] = split(a);
    const [bLow, bHigh] = op === "not" ? [this.FALSE, this.FALSE] : split(b);
    const low = this.apply(op, aLow, bLow);
    const high = this.apply(op, aHigh, bHigh);
    const result = this.mk(topVar, low, high);
    this.applyCache.set(key, result);
    return result;
  }

  /**
   * Returns a partial satisfying assignment (variable index -> value) along one
   * path to the TRUE terminal, or null if the BDD is FALSE. Variables not on
   * the path are don't-cares and left unassigned.
   */
  satisfy(a: Bdd): Map<number, boolean> | null {
    if (a === this.FALSE) return null;
    const out = new Map<number, boolean>();
    let cur = a;
    while (cur !== this.TRUE) {
      const n = this.node(cur);
      if (n.high !== this.FALSE) {
        out.set(n.varIndex, true);
        cur = n.high;
      } else {
        out.set(n.varIndex, false);
        cur = n.low;
      }
    }
    return out;
  }
}
