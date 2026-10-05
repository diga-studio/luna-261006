/**
 * Maximum weight matching in a general (non-bipartite) graph.
 * Edmonds' blossom algorithm, primal-dual formulation, O(n^3).
 * Port of the well-known compact template used for Library Checker
 * "General Weighted Matching", rewritten with typed arrays.
 *
 * All arithmetic uses IEEE doubles; every operation (+, -, *2, /2) is exact
 * for the weight magnitudes used here (< 2^53), so zero-tests are safe.
 */

export interface WeightedEdge {
  u: number; // 0-based vertex id
  v: number; // 0-based vertex id
  w: number; // weight, only w > 0 is considered
}

const INF = Number.POSITIVE_INFINITY;

class BlossomSolver {
  private readonly n: number;
  private readonly size: number; // 2n + 1, slots for vertices and blossoms (1-based)
  private nX: number; // highest slot in use
  private readonly w: Float64Array;
  private readonly eu: Int32Array;
  private readonly ev: Int32Array;
  private readonly lab: Float64Array;
  private readonly match: Int32Array;
  private readonly slack: Int32Array;
  private readonly st: Int32Array;
  private readonly pa: Int32Array;
  private readonly S: Int8Array; // 0 = outer, 1 = inner, -1 = unreached
  private readonly vis: Int32Array;
  private lcaTime = 0;
  private readonly flowerFrom: Int32Array; // [b * size + x]: child of b through which edges to x enter
  private readonly flower: number[][];
  private readonly queue: number[];
  private qHead = 0;
  private qTail = 0;

  constructor(n: number) {
    this.n = n;
    this.size = 2 * n + 1;
    this.nX = n;
    const cells = this.size * this.size;
    this.w = new Float64Array(cells);
    this.eu = new Int32Array(cells);
    this.ev = new Int32Array(cells);
    this.lab = new Float64Array(this.size);
    this.match = new Int32Array(this.size);
    this.slack = new Int32Array(this.size);
    this.st = new Int32Array(this.size);
    this.pa = new Int32Array(this.size);
    this.S = new Int8Array(this.size);
    this.vis = new Int32Array(this.size);
    this.flowerFrom = new Int32Array(cells);
    this.flower = new Array<number[]>(this.size);
    for (let i = 0; i < this.size; i++) this.flower[i] = [];
    this.queue = new Array<number>(this.size).fill(0);
  }

  private idx(a: number, b: number): number {
    return a * this.size + b;
  }

  setEdge(u: number, v: number, weight: number): void {
    // u, v are 1-based
    const i = this.idx(u, v);
    const j = this.idx(v, u);
    if (weight > this.w[i]) {
      this.w[i] = weight;
      this.eu[i] = u;
      this.ev[i] = v;
      this.w[j] = weight;
      this.eu[j] = v;
      this.ev[j] = u;
    }
  }

  private eDelta(i: number): number {
    return this.lab[this.eu[i]] + this.lab[this.ev[i]] - 2 * this.w[i];
  }

  private updateSlack(u: number, x: number): void {
    const sx = this.slack[x];
    if (sx === 0 || this.eDelta(this.idx(u, x)) < this.eDelta(this.idx(sx, x))) {
      this.slack[x] = u;
    }
  }

  private setSlack(x: number): void {
    this.slack[x] = 0;
    for (let u = 1; u <= this.n; u++) {
      if (this.w[this.idx(u, x)] > 0 && this.st[u] !== x && this.S[this.st[u]] === 0) {
        this.updateSlack(u, x);
      }
    }
  }

  private qPush(x: number): void {
    if (x <= this.n) {
      this.queue[this.qTail++] = x;
    } else {
      const f = this.flower[x];
      for (let i = 0; i < f.length; i++) this.qPush(f[i]);
    }
  }

  private setSt(x: number, b: number): void {
    this.st[x] = b;
    if (x > this.n) {
      const f = this.flower[x];
      for (let i = 0; i < f.length; i++) this.setSt(f[i], b);
    }
  }

  private getPr(b: number, xr: number): number {
    const f = this.flower[b];
    const pr = f.indexOf(xr);
    if (pr % 2 === 1) {
      // reverse elements from index 1 in place so that xr sits at an even position
      for (let i = 1, j = f.length - 1; i < j; i++, j--) {
        const t = f[i];
        f[i] = f[j];
        f[j] = t;
      }
      return f.length - pr;
    }
    return pr;
  }

  private setMatch(u: number, v: number): void {
    this.match[u] = this.ev[this.idx(u, v)];
    if (u <= this.n) return;
    const eU = this.eu[this.idx(u, v)];
    const xr = this.flowerFrom[this.idx(u, eU)];
    const pr = this.getPr(u, xr);
    const f = this.flower[u];
    for (let i = 0; i < pr; i++) this.setMatch(f[i], f[i ^ 1]);
    this.setMatch(xr, v);
    // rotate flower[u] left by pr
    this.flower[u] = f.slice(pr).concat(f.slice(0, pr));
  }

  private augment(u: number, v: number): void {
    const xnv = this.st[this.match[u]];
    this.setMatch(u, v);
    if (xnv === 0) return;
    this.setMatch(xnv, this.st[this.pa[xnv]]);
    this.augment(this.st[this.pa[xnv]], xnv);
  }

  private getLca(u: number, v: number): number {
    this.lcaTime++;
    let x = u;
    let y = v;
    while (x !== 0 || y !== 0) {
      if (x !== 0) {
        if (this.vis[x] === this.lcaTime) return x;
        this.vis[x] = this.lcaTime;
        x = this.st[this.match[x]];
        if (x !== 0) x = this.st[this.pa[x]];
      }
      const t = x;
      x = y;
      y = t;
    }
    return 0;
  }

  private addBlossom(u: number, lca: number, v: number): void {
    const n = this.n;
    let b = n + 1;
    while (b <= this.nX && this.st[b] !== 0) b++;
    if (b > this.nX) {
      this.nX++;
      if (this.nX >= this.size) throw new Error("blossom slots exhausted");
    }
    this.lab[b] = 0;
    this.S[b] = 0;
    this.match[b] = this.match[lca];
    const fb: number[] = [lca];
    for (let x = u, y = 0; x !== lca; x = this.st[this.pa[y]]) {
      fb.push(x);
      y = this.st[this.match[x]];
      fb.push(y);
      this.qPush(y);
    }
    // reverse from index 1
    const tail1 = fb.slice(1).reverse();
    fb.length = 1;
    for (const t of tail1) fb.push(t);
    for (let x = v, y = 0; x !== lca; x = this.st[this.pa[y]]) {
      fb.push(x);
      y = this.st[this.match[x]];
      fb.push(y);
      this.qPush(y);
    }
    this.flower[b] = fb;
    this.setSt(b, b);
    for (let x = 1; x <= this.nX; x++) {
      this.w[this.idx(b, x)] = 0;
      this.w[this.idx(x, b)] = 0;
    }
    for (let x = 1; x <= n; x++) this.flowerFrom[this.idx(b, x)] = 0;
    for (let k = 0; k < fb.length; k++) {
      const xs = fb[k];
      for (let x = 1; x <= this.nX; x++) {
        const ixsx = this.idx(xs, x);
        if (this.w[ixsx] === 0) continue; // never copy a non-edge
        const ibx = this.idx(b, x);
        if (this.w[ibx] === 0 || this.eDelta(ixsx) < this.eDelta(ibx)) {
          this.w[ibx] = this.w[ixsx];
          this.eu[ibx] = this.eu[ixsx];
          this.ev[ibx] = this.ev[ixsx];
          const ixb = this.idx(x, b);
          const ixxs = this.idx(x, xs);
          this.w[ixb] = this.w[ixxs];
          this.eu[ixb] = this.eu[ixxs];
          this.ev[ixb] = this.ev[ixxs];
        }
      }
      for (let x = 1; x <= n; x++) {
        if (this.flowerFrom[this.idx(xs, x)] !== 0) {
          this.flowerFrom[this.idx(b, x)] = xs;
        }
      }
    }
    this.setSlack(b);
  }

  private expandBlossom(b: number): void {
    const fb = this.flower[b];
    for (let i = 0; i < fb.length; i++) this.setSt(fb[i], fb[i]);
    const xr = this.flowerFrom[this.idx(b, this.eu[this.idx(b, this.pa[b])])];
    const pr = this.getPr(b, xr);
    for (let i = 0; i < pr; i += 2) {
      const xs = fb[i];
      const xns = fb[i + 1];
      this.pa[xs] = this.eu[this.idx(xns, xs)];
      this.S[xs] = 1;
      this.S[xns] = 0;
      this.slack[xs] = 0;
      this.setSlack(xns);
      this.qPush(xns);
    }
    this.S[xr] = 1;
    this.pa[xr] = this.pa[b];
    for (let i = pr + 1; i < fb.length; i++) {
      const xs = fb[i];
      this.S[xs] = -1;
      this.setSlack(xs);
    }
    this.st[b] = 0;
  }

  private onFoundEdge(u: number, v: number): boolean {
    const su = this.st[u];
    const sv = this.st[v];
    if (this.S[sv] === -1) {
      this.pa[sv] = u;
      this.S[sv] = 1;
      const nu = this.st[this.match[sv]];
      this.slack[sv] = 0;
      this.slack[nu] = 0;
      this.S[nu] = 0;
      this.qPush(nu);
    } else if (this.S[sv] === 0) {
      const lca = this.getLca(su, sv);
      if (lca === 0) {
        this.augment(su, sv);
        this.augment(sv, su);
        return true;
      }
      this.addBlossom(su, lca, sv);
    }
    return false;
  }

  private matching(): boolean {
    this.S.fill(-1);
    this.slack.fill(0);
    this.qHead = 0;
    this.qTail = 0;
    for (let x = 1; x <= this.nX; x++) {
      if (this.st[x] === x && this.match[x] === 0) {
        this.pa[x] = 0;
        this.S[x] = 0;
        this.qPush(x);
      }
    }
    if (this.qTail === 0) return false;
    for (;;) {
      while (this.qHead < this.qTail) {
        const u = this.queue[this.qHead++];
        if (this.S[this.st[u]] === 1) continue;
        for (let v = 1; v <= this.n; v++) {
          const iuv = this.idx(u, v);
          if (this.w[iuv] > 0 && this.st[u] !== this.st[v]) {
            if (this.eDelta(iuv) === 0) {
              if (this.onFoundEdge(this.eu[iuv], this.ev[iuv])) return true;
            } else {
              this.updateSlack(u, this.st[v]);
            }
          }
        }
      }
      let d = INF;
      for (let b = this.n + 1; b <= this.nX; b++) {
        if (this.st[b] === b && this.S[b] === 1 && this.lab[b] / 2 < d) d = this.lab[b] / 2;
      }
      for (let x = 1; x <= this.nX; x++) {
        if (this.st[x] === x && this.slack[x] !== 0) {
          const e = this.eDelta(this.idx(this.slack[x], x));
          if (this.S[x] === -1) {
            if (e < d) d = e;
          } else if (this.S[x] === 0) {
            if (e / 2 < d) d = e / 2;
          }
        }
      }
      for (let u = 1; u <= this.n; u++) {
        if (this.S[this.st[u]] === 0) {
          if (this.lab[u] <= d) return false;
          this.lab[u] -= d;
        } else if (this.S[this.st[u]] === 1) {
          this.lab[u] += d;
        }
      }
      for (let b = this.n + 1; b <= this.nX; b++) {
        if (this.st[b] === b) {
          if (this.S[b] === 0) this.lab[b] += d * 2;
          else if (this.S[b] === 1) this.lab[b] -= d * 2;
        }
      }
      this.qHead = 0;
      this.qTail = 0;
      for (let x = 1; x <= this.nX; x++) {
        if (
          this.st[x] === x &&
          this.slack[x] !== 0 &&
          this.st[this.slack[x]] !== x &&
          this.eDelta(this.idx(this.slack[x], x)) === 0
        ) {
          if (this.onFoundEdge(this.eu[this.idx(this.slack[x], x)], x)) return true;
        }
      }
      for (let b = this.n + 1; b <= this.nX; b++) {
        if (this.st[b] === b && this.S[b] === 1 && this.lab[b] === 0) this.expandBlossom(b);
      }
    }
  }

  solve(): Array<[number, number]> {
    const n = this.n;
    this.match.fill(0);
    this.nX = n;
    for (let u = 0; u <= n; u++) {
      this.st[u] = u;
      this.flower[u] = [];
    }
    let wMax = 0;
    for (let u = 1; u <= n; u++) {
      this.flowerFrom[this.idx(u, u)] = u;
      for (let v = 1; v <= n; v++) {
        const wv = this.w[this.idx(u, v)];
        if (wv > wMax) wMax = wv;
      }
    }
    for (let u = 1; u <= n; u++) this.lab[u] = wMax;
    while (this.matching()) {
      // augment until no augmenting path exists
    }
    const pairs: Array<[number, number]> = [];
    for (let u = 1; u <= n; u++) {
      if (this.match[u] !== 0 && this.match[u] < u) {
        pairs.push([this.match[u] - 1, u - 1]);
      }
    }
    return pairs;
  }
}

/**
 * Computes a maximum weight matching on vertices 0..n-1.
 * Returns matched pairs of 0-based vertex ids.
 */
export function maxWeightMatching(n: number, edges: WeightedEdge[]): Array<[number, number]> {
  if (n <= 1 || edges.length === 0) return [];
  const solver = new BlossomSolver(n);
  for (const e of edges) {
    if (e.u < 0 || e.u >= n || e.v < 0 || e.v >= n) {
      throw new Error(`edge endpoint out of range: [${e.u}, ${e.v}] with n=${n}`);
    }
    if (e.w > 0 && e.u !== e.v) solver.setEdge(e.u + 1, e.v + 1, e.w);
  }
  return solver.solve();
}
