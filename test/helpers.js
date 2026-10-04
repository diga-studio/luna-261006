// Independent brute-force solver used to cross-check the library output.
// Enumerates every legal parent assignment and returns the optimal
// (rootCount, totalCost, parentSequence) triple plus the parent map.

export function bruteForceOptimum(graph) {
  const nodes = [...graph.nodes].sort((a, b) => a.id - b.id);
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const candidates = new Map();
  for (const node of nodes) {
    const cands = new Set([0]);
    for (const e of graph.edges) {
      if (e.to === node.id && e.from !== node.id) cands.add(e.from);
    }
    candidates.set(node.id, [...cands].sort((a, b) => a - b));
  }

  const parent = new Array(nodes.length).fill(0);
  let best = null;

  const acyclic = () => {
    for (let i = 0; i < nodes.length; i++) {
      const seen = new Set();
      let cur = i;
      while (parent[cur] !== 0) {
        const p = parent[cur];
        if (seen.has(p)) return false;
        seen.add(p);
        cur = nodes.findIndex((n) => n.id === p);
      }
    }
    return true;
  };

  const consider = () => {
    if (!acyclic()) return;
    let roots = 0;
    let cost = 0;
    for (let i = 0; i < nodes.length; i++) {
      if (parent[i] === 0) {
        roots++;
      } else {
        const a = byId.get(parent[i]);
        const b = nodes[i];
        cost += Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
      }
    }
    const key = [roots, cost, ...parent];
    if (best === null || compareKey(key, best.key) < 0) {
      best = { key, roots, cost, parent: [...parent] };
    }
  };

  const dfs = (i) => {
    if (i === nodes.length) {
      consider();
      return;
    }
    for (const p of candidates.get(nodes[i].id)) {
      parent[i] = p;
      dfs(i + 1);
    }
    parent[i] = 0;
  };
  dfs(0);
  return { best, nodes };
}

function compareKey(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

// Walks the exported hierarchy and reconstructs nodes and edges.
export function reconstruct(result) {
  const nodeIds = [];
  const edgeSet = new Set();
  const visit = (entry) => {
    nodeIds.push(entry.nodeId);
    if (entry.parentId !== 0) edgeSet.add(`${entry.parentId}->${entry.nodeId}`);
    for (const ref of entry.references) {
      edgeSet.add(`${entry.nodeId}->${ref.targetId}`);
    }
    for (const child of entry.children) visit(child);
  };
  for (const root of result.roots) visit(root);
  return { nodeIds, edgeSet };
}

// Deterministic PRNG (mulberry32) for reproducible shuffles.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled(array, rand) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
