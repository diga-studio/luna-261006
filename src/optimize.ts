import { minArborescenceWeight } from "./edmonds";
import type { CanvasGraph } from "./types";

/**
 * Computes the optimal parent assignment:
 * 1. fewest top-level entries, 2. lowest total spatial cost,
 * 3. lexicographically smallest parent-id sequence (ids ascending, 0 = top-level).
 * Returns a map from node id to parent node id (0 = top-level).
 */
export function computeParents(graph: CanvasGraph): Map<number, number> {
  const nodeIds = graph.nodes.map((node) => node.id).sort((a, b) => a - b);
  const indexOf = new Map<number, number>();
  nodeIds.forEach((id, position) => indexOf.set(id, position + 1));
  const nodeCount = nodeIds.length;

  const coordOf = new Map<number, { x: number; y: number }>();
  for (const node of graph.nodes) {
    coordOf.set(node.id, { x: node.x, y: node.y });
  }
  const costOf = (fromId: number, toId: number): number => {
    const a = coordOf.get(fromId)!;
    const b = coordOf.get(toId)!;
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  };

  let totalEdgeCost = 0;
  for (const edge of graph.edges) {
    totalEdgeCost += costOf(edge.from, edge.to);
  }
  // Root edges dominate: one extra root always costs more than any parent-edge total.
  const rootWeight = totalEdgeCost + 1;

  // Incoming candidates per node index; index 0 is the virtual super-root.
  const incoming: { from: number; weight: number }[][] = [];
  for (let i = 0; i <= nodeCount; i++) {
    incoming.push([]);
  }
  for (let i = 1; i <= nodeCount; i++) {
    incoming[i]!.push({ from: 0, weight: rootWeight });
  }
  for (const edge of graph.edges) {
    if (edge.from === edge.to) {
      continue; // self-loops can never be parent-child links
    }
    incoming[indexOf.get(edge.to)!]!.push({
      from: indexOf.get(edge.from)!,
      weight: costOf(edge.from, edge.to),
    });
  }

  const weightWith = (fixed: ReadonlyMap<number, number>): number => {
    const edges: { from: number; to: number; weight: number }[] = [];
    for (let i = 1; i <= nodeCount; i++) {
      const forced = fixed.get(i);
      for (const candidate of incoming[i]!) {
        if (forced === undefined || candidate.from === forced) {
          edges.push({ from: candidate.from, to: i, weight: candidate.weight });
        }
      }
    }
    return minArborescenceWeight(nodeCount + 1, 0, edges);
  };

  const optimalWeight = weightWith(new Map());

  // Lexicographic refinement over the parent-id sequence (node ids ascending,
  // 0 = top-level sorts first): fix each node to the smallest parent value
  // that still admits an optimal completion.
  const fixed = new Map<number, number>();
  const parents = new Map<number, number>();
  for (const nodeId of nodeIds) {
    const nodeIndex = indexOf.get(nodeId)!;
    const candidates = incoming[nodeIndex]!
      .map((candidate) => candidate.from)
      .sort((a, b) => a - b);
    for (const fromIndex of candidates) {
      fixed.set(nodeIndex, fromIndex);
      if (weightWith(fixed) === optimalWeight) {
        parents.set(nodeId, fromIndex === 0 ? 0 : nodeIds[fromIndex - 1]!);
        break;
      }
    }
    if (!parents.has(nodeId)) {
      throw new Error("internal error: no feasible parent candidate");
    }
  }

  return parents;
}
