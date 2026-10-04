/**
 * Hash-consed boolean formula DAG over environment atoms.
 * Atom identity is the environment key string, so repeated checks of the
 * same key are correlated by construction.
 */
export type Formula =
  | { id: number; op: 'const'; value: boolean }
  | { id: number; op: 'atom'; key: string }
  | { id: number; op: 'not'; arg: Formula }
  | { id: number; op: 'and'; args: Formula[] }
  | { id: number; op: 'or'; args: Formula[] };

type FormulaBody =
  | { op: 'const'; value: boolean }
  | { op: 'atom'; key: string }
  | { op: 'not'; arg: Formula }
  | { op: 'and'; args: Formula[] }
  | { op: 'or'; args: Formula[] };

export class FormulaBuilder {
  private nextId = 0;
  private readonly intern = new Map<string, Formula>();
  private readonly negationOf = new Map<number, number>();
  private readonly byId = new Map<number, Formula>();
  private readonly trueF: Formula;
  private readonly falseF: Formula;

  constructor() {
    this.trueF = this.fresh({ op: 'const', value: true });
    this.falseF = this.fresh({ op: 'const', value: false });
    this.negationOf.set(this.trueF.id, this.falseF.id);
    this.negationOf.set(this.falseF.id, this.trueF.id);
  }

  private fresh(body: FormulaBody): Formula {
    const f = { ...body, id: this.nextId++ } as Formula;
    this.byId.set(f.id, f);
    return f;
  }

  const(value: boolean): Formula {
    return value ? this.trueF : this.falseF;
  }

  atom(key: string): Formula {
    const k = `a:${key}`;
    let f = this.intern.get(k);
    if (f === undefined) {
      f = this.fresh({ op: 'atom', key });
      this.intern.set(k, f);
    }
    return f;
  }

  not(a: Formula): Formula {
    if (a.op === 'const') return this.const(!a.value);
    const existing = this.negationOf.get(a.id);
    if (existing !== undefined) {
      // Reuse the existing node so not(not(x)) === x by identity.
      return this.byId.get(existing)!;
    }
    const f = this.fresh({ op: 'not', arg: a });
    this.negationOf.set(a.id, f.id);
    this.negationOf.set(f.id, a.id);
    return f;
  }

  and(a: Formula, b: Formula): Formula {
    if (a.op === 'const') return a.value ? b : a;
    if (b.op === 'const') return b.value ? a : b;
    if (a.id === b.id) return a;
    if (this.negationOf.get(a.id) === b.id) return this.falseF;
    const [lo, hi] = a.id < b.id ? [a, b] : [b, a];
    const k = `&:${lo.id}:${hi.id}`;
    let f = this.intern.get(k);
    if (f === undefined) {
      f = this.fresh({ op: 'and', args: [lo, hi] });
      this.intern.set(k, f);
    }
    return f;
  }

  or(a: Formula, b: Formula): Formula {
    if (a.op === 'const') return a.value ? a : b;
    if (b.op === 'const') return b.value ? b : a;
    if (a.id === b.id) return a;
    if (this.negationOf.get(a.id) === b.id) return this.trueF;
    const [lo, hi] = a.id < b.id ? [a, b] : [b, a];
    const k = `|:${lo.id}:${hi.id}`;
    let f = this.intern.get(k);
    if (f === undefined) {
      f = this.fresh({ op: 'or', args: [lo, hi] });
      this.intern.set(k, f);
    }
    return f;
  }
}

/** Tseitin-encodes the DAG rooted at `root` into CNF plus a root literal. */
function tseitin(root: Formula): { clauses: number[][]; rootLit: number; atomVars: Map<string, number> } {
  const clauses: number[][] = [];
  const atomVars = new Map<string, number>();
  const nodeVar = new Map<number, number>();
  let nextVar = 1;

  const varFor = (f: Formula): number => {
    let v = nodeVar.get(f.id);
    if (v !== undefined) return v;
    v = nextVar++;
    nodeVar.set(f.id, v);
    switch (f.op) {
      case 'const':
        clauses.push([f.value ? v : -v]);
        break;
      case 'atom': {
        const existing = atomVars.get(f.key);
        if (existing !== undefined) {
          // Same key -> same variable (correlated judgments).
          nodeVar.set(f.id, existing);
          return existing;
        }
        atomVars.set(f.key, v);
        break;
      }
      case 'not': {
        const a = varFor(f.arg);
        clauses.push([-v, -a], [v, a]);
        break;
      }
      case 'and': {
        const args = f.args.map(varFor);
        for (const a of args) clauses.push([-v, a]);
        clauses.push([v, ...args.map((a) => -a)]);
        break;
      }
      case 'or': {
        const args = f.args.map(varFor);
        for (const a of args) clauses.push([v, -a]);
        clauses.push([-v, ...args]);
        break;
      }
    }
    return v;
  };

  const rootLit = varFor(root);
  return { clauses, rootLit, atomVars };
}

/** DPLL with unit propagation; returns a satisfying assignment or null. */
function dpll(clauses: number[][], numVars: number): Int8Array | null {
  const assignment = new Int8Array(numVars + 1); // 0 = unassigned, 1/-1 = value

  const propagate = (): boolean => {
    let changed = true;
    while (changed) {
      changed = false;
      for (const clause of clauses) {
        let unassigned = 0;
        let lastLit = 0;
        let satisfied = false;
        for (const lit of clause) {
          const val = assignment[Math.abs(lit)]!;
          if (val === 0) {
            unassigned += 1;
            lastLit = lit;
          } else if ((val === 1) === (lit > 0)) {
            satisfied = true;
            break;
          }
        }
        if (satisfied) continue;
        if (unassigned === 0) return false; // conflict
        if (unassigned === 1) {
          const v = Math.abs(lastLit);
          if (assignment[v] !== 0) continue;
          assignment[v] = lastLit > 0 ? 1 : -1;
          changed = true;
        }
      }
    }
    return true;
  };

  const solve = (): boolean => {
    if (!propagate()) return false;
    // Pick the unassigned variable occurring most often.
    const counts = new Map<number, number>();
    for (const clause of clauses) {
      let satisfied = false;
      for (const lit of clause) {
        const val = assignment[Math.abs(lit)]!;
        if (val !== 0 && (val === 1) === (lit > 0)) { satisfied = true; break; }
      }
      if (satisfied) continue;
      for (const lit of clause) {
        const v = Math.abs(lit);
        if (assignment[v] === 0) counts.set(v, (counts.get(v) ?? 0) + 1);
      }
    }
    if (counts.size === 0) return true; // all clauses satisfied
    let best = 0;
    let bestCount = -1;
    for (const [v, c] of counts) {
      if (c > bestCount) { best = v; bestCount = c; }
    }
    const snapshot = assignment.slice();
    assignment[best] = 1;
    if (solve()) return true;
    assignment.set(snapshot);
    assignment[best] = -1;
    if (solve()) return true;
    assignment.set(snapshot);
    return false;
  };

  return solve() ? assignment : null;
}

/**
 * Returns a satisfying assignment (env key -> bool) for `formula === value`,
 * or null if unsatisfiable. Complete decision procedure (DPLL over a
 * Tseitin encoding of the DAG); never approximates, samples, or truncates.
 * Every key in `allKeys` appears in the returned assignment.
 */
export function findModel(
  formula: Formula,
  value: boolean,
  allKeys: readonly string[],
): Record<string, boolean> | null {
  const { clauses, rootLit, atomVars } = tseitin(formula);
  clauses.push([value ? rootLit : -rootLit]);
  let numVars = 0;
  for (const clause of clauses) {
    for (const lit of clause) {
      const v = Math.abs(lit);
      if (v > numVars) numVars = v;
    }
  }
  const model = dpll(clauses, numVars);
  if (model === null) return null;
  const result: Record<string, boolean> = {};
  for (const key of allKeys) {
    const v = atomVars.get(key);
    result[key] = v !== undefined && model[v] === 1;
  }
  return result;
}
