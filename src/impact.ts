import type { FrozenGraph } from "./graph.js";
import type { ImpactScope } from "./types.js";

/**
 * Downstream impact scope of one requirement: every artifact reachable by
 * following directed links, each listed once, excluding the start node.
 * Reverse-only connections are never traversed.
 */
export function computeImpactScope(graph: FrozenGraph, requirementId: string): ImpactScope {
  const start = graph.indexOf.get(requirementId);
  if (start === undefined || start >= graph.reqCount) {
    throw new Error(`unknown requirement id: ${requirementId}`);
  }

  const { reqCount, designCount, adjStart, adjTargets, nodeIds } = graph;
  const visited = new Uint8Array(graph.nodeCount);
  visited[start] = 1;
  const queue: number[] = [start];
  const subRequirements: string[] = [];
  const designItems: string[] = [];
  const testCases: string[] = [];

  for (let head = 0; head < queue.length; head++) {
    const node = queue[head];
    for (let e = adjStart[node]; e < adjStart[node + 1]; e++) {
      const t = adjTargets[e];
      if (visited[t] === 1) continue;
      visited[t] = 1;
      queue.push(t);
      if (t < reqCount) subRequirements.push(nodeIds[t]);
      else if (t < reqCount + designCount) designItems.push(nodeIds[t]);
      else testCases.push(nodeIds[t]);
    }
  }

  return { requirementId, subRequirements, designItems, testCases };
}
