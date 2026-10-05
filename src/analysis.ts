import type { AnalysisResult, BaselineSummary, RequirementCoverage } from "./types";
import type { BaselineGraph } from "./graph";

const POPCOUNT16 = (() => {
  const table = new Uint8Array(1 << 16);
  for (let i = 1; i < table.length; i++) {
    table[i] = table[i >> 1] + (i & 1);
  }
  return table;
})();

function popcountWord(word: number): number {
  return POPCOUNT16[word & 0xffff] + POPCOUNT16[word >>> 16];
}

/**
 * Computes per-requirement coverage and the baseline summary.
 *
 * Reachability is resolved over the condensation of the requirement/
 * design graph (design cycles collapse into SCCs), with reachable test
 * sets represented as bitsets so shared subgraphs are processed once.
 * Tarjan emits components sinks-first, so when a component is finalized
 * every component it can reach already has its final test bitset.
 */
export function analyzeGraph(graph: BaselineGraph): AnalysisResult {
  const innerCount = graph.reqCount + graph.designCount;
  const testWords = graph.testWords;
  const { offsets, targets, testOffsets, testTargets, passedMask } = graph;

  const sccOf = new Int32Array(innerCount).fill(-1);
  const lowlink = new Int32Array(innerCount);
  const dfsIndex = new Int32Array(innerCount).fill(-1);
  const tarjanStack = new Int32Array(innerCount);
  const onStack = new Uint8Array(innerCount);
  let stackSize = 0;
  let nextIndex = 0;
  let sccCount = 0;

  // One shared test bitset row per SCC.
  const sccRows = new Uint32Array(Math.max(innerCount, 1) * Math.max(testWords, 1));
  const members = new Int32Array(innerCount);

  const callNode = new Int32Array(innerCount);
  const callEdge = new Uint32Array(innerCount);
  let callDepth = 0;

  for (let root = 0; root < innerCount; root++) {
    if (dfsIndex[root] !== -1) continue;
    callNode[0] = root;
    callEdge[0] = offsets[root];
    callDepth = 1;
    dfsIndex[root] = lowlink[root] = nextIndex++;
    tarjanStack[stackSize++] = root;
    onStack[root] = 1;

    while (callDepth > 0) {
      const node = callNode[callDepth - 1];
      let descended = false;
      const end = offsets[node + 1];
      while (callEdge[callDepth - 1] < end) {
        const edge = callEdge[callDepth - 1]++;
        const succ = targets[edge];
        if (dfsIndex[succ] === -1) {
          dfsIndex[succ] = lowlink[succ] = nextIndex++;
          tarjanStack[stackSize++] = succ;
          onStack[succ] = 1;
          callNode[callDepth] = succ;
          callEdge[callDepth] = offsets[succ];
          callDepth++;
          descended = true;
          break;
        }
        if (onStack[succ] === 1 && dfsIndex[succ] < lowlink[node]) {
          lowlink[node] = dfsIndex[succ];
        }
      }
      if (descended) continue;

      callDepth--;
      if (callDepth > 0) {
        const parent = callNode[callDepth - 1];
        if (lowlink[node] < lowlink[parent]) {
          lowlink[parent] = lowlink[node];
        }
      }

      if (lowlink[node] !== dfsIndex[node]) continue;

      // Finalize one SCC: pop its members, then build the shared bitset.
      const sccId = sccCount++;
      const rowBase = sccId * testWords;
      let memberCount = 0;
      let member: number;
      do {
        member = tarjanStack[--stackSize];
        onStack[member] = 0;
        sccOf[member] = sccId;
        members[memberCount++] = member;
      } while (member !== node);

      for (let m = 0; m < memberCount; m++) {
        const from = members[m];
        for (let t = testOffsets[from]; t < testOffsets[from + 1]; t++) {
          const test = testTargets[t];
          sccRows[rowBase + (test >>> 5)] |= 1 << (test & 31);
        }
      }
      // Successor SCCs are already finalized (sinks-first emission), and
      // no member can point at a non-member still on the Tarjan stack.
      for (let m = 0; m < memberCount; m++) {
        const from = members[m];
        for (let e = offsets[from]; e < offsets[from + 1]; e++) {
          const succScc = sccOf[targets[e]];
          if (succScc === sccId) continue;
          const succBase = succScc * testWords;
          for (let w = 0; w < testWords; w++) {
            sccRows[rowBase + w] |= sccRows[succBase + w];
          }
        }
      }
    }
  }

  // Per-requirement coverage.
  const requirements: RequirementCoverage[] = new Array(graph.reqCount);
  const unionRow = new Uint32Array(testWords);
  let requirementsWithTests = 0;
  for (let r = 0; r < graph.reqCount; r++) {
    const rowBase = sccOf[r] * testWords;
    let reachable = 0;
    let passed = 0;
    for (let w = 0; w < testWords; w++) {
      const word = sccRows[rowBase + w];
      unionRow[w] |= word;
      reachable += popcountWord(word);
      passed += popcountWord(word & passedMask[w]);
    }
    if (reachable > 0) requirementsWithTests++;
    requirements[r] = {
      requirementId: graph.requirementIds[r],
      reachableTestCount: reachable,
      passedTestCount: passed,
      passRate: reachable > 0 ? passed / reachable : null,
      isTraceabilityGap: reachable === 0,
    };
  }

  let tracedTestCount = 0;
  let tracedPassedCount = 0;
  for (let w = 0; w < testWords; w++) {
    tracedTestCount += popcountWord(unionRow[w]);
    tracedPassedCount += popcountWord(unionRow[w] & passedMask[w]);
  }

  const summary: BaselineSummary = {
    requirementCount: graph.reqCount,
    requirementsWithTests,
    requirementCoverageRatio:
      graph.reqCount > 0 ? requirementsWithTests / graph.reqCount : null,
    tracedTestCount,
    tracedPassedCount,
    overallPassRate: tracedTestCount > 0 ? tracedPassedCount / tracedTestCount : null,
  };

  return { requirements, summary };
}
