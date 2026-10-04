/** A weighted directed edge used by the arborescence solver. */
export interface WeightedEdge {
  from: number;
  to: number;
  weight: number;
}

/**
 * Chu-Liu/Edmonds minimum spanning arborescence rooted at `root`.
 * Returns the minimum total weight. Node indices are 0..nodeCount-1.
 * Throws when no spanning arborescence exists.
 */
export function minArborescenceWeight(
  nodeCount: number,
  root: number,
  edges: WeightedEdge[]
): number {
  let total = 0;
  let currentEdges = edges;
  let n = nodeCount;
  let r = root;

  const inWeight: number[] = new Array<number>(nodeCount);
  const pre: number[] = new Array<number>(nodeCount);
  const component: number[] = new Array<number>(nodeCount);
  const visited: number[] = new Array<number>(nodeCount);

  for (;;) {
    inWeight.fill(Number.POSITIVE_INFINITY);
    pre.fill(-1);
    component.fill(-1);
    visited.fill(-1);

    for (const edge of currentEdges) {
      if (edge.from !== edge.to && edge.weight < inWeight[edge.to]!) {
        inWeight[edge.to] = edge.weight;
        pre[edge.to] = edge.from;
      }
    }
    inWeight[r] = 0;

    for (let i = 0; i < n; i++) {
      if (inWeight[i] === Number.POSITIVE_INFINITY) {
        throw new Error("no spanning arborescence exists");
      }
    }

    let componentCount = 0;
    for (let i = 0; i < n; i++) {
      total += inWeight[i]!;
      let v = i;
      while (visited[v] !== i && component[v] === -1 && v !== r) {
        visited[v] = i;
        v = pre[v]!;
      }
      if (v !== r && component[v] === -1) {
        for (let u = pre[v]!; u !== v; u = pre[u]!) {
          component[u] = componentCount;
        }
        component[v] = componentCount;
        componentCount++;
      }
    }
    if (componentCount === 0) {
      break;
    }

    for (let i = 0; i < n; i++) {
      if (component[i] === -1) {
        component[i] = componentCount++;
      }
    }
    const contracted: WeightedEdge[] = [];
    for (const edge of currentEdges) {
      const u = component[edge.from]!;
      const v = component[edge.to]!;
      if (u !== v) {
        contracted.push({ from: u, to: v, weight: edge.weight - inWeight[edge.to]! });
      }
    }
    r = component[r]!;
    n = componentCount;
    currentEdges = contracted;
  }

  return total;
}
