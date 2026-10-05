import { TestVerdict } from "./types";
import type { ArtifactId, Baseline } from "./types";

/**
 * Internal indexed graph over a baseline.
 *
 * Node layout: [0, reqCount) requirements, [reqCount, reqCount+designCount)
 * design items, [reqCount+designCount, nodeCount) test cases.
 */
export interface BaselineGraph {
  readonly reqCount: number;
  readonly designCount: number;
  readonly testCount: number;
  readonly nodeCount: number;
  /** Requirement artifact ids, indexed by requirement node index. */
  readonly requirementIds: readonly ArtifactId[];
  /** Design item artifact ids, indexed by design node offset. */
  readonly designItemIds: readonly ArtifactId[];
  /** Test artifact ids, indexed by test node offset. */
  readonly testCaseIds: readonly ArtifactId[];
  /** Requirement id -> requirement node index. */
  readonly requirementIndexById: ReadonlyMap<ArtifactId, number>;
  /** Verdict bitset over tests: bit t set iff test t passed. */
  readonly passedMask: Uint32Array;
  /**
   * Compressed adjacency over requirement/design nodes only
   * (targets are requirement or design node indexes).
   */
  readonly offsets: Uint32Array;
  readonly targets: Uint32Array;
  /**
   * Direct requirement->test and design->test links as compressed rows
   * over requirement/design nodes (targets are test indexes).
   */
  readonly testOffsets: Uint32Array;
  readonly testTargets: Uint32Array;
  readonly testWords: number;
}

const KIND_REQUIREMENT = 0;
const KIND_DESIGN = 1;
const KIND_TEST = 2;

function kindOf(index: number, reqCount: number, designCount: number): number {
  if (index < reqCount) return KIND_REQUIREMENT;
  if (index < reqCount + designCount) return KIND_DESIGN;
  return KIND_TEST;
}

/**
 * Builds the indexed graph. Validates referential integrity and the
 * baseline contract (unique ids, no outgoing links from test cases,
 * design items never point to requirements); duplicate links are
 * tolerated and collapsed.
 */
export function buildGraph(baseline: Baseline): BaselineGraph {
  const reqCount = baseline.requirements.length;
  const designCount = baseline.designItems.length;
  const testCount = baseline.testCases.length;
  const nodeCount = reqCount + designCount + testCount;

  const indexById = new Map<ArtifactId, number>();
  const requirementIds: ArtifactId[] = new Array(reqCount);
  const designItemIds: ArtifactId[] = new Array(designCount);
  const testCaseIds: ArtifactId[] = new Array(testCount);

  const register = (id: ArtifactId, index: number): void => {
    if (indexById.has(id)) {
      throw new Error(`duplicate artifact id: ${id}`);
    }
    indexById.set(id, index);
  };
  for (let i = 0; i < reqCount; i++) {
    const id = baseline.requirements[i].id;
    register(id, i);
    requirementIds[i] = id;
  }
  for (let i = 0; i < designCount; i++) {
    const id = baseline.designItems[i].id;
    register(id, reqCount + i);
    designItemIds[i] = id;
  }
  for (let i = 0; i < testCount; i++) {
    const id = baseline.testCases[i].id;
    register(id, reqCount + designCount + i);
    testCaseIds[i] = id;
  }

  const testWords = (testCount + 31) >>> 5;
  const passedMask = new Uint32Array(testWords);
  for (let i = 0; i < testCount; i++) {
    const verdict = baseline.testCases[i].verdict;
    if (
      verdict !== TestVerdict.Passed &&
      verdict !== TestVerdict.Failed &&
      verdict !== TestVerdict.NotExecuted
    ) {
      throw new Error(`test case ${testCaseIds[i]} has unknown verdict: ${String(verdict)}`);
    }
    if (verdict === TestVerdict.Passed) {
      passedMask[i >>> 5] |= 1 << (i & 31);
    }
  }

  const innerCount = reqCount + designCount;
  // First pass: validate links and count out-edges.
  const outInner = new Uint32Array(innerCount);
  const outTest = new Uint32Array(innerCount);
  const resolved = new Int32Array(baseline.links.length);
  for (let i = 0; i < baseline.links.length; i++) {
    const link = baseline.links[i];
    const from = indexById.get(link.fromId);
    const to = indexById.get(link.toId);
    if (from === undefined) {
      throw new Error(`link references unknown artifact: ${link.fromId}`);
    }
    if (to === undefined) {
      throw new Error(`link references unknown artifact: ${link.toId}`);
    }
    const fromKind = kindOf(from, reqCount, designCount);
    const toKind = kindOf(to, reqCount, designCount);
    if (fromKind === KIND_TEST) {
      throw new Error(`test case ${link.fromId} must not have outgoing links`);
    }
    if (fromKind === KIND_DESIGN && toKind === KIND_REQUIREMENT) {
      throw new Error(`design item ${link.fromId} must not link to requirement ${link.toId}`);
    }
    resolved[i] = to;
    if (toKind === KIND_TEST) {
      outTest[from]++;
    } else {
      outInner[from]++;
    }
  }

  // Second pass: fill compressed rows.
  const offsets = new Uint32Array(innerCount + 1);
  const testOffsets = new Uint32Array(innerCount + 1);
  for (let i = 0; i < innerCount; i++) {
    offsets[i + 1] = offsets[i] + outInner[i];
    testOffsets[i + 1] = testOffsets[i] + outTest[i];
  }
  const targets = new Uint32Array(offsets[innerCount]);
  const testTargets = new Uint32Array(testOffsets[innerCount]);
  const cursor = offsets.slice(0, innerCount);
  const testCursor = testOffsets.slice(0, innerCount);
  for (let i = 0; i < baseline.links.length; i++) {
    const link = baseline.links[i];
    const from = indexById.get(link.fromId) as number;
    const to = resolved[i];
    if (to >= innerCount) {
      testTargets[testCursor[from]++] = to - innerCount;
    } else {
      targets[cursor[from]++] = to;
    }
  }

  return {
    reqCount,
    designCount,
    testCount,
    nodeCount,
    requirementIds,
    designItemIds,
    testCaseIds,
    requirementIndexById: indexById as ReadonlyMap<ArtifactId, number>,
    passedMask,
    offsets,
    targets,
    testOffsets,
    testTargets,
    testWords,
  };
}
