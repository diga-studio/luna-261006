import {
  ArtifactKind,
  TestVerdict,
  type Baseline,
  type TestCase,
} from "../src/index.js";

/** A deliberately simple baseline builder for tests. */
export function makeBaseline(
  reqIds: string[],
  designIds: string[],
  tests: Array<[string, TestVerdict]>,
  links: Array<[string, string]>,
): Baseline {
  return {
    requirements: reqIds.map((id) => ({ id, kind: ArtifactKind.Requirement })),
    designItems: designIds.map((id) => ({ id, kind: ArtifactKind.DesignItem })),
    testCases: tests.map(([id, verdict]) => ({ id, kind: ArtifactKind.TestCase, verdict })),
    links: links.map(([from, to]) => ({ from, to })),
  };
}

/**
 * Independent naive reference: plain Set-based graph walk per requirement.
 * Written as obviously-correctly as possible; used to cross-check the
 * optimized implementation.
 */
export function naiveReachableTests(baseline: Baseline, requirementId: string): Set<string> {
  const testIds = new Set(baseline.testCases.map((t) => t.id));
  const adjacency = new Map<string, string[]>();
  for (const link of baseline.links) {
    let list = adjacency.get(link.from);
    if (list === undefined) {
      list = [];
      adjacency.set(link.from, list);
    }
    list.push(link.to);
  }
  const visited = new Set<string>([requirementId]);
  const queue = [requirementId];
  const result = new Set<string>();
  while (queue.length > 0) {
    const node = queue.pop() as string;
    for (const next of adjacency.get(node) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      queue.push(next);
      if (testIds.has(next)) result.add(next);
    }
  }
  return result;
}

export function verdictOf(baseline: Baseline, testId: string): TestVerdict {
  const tc = baseline.testCases.find((t: TestCase) => t.id === testId);
  if (tc === undefined) throw new Error(`no such test ${testId}`);
  return tc.verdict;
}
