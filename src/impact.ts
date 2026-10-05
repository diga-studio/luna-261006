import type { ArtifactId, ImpactResult } from "./types";
import type { BaselineGraph } from "./graph";

/**
 * Iterative DFS over directed links from one requirement. Collects each
 * reachable artifact once, never follows links backwards, and excludes
 * the start requirement from the result.
 */
export function queryImpactOnGraph(
  graph: BaselineGraph,
  requirementId: ArtifactId,
): ImpactResult {
  const innerCount = graph.reqCount + graph.designCount;
  const { offsets, targets, testOffsets, testTargets } = graph;

  const start = graph.requirementIndexById.get(requirementId);
  if (start === undefined || start >= graph.reqCount) {
    throw new Error(`unknown requirement: ${requirementId}`);
  }

  const visited = new Uint8Array(innerCount);
  const visitedTest = new Uint8Array(graph.testCount);
  const requirementIds: ArtifactId[] = [];
  const designItemIds: ArtifactId[] = [];
  const testCaseIds: ArtifactId[] = [];

  const stack: number[] = [start];
  visited[start] = 1;
  while (stack.length > 0) {
    const node = stack.pop() as number;
    for (let t = testOffsets[node]; t < testOffsets[node + 1]; t++) {
      const test = testTargets[t];
      if (visitedTest[test] === 0) {
        visitedTest[test] = 1;
        testCaseIds.push(graph.testCaseIds[test]);
      }
    }
    for (let e = offsets[node]; e < offsets[node + 1]; e++) {
      const succ = targets[e];
      if (visited[succ] === 1) continue;
      visited[succ] = 1;
      if (succ < graph.reqCount) {
        requirementIds.push(graph.requirementIds[succ]);
      } else {
        designItemIds.push(graph.designItemIds[succ - graph.reqCount]);
      }
      stack.push(succ);
    }
  }

  return { requirementId, requirementIds, designItemIds, testCaseIds };
}
