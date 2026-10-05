import type { FrozenGraph } from "./graph.js";
import type { BaselineSummary, RequirementCoverage } from "./types.js";

export interface CoverageAnalysis {
  coverage: RequirementCoverage[];
  summary: BaselineSummary;
}

const POPCOUNT8 = (() => {
  const table = new Uint8Array(256);
  for (let i = 1; i < 256; i++) table[i] = table[i >> 1] + (i & 1);
  return table;
})();

function popcount32(word: number): number {
  return (
    POPCOUNT8[word & 0xff] +
    POPCOUNT8[(word >>> 8) & 0xff] +
    POPCOUNT8[(word >>> 16) & 0xff] +
    POPCOUNT8[(word >>> 24) & 0xff]
  );
}

/**
 * Iterative Tarjan SCC over the design-item subgraph.
 * Returns scc id per design node (local index); ids are emitted in
 * reverse topological order of the condensation.
 */
function designSccs(graph: FrozenGraph): { sccOf: Int32Array; sccCount: number } {
  const { reqCount, designCount, adjStart, adjTargets } = graph;
  const dEnd = reqCount + designCount;
  const index = new Int32Array(designCount).fill(-1);
  const low = new Int32Array(designCount);
  const onStack = new Uint8Array(designCount);
  const sccOf = new Int32Array(designCount).fill(-1);
  const stack: number[] = [];
  let nextIndex = 0;
  let sccCount = 0;

  const callStack: number[] = [];
  const edgeCursor: number[] = [];

  for (let start = 0; start < designCount; start++) {
    if (index[start] !== -1) continue;
    callStack.push(start);
    edgeCursor.push(adjStart[reqCount + start]);
    index[start] = low[start] = nextIndex++;
    stack.push(start);
    onStack[start] = 1;

    while (callStack.length > 0) {
      const v = callStack[callStack.length - 1];
      const globalV = reqCount + v;
      let advanced = false;
      const end = adjStart[globalV + 1];
      let cursor = edgeCursor[edgeCursor.length - 1];
      while (cursor < end) {
        const t = adjTargets[cursor];
        cursor++;
        if (t < reqCount || t >= dEnd) continue; // only design->design edges
        const w = t - reqCount;
        if (index[w] === -1) {
          // Save the parent's cursor BEFORE pushing the child's frame.
          edgeCursor[edgeCursor.length - 1] = cursor;
          index[w] = low[w] = nextIndex++;
          stack.push(w);
          onStack[w] = 1;
          callStack.push(w);
          edgeCursor.push(adjStart[t]);
          advanced = true;
          break;
        }
        if (onStack[w] === 1 && index[w] < low[v]) low[v] = index[w];
      }
      if (advanced) continue;

      // Done exploring v.
      callStack.pop();
      edgeCursor.pop();
      if (low[v] === index[v]) {
        for (;;) {
          const w = stack.pop() as number;
          onStack[w] = 0;
          sccOf[w] = sccCount;
          if (w === v) break;
        }
        sccCount++;
      }
      if (callStack.length > 0) {
        const parent = callStack[callStack.length - 1];
        if (low[v] < low[parent]) low[parent] = low[v];
      }
    }
  }
  return { sccOf, sccCount };
}

/**
 * Compute per-requirement coverage and the baseline summary in one pass.
 *
 * The condensation of the trace graph is a DAG (sub-requirement links are
 * acyclic; design cycles are collapsed into SCCs). Components are processed
 * children-first; each component's reachable-test set is the union of its
 * direct test links and its children's sets, so shared subgraphs are
 * computed once and overlaps can never be double counted.
 */
export function analyzeCoverage(graph: FrozenGraph): CoverageAnalysis {
  const { reqCount, designCount, testCount, nodeCount, adjStart, adjTargets, verdictOf } =
    graph;
  const words = Math.max(1, (testCount + 31) >>> 5);

  const { sccOf, sccCount } = designSccs(graph);
  const compCount = reqCount + sccCount;
  // Component id of any non-test node.
  const compOfNode = (node: number): number =>
    node < reqCount ? node : reqCount + sccOf[node - reqCount];

  // Condensation edges (deduplicated) + direct test links per component.
  const compEdgeFrom: number[] = [];
  const compEdgeTo: number[] = [];
  const direct = new Uint32Array(compCount * words);
  const seenEdge = new Set<number>();
  for (let n = 0; n < reqCount + designCount; n++) {
    const comp = compOfNode(n);
    const directBase = comp * words;
    for (let e = adjStart[n]; e < adjStart[n + 1]; e++) {
      const t = adjTargets[e];
      if (t >= reqCount + designCount) {
        direct[directBase + ((t - reqCount - designCount) >>> 5)] |=
          1 << ((t - reqCount - designCount) & 31);
      } else {
        const child = compOfNode(t);
        if (child === comp) continue;
        const key = comp * compCount + child;
        if (seenEdge.has(key)) continue;
        seenEdge.add(key);
        compEdgeFrom.push(comp);
        compEdgeTo.push(child);
      }
    }
  }

  // CSR for condensation edges.
  const compAdjStart = new Uint32Array(compCount + 1);
  for (let e = 0; e < compEdgeFrom.length; e++) compAdjStart[compEdgeFrom[e] + 1]++;
  for (let c = 0; c < compCount; c++) compAdjStart[c + 1] += compAdjStart[c];
  const compAdjTargets = new Uint32Array(compEdgeFrom.length);
  {
    const cursor = compAdjStart.slice(0, compCount);
    for (let e = 0; e < compEdgeFrom.length; e++) {
      compAdjTargets[cursor[compEdgeFrom[e]]++] = compEdgeTo[e];
    }
  }

  // Topological order of the condensation (Kahn), then process reversed so
  // children are finalized before their parents.
  const indegree = new Uint32Array(compCount);
  for (let e = 0; e < compEdgeTo.length; e++) indegree[compEdgeTo[e]]++;
  const topo = new Uint32Array(compCount);
  let topoLen = 0;
  const queue: number[] = [];
  for (let c = 0; c < compCount; c++) if (indegree[c] === 0) queue.push(c);
  while (queue.length > 0) {
    const c = queue.pop() as number;
    topo[topoLen++] = c;
    for (let e = compAdjStart[c]; e < compAdjStart[c + 1]; e++) {
      const child = compAdjTargets[e];
      if (--indegree[child] === 0) queue.push(child);
    }
  }
  if (topoLen !== compCount) {
    throw new Error("condensation graph has a cycle (sub-requirement cycle?)");
  }

  // Reachable-test bitsets per component, laid out in one flat buffer.
  const masks = new Uint32Array(compCount * words);
  for (let i = compCount - 1; i >= 0; i--) {
    const comp = topo[i];
    const base = comp * words;
    masks.set(direct.subarray(base, base + words), base);
    for (let e = compAdjStart[comp]; e < compAdjStart[comp + 1]; e++) {
      const childBase = compAdjTargets[e] * words;
      for (let w = 0; w < words; w++) masks[base + w] |= masks[childBase + w];
    }
  }

  // Passed-test mask.
  const passedMask = new Uint32Array(words);
  for (let t = 0; t < testCount; t++) {
    if (verdictOf[reqCount + designCount + t] === 0) {
      passedMask[t >>> 5] |= 1 << (t & 31);
    }
  }

  // Per-requirement coverage.
  const coverage = new Array<RequirementCoverage>(reqCount);
  const unionMask = new Uint32Array(words);
  let requirementsWithTests = 0;
  for (let r = 0; r < reqCount; r++) {
    const base = r * words;
    let reachable = 0;
    let passed = 0;
    for (let w = 0; w < words; w++) {
      const bits = masks[base + w];
      reachable += popcount32(bits);
      passed += popcount32(bits & passedMask[w]);
      unionMask[w] |= bits;
    }
    if (reachable > 0) requirementsWithTests++;
    coverage[r] = {
      requirementId: graph.nodeIds[r],
      reachableTests: reachable,
      passedTests: passed,
      passRate: reachable === 0 ? null : passed / reachable,
      isTraceabilityGap: reachable === 0,
    };
  }

  let tracedTests = 0;
  let tracedPassedTests = 0;
  for (let w = 0; w < words; w++) {
    tracedTests += popcount32(unionMask[w]);
    tracedPassedTests += popcount32(unionMask[w] & passedMask[w]);
  }

  const summary: BaselineSummary = {
    totalRequirements: reqCount,
    requirementsWithTests,
    requirementCoverageRatio: reqCount === 0 ? null : requirementsWithTests / reqCount,
    tracedTests,
    tracedPassedTests,
    baselinePassRate: tracedTests === 0 ? null : tracedPassedTests / tracedTests,
  };

  return { coverage, summary };
}
