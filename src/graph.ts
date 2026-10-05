import { ArtifactKind, type Baseline } from "./types.js";

/**
 * Indexed, analysis-ready view of a frozen baseline.
 * Nodes are numbered: [0, reqCount) requirements,
 * [reqCount, reqCount+designCount) design items,
 * [reqCount+designCount, nodeCount) test cases.
 * Edges are stored as deduplicated CSR adjacency in the downstream direction.
 */
export interface FrozenGraph {
  reqCount: number;
  designCount: number;
  testCount: number;
  nodeCount: number;
  /** node index -> artifact id */
  nodeIds: string[];
  /** artifact id -> node index */
  indexOf: Map<string, number>;
  /** CSR adjacency over all nodes (downstream direction). */
  adjStart: Uint32Array;
  adjTargets: Uint32Array;
  /** Test node index -> 0=passed 1=failed 2=not_executed. 0 for non-tests. */
  verdictOf: Uint8Array;
}

const VERDICT_CODE = { passed: 0, failed: 1, not_executed: 2 } as const;

/** Build the indexed graph from a baseline. Throws on invalid input. */
export function buildGraph(baseline: Baseline): FrozenGraph {
  const reqCount = baseline.requirements.length;
  const designCount = baseline.designItems.length;
  const testCount = baseline.testCases.length;
  const nodeCount = reqCount + designCount + testCount;

  const nodeIds = new Array<string>(nodeCount);
  const indexOf = new Map<string, number>();
  const verdictOf = new Uint8Array(nodeCount);

  const addId = (id: string, index: number): void => {
    if (indexOf.has(id)) {
      throw new Error(`duplicate artifact id: ${id}`);
    }
    indexOf.set(id, index);
    nodeIds[index] = id;
  };

  for (let i = 0; i < reqCount; i++) addId(baseline.requirements[i].id, i);
  for (let i = 0; i < designCount; i++) {
    addId(baseline.designItems[i].id, reqCount + i);
  }
  for (let i = 0; i < testCount; i++) {
    const tc = baseline.testCases[i];
    const idx = reqCount + designCount + i;
    addId(tc.id, idx);
    verdictOf[idx] = VERDICT_CODE[tc.verdict];
  }

  const kindOf = (idx: number): ArtifactKind =>
    idx < reqCount
      ? ArtifactKind.Requirement
      : idx < reqCount + designCount
        ? ArtifactKind.DesignItem
        : ArtifactKind.TestCase;

  // Validate and deduplicate links.
  const seen = new Set<number>();
  const edgeFrom = new Array<number>(baseline.links.length);
  const edgeTo = new Array<number>(baseline.links.length);
  let edgeCount = 0;
  for (const link of baseline.links) {
    const from = indexOf.get(link.from);
    const to = indexOf.get(link.to);
    if (from === undefined) throw new Error(`link from unknown id: ${link.from}`);
    if (to === undefined) throw new Error(`link to unknown id: ${link.to}`);
    const fromKind = kindOf(from);
    const toKind = kindOf(to);
    if (fromKind === ArtifactKind.TestCase) {
      throw new Error(`test case ${link.from} must not have outgoing links`);
    }
    if (toKind === ArtifactKind.Requirement && fromKind !== ArtifactKind.Requirement) {
      throw new Error(`only requirements may link to requirements (${link.from} -> ${link.to})`);
    }
    const key = from * nodeCount + to;
    if (seen.has(key)) continue;
    seen.add(key);
    edgeFrom[edgeCount] = from;
    edgeTo[edgeCount] = to;
    edgeCount++;
  }

  // CSR build.
  const adjStart = new Uint32Array(nodeCount + 1);
  for (let e = 0; e < edgeCount; e++) adjStart[edgeFrom[e] + 1]++;
  for (let n = 0; n < nodeCount; n++) adjStart[n + 1] += adjStart[n];
  const adjTargets = new Uint32Array(edgeCount);
  const cursor = adjStart.slice(0, nodeCount);
  for (let e = 0; e < edgeCount; e++) {
    adjTargets[cursor[edgeFrom[e]]++] = edgeTo[e];
  }

  return {
    reqCount,
    designCount,
    testCount,
    nodeCount,
    nodeIds,
    indexOf,
    adjStart,
    adjTargets,
    verdictOf,
  };
}
