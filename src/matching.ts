/**
 * Maximum weight matching in a general (non-bipartite) graph.
 * Edmonds' blossom algorithm, maximum-cardinality + maximum-weight variant
 * (port of Joris van Rantwijk's implementation used by NetworkX).
 *
 * All weights must be integers. Dual variables are kept as 2x their
 * fractional values so all arithmetic stays integral.
 *
 * `inputEdges` is a flat array of [v, w, weight] triples.
 * Returns a mate array: mate[v] = partner of v, or -1 if unmatched.
 */
export function maxWeightMatching(
  nodeCount: number,
  inputEdges: ArrayLike<number>,
): Int32Array {
  const n = nodeCount;
  const mate = new Int32Array(n).fill(-1);
  if (n === 0 || inputEdges.length === 0) return mate;

  // Deduplicate parallel edges (keep max weight); drop self-loops.
  const bestWeight = new Map<number, number>();
  for (let e = 0; e + 2 < inputEdges.length; e += 3) {
    const v = inputEdges[e]!;
    const w = inputEdges[e + 1]!;
    const wt = inputEdges[e + 2]!;
    if (v === w) continue;
    const key = v < w ? v * n + w : w * n + v;
    const prev = bestWeight.get(key);
    if (prev === undefined || wt > prev) bestWeight.set(key, wt);
  }

  const edgeV: number[] = [];
  const edgeW: number[] = [];
  const edgeWt: number[] = [];
  const adj: number[][] = [];
  for (let i = 0; i < n; i++) adj.push([]);
  const pairEdge = new Map<number, number>();
  let maxweight = 0;
  for (const [key, wt] of bestWeight) {
    const v = Math.floor(key / n);
    const w = key % n;
    const e = edgeV.length;
    edgeV.push(v);
    edgeW.push(w);
    edgeWt.push(wt);
    adj[v]!.push(e);
    adj[w]!.push(e);
    pairEdge.set(key, e);
    if (wt > maxweight) maxweight = wt;
  }
  const m = edgeV.length;
  if (m === 0) return mate;

  const NONE = -1;
  // State indexed by id: vertices 0..n-1, blossoms n...
  const label: number[] = new Array(n).fill(0); // 0 none, 1 S, 2 T
  const labelEdgeV: number[] = new Array(n).fill(NONE);
  const labelEdgeW: number[] = new Array(n).fill(NONE);
  const parent: number[] = new Array(n).fill(NONE);
  const base: number[] = new Array(n);
  for (let i = 0; i < n; i++) base[i] = i;
  const bestEdgeId: number[] = new Array(n).fill(NONE);
  const bestEdgeFrom: number[] = new Array(n).fill(NONE);
  const isBlossom: boolean[] = new Array(n).fill(false);
  const childs: number[][] = new Array(n);
  const bEdges: Array<Array<[number, number]>> = new Array(n);
  const bDual: number[] = new Array(n).fill(0);
  const myBestEdges: Array<number[] | null> = new Array(n).fill(null);

  const inblossom: number[] = new Array(n);
  for (let i = 0; i < n; i++) inblossom[i] = i;
  const dualvar: number[] = new Array(n).fill(maxweight);
  const allowedge: boolean[] = new Array(m).fill(false);
  const queue: number[] = [];

  function slack(e: number): number {
    return dualvar[edgeV[e]!]! + dualvar[edgeW[e]!]! - 2 * edgeWt[e]!;
  }

  function edgeIdOf(v: number, w: number): number {
    const key = v < w ? v * n + w : w * n + v;
    return pairEdge.get(key)!;
  }

  // Allocation-free leaf iteration: reuses a shared stack buffer.
  const leafStack: number[] = [];
  function forEachLeaf(b: number, fn: (x: number) => void): void {
    leafStack.push(b);
    let mark = leafStack.length - 1;
    while (leafStack.length > mark) {
      const x = leafStack.pop()!;
      if (x < n) fn(x);
      else for (const c of childs[x]!) leafStack.push(c);
    }
  }

  function assignLabel(w: number, t: number, v: number): void {
    const b = inblossom[w]!;
    label[w] = t;
    label[b] = t;
    labelEdgeV[w] = v;
    labelEdgeW[w] = w;
    labelEdgeV[b] = v;
    labelEdgeW[b] = w;
    bestEdgeId[w] = NONE;
    bestEdgeId[b] = NONE;
    if (t === 1) {
      if (isBlossom[b]) {
        forEachLeaf(b, (x) => queue.push(x));
      } else {
        queue.push(b);
      }
    } else {
      const bs = base[b]!;
      assignLabel(mate[bs]!, 1, bs);
    }
  }

  function scanBlossom(v0: number, w0: number): number {
    let v = v0;
    let w = w0;
    const path: number[] = [];
    let baseFound = NONE;
    while (v !== NONE) {
      let b = inblossom[v]!;
      if ((label[b]! & 4) !== 0) {
        baseFound = base[b]!;
        break;
      }
      path.push(b);
      label[b] = 5;
      if (labelEdgeV[b] === NONE) {
        v = NONE;
      } else {
        v = labelEdgeV[b]!;
        b = inblossom[v]!;
        v = labelEdgeV[b]!;
      }
      if (w !== NONE) {
        const tmp = v;
        v = w;
        w = tmp;
      }
    }
    for (const b of path) label[b] = 1;
    return baseFound;
  }

  function addBlossom(baseV: number, v0: number, w0: number): void {
    const bb = inblossom[baseV]!;
    let bv = inblossom[v0]!;
    let bw = inblossom[w0]!;
    const b = label.length;
    label.push(0);
    labelEdgeV.push(NONE);
    labelEdgeW.push(NONE);
    parent.push(NONE);
    base.push(baseV);
    bestEdgeId.push(NONE);
    bestEdgeFrom.push(NONE);
    isBlossom.push(true);
    childs.push([]);
    bEdges.push([]);
    bDual.push(0);
    myBestEdges.push(null);

    parent[bb] = b;
    const path: number[] = [];
    const edgs: Array<[number, number]> = [[v0, w0]];
    // Trace back from v to base.
    let v = v0;
    while (bv !== bb) {
      parent[bv] = b;
      path.push(bv);
      edgs.push([labelEdgeV[bv]!, labelEdgeW[bv]!]);
      v = labelEdgeV[bv]!;
      bv = inblossom[v]!;
    }
    path.push(bb);
    path.reverse();
    edgs.reverse();
    // Trace back from w to base.
    let w = w0;
    while (bw !== bb) {
      parent[bw] = b;
      path.push(bw);
      edgs.push([labelEdgeW[bw]!, labelEdgeV[bw]!]);
      w = labelEdgeV[bw]!;
      bw = inblossom[w]!;
    }
    childs[b] = path;
    bEdges[b] = edgs;
    label[b] = 1;
    labelEdgeV[b] = labelEdgeV[bb]!;
    labelEdgeW[b] = labelEdgeW[bb]!;
    bDual[b] = 0;
    // Relabel vertices.
    forEachLeaf(b, (x) => {
      if (label[inblossom[x]!] === 2) queue.push(x);
      inblossom[x] = b;
    });
    // Compute bestedge for the new blossom.
    const bestEdgeTo = new Map<number, number>();
    const examineEdge = (e: number): void => {
      let j = edgeW[e]!;
      if (inblossom[j] === b) {
        j = edgeV[e]!;
      }
      const bj = inblossom[j]!;
      if (bj !== b && label[bj] === 1) {
        const prev = bestEdgeTo.get(bj);
        if (prev === undefined || slack(e) < slack(prev)) bestEdgeTo.set(bj, e);
      }
    };
    for (const bx of path) {
      if (isBlossom[bx]!) {
        const cached = myBestEdges[bx]!;
        if (cached !== null) {
          for (const e of cached) examineEdge(e);
        } else {
          forEachLeaf(bx, (x) => {
            for (const e of adj[x]!) examineEdge(e);
          });
        }
        myBestEdges[bx] = null;
      } else {
        for (const e of adj[bx]!) examineEdge(e);
      }
      bestEdgeId[bx] = NONE;
    }
    const bestList = [...bestEdgeTo.values()];
    myBestEdges[b] = bestList;
    let bestE = NONE;
    for (const e of bestList) {
      if (bestE === NONE || slack(e) < slack(bestE)) bestE = e;
    }
    if (bestE !== NONE) {
      bestEdgeId[b] = bestE;
      bestEdgeFrom[b] = inblossom[edgeV[bestE]!] === b ? edgeV[bestE]! : edgeW[bestE]!;
    }
  }

  function expandBlossom(b: number, endstage: boolean): void {
    const chs = childs[b]!;
    const eds = bEdges[b]!;
    const len = chs.length;
    const idx = (i: number): number => ((i % len) + len) % len;
    for (const s of chs) {
      parent[s] = NONE;
      if (isBlossom[s]!) {
        if (endstage && bDual[s] === 0) {
          expandBlossom(s, endstage);
        } else {
          forEachLeaf(s, (x) => {
            inblossom[x] = s;
          });
        }
      } else {
        inblossom[s] = s;
      }
    }
    if (!endstage && label[b] === 2) {
      const entryChild = inblossom[labelEdgeW[b]!]!;
      let j = chs.indexOf(entryChild);
      let jstep: number;
      if ((j & 1) !== 0) {
        j -= len;
        jstep = 1;
      } else {
        jstep = -1;
      }
      let v = labelEdgeV[b]!;
      let w = labelEdgeW[b]!;
      while (j !== 0) {
        let p: number;
        let q: number;
        if (jstep === 1) {
          [p, q] = eds[idx(j)]!;
        } else {
          [q, p] = eds[idx(j - 1)]!;
        }
        label[w] = 0;
        label[q] = 0;
        assignLabel(w, 2, v);
        allowedge[edgeIdOf(p, q)] = true;
        j += jstep;
        if (jstep === 1) {
          [v, w] = eds[idx(j)]!;
        } else {
          [w, v] = eds[idx(j - 1)]!;
        }
        allowedge[edgeIdOf(v, w)] = true;
        j += jstep;
      }
      const bw = chs[idx(j)]!;
      label[w] = 2;
      label[bw] = 2;
      labelEdgeV[w] = v;
      labelEdgeW[w] = w;
      labelEdgeV[bw] = v;
      labelEdgeW[bw] = w;
      bestEdgeId[bw] = NONE;
      j += jstep;
      while (chs[idx(j)] !== entryChild) {
        const bv = chs[idx(j)]!;
        if (label[bv] === 1) {
          j += jstep;
          continue;
        }
        let vtx = NONE;
        if (isBlossom[bv]!) {
          forEachLeaf(bv, (x) => {
            if (vtx === NONE && label[x] !== 0) vtx = x;
          });
        } else {
          vtx = bv;
        }
        if (vtx !== NONE && label[vtx] !== 0) {
          const from = labelEdgeV[vtx]!;
          label[vtx] = 0;
          label[bv] = 0;
          assignLabel(vtx, 2, from);
        }
        j += jstep;
      }
    }
    label[b] = 0;
    labelEdgeV[b] = NONE;
    labelEdgeW[b] = NONE;
    bestEdgeId[b] = NONE;
    parent[b] = NONE;
    isBlossom[b] = false;
    bDual[b] = 0;
  }

  function augmentBlossom(b: number, v: number): void {
    let t = v;
    while (parent[t] !== b) t = parent[t]!;
    if (isBlossom[t]!) augmentBlossom(t, v);
    const chs = childs[b]!;
    const eds = bEdges[b]!;
    const len = chs.length;
    const idx = (i: number): number => ((i % len) + len) % len;
    const i = chs.indexOf(t);
    let j = i;
    let jstep: number;
    if ((i & 1) !== 0) {
      j -= len;
      jstep = 1;
    } else {
      jstep = -1;
    }
    while (j !== 0) {
      j += jstep;
      t = chs[idx(j)]!;
      let w: number;
      let x: number;
      if (jstep === 1) {
        [w, x] = eds[idx(j)]!;
      } else {
        [x, w] = eds[idx(j - 1)]!;
      }
      if (isBlossom[t]!) augmentBlossom(t, w);
      j += jstep;
      t = chs[idx(j)]!;
      if (isBlossom[t]!) augmentBlossom(t, x);
      mate[w] = x;
      mate[x] = w;
    }
    const nc = chs.slice(i).concat(chs.slice(0, i));
    const ne = eds.slice(i).concat(eds.slice(0, i));
    childs[b] = nc;
    bEdges[b] = ne;
    base[b] = base[nc[0]!]!;
  }

  function augmentMatching(v0: number, w0: number): void {
    const starts: Array<[number, number]> = [
      [v0, w0],
      [w0, v0],
    ];
    for (const [s0, j0] of starts) {
      let s = s0;
      let j = j0;
      for (;;) {
        const bs = inblossom[s]!;
        if (isBlossom[bs]!) augmentBlossom(bs, s);
        mate[s] = j;
        if (labelEdgeV[bs] === NONE) break;
        const t = labelEdgeV[bs]!;
        const bt = inblossom[t]!;
        const ns = labelEdgeV[bt]!;
        const nj = labelEdgeW[bt]!;
        if (isBlossom[bt]!) augmentBlossom(bt, nj);
        mate[nj] = ns;
        s = ns;
        j = nj;
      }
    }
  }

  // Main loop: each stage finds one augmenting path.
  for (let t = 0; t < n; t++) {
    label.fill(0);
    labelEdgeV.fill(NONE);
    labelEdgeW.fill(NONE);
    bestEdgeId.fill(NONE);
    bestEdgeFrom.fill(NONE);
    for (let b = n; b < myBestEdges.length; b++) myBestEdges[b] = null;
    allowedge.fill(false);
    queue.length = 0;

    // Label all exposed vertices with S.
    for (let v = 0; v < n; v++) {
      if (mate[v] === -1 && label[inblossom[v]!] === 0) assignLabel(v, 1, NONE);
    }

    let augmented = false;
    for (;;) {
      // Substage: scan the equality graph.
      while (queue.length > 0 && !augmented) {
        const v = queue.pop()!;
        for (const e of adj[v]!) {
          const w = edgeV[e] === v ? edgeW[e]! : edgeV[e]!;
          if (w === v) continue;
          const bv = inblossom[v]!;
          const bw = inblossom[w]!;
          if (bv === bw) continue;
          let kslack = 0;
          if (!allowedge[e]) {
            kslack = slack(e);
            if (kslack <= 0) allowedge[e] = true;
          }
          if (allowedge[e]) {
            if (label[bw] === 0) {
              assignLabel(w, 2, v);
            } else if (label[bw] === 1) {
              const bbase = scanBlossom(v, w);
              if (bbase !== NONE) {
                addBlossom(bbase, v, w);
              } else {
                augmentMatching(v, w);
                augmented = true;
                break;
              }
            } else if (label[w] === 0) {
              label[w] = 2;
              labelEdgeV[w] = v;
              labelEdgeW[w] = w;
            }
          } else if (label[bw] === 1) {
            if (bestEdgeId[bv] === NONE || kslack < slack(bestEdgeId[bv]!)) {
              bestEdgeId[bv] = e;
              bestEdgeFrom[bv] = v;
            }
          } else if (label[w] === 0) {
            if (bestEdgeId[w] === NONE || kslack < slack(bestEdgeId[w]!)) {
              bestEdgeId[w] = e;
              bestEdgeFrom[w] = v;
            }
          }
        }
      }
      if (augmented) break;

      // Compute delta.
      let deltatype = -1;
      let delta = 0;
      let deltaEdge = NONE;
      let deltaEdgeFrom = NONE;
      let deltaBlossom = NONE;
      // Delta2: min slack on any edge between an S-vertex and a free vertex.
      for (let v = 0; v < n; v++) {
        if (label[inblossom[v]!] === 0 && bestEdgeId[v] !== NONE) {
          const d = slack(bestEdgeId[v]!);
          if (deltatype === -1 || d < delta) {
            delta = d;
            deltatype = 2;
            deltaEdge = bestEdgeId[v]!;
            deltaEdgeFrom = bestEdgeFrom[v]!;
          }
        }
      }
      // Delta3: half min slack on any edge between two S-blossoms.
      for (let b = 0; b < label.length; b++) {
        if (
          (b < n || isBlossom[b]!) &&
          parent[b] === NONE &&
          label[b] === 1 &&
          bestEdgeId[b] !== NONE
        ) {
          const d = Math.floor(slack(bestEdgeId[b]!) / 2);
          if (deltatype === -1 || d < delta) {
            delta = d;
            deltatype = 3;
            deltaEdge = bestEdgeId[b]!;
            deltaEdgeFrom = bestEdgeFrom[b]!;
          }
        }
      }
      // Delta4: min z variable of any T-blossom.
      for (let b = n; b < label.length; b++) {
        if (isBlossom[b]! && parent[b] === NONE && label[b] === 2) {
          if (deltatype === -1 || bDual[b]! < delta) {
            delta = bDual[b]!;
            deltatype = 4;
            deltaBlossom = b;
          }
        }
      }
      if (deltatype === -1) {
        // No further improvement possible.
        deltatype = 1;
        delta = 0;
        for (let v = 0; v < n; v++) {
          if (dualvar[v]! < delta || v === 0) delta = Math.min(dualvar[v]!, delta);
        }
        delta = Math.max(0, delta);
      }
      // Update dual variables.
      for (let v = 0; v < n; v++) {
        const l = label[inblossom[v]!]!;
        if (l === 1) dualvar[v]! -= delta;
        else if (l === 2) dualvar[v]! += delta;
      }
      for (let b = n; b < label.length; b++) {
        if (isBlossom[b]! && parent[b] === NONE) {
          if (label[b] === 1) bDual[b]! += delta;
          else if (label[b] === 2) bDual[b]! -= delta;
        }
      }
      // Take action at the point where minimum delta occurred.
      if (deltatype === 1) {
        break;
      } else if (deltatype === 2 || deltatype === 3) {
        allowedge[deltaEdge] = true;
        queue.push(deltaEdgeFrom);
      } else {
        expandBlossom(deltaBlossom, false);
      }
    }
    // End of stage: expand all S-blossoms with zero dual.
    for (let b = n; b < label.length; b++) {
      if (
        isBlossom[b]! &&
        parent[b] === NONE &&
        label[b] === 1 &&
        bDual[b] === 0
      ) {
        expandBlossom(b, true);
      }
    }
    if (!augmented) break;
  }

  return mate;
}
