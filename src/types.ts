/** Unique identifier of an artifact within a baseline. */
export type ArtifactId = string;

/** Artifact categories tracked by a baseline. */
export enum ArtifactKind {
  Requirement = "requirement",
  DesignItem = "design",
  TestCase = "test",
}

/** Frozen execution verdict of a test case. */
export enum TestVerdict {
  Passed = "passed",
  Failed = "failed",
  NotExecuted = "not_executed",
}

export interface Requirement {
  id: ArtifactId;
  kind: ArtifactKind.Requirement;
}

export interface DesignItem {
  id: ArtifactId;
  kind: ArtifactKind.DesignItem;
}

export interface TestCase {
  id: ArtifactId;
  kind: ArtifactKind.TestCase;
  verdict: TestVerdict;
}

/**
 * A directed downstream link. `from -> to` means: `to` is in the
 * downstream impact scope of `from`. Bidirectional navigation in any
 * UI does not change this direction.
 *
 * Legal endpoints:
 *  - requirement -> requirement (sub-requirement, acyclic)
 *  - requirement -> design item
 *  - requirement -> test case
 *  - design item  -> design item (cycles allowed)
 *  - design item  -> test case
 * Test cases have no outgoing links.
 */
export interface TraceLink {
  from: ArtifactId;
  to: ArtifactId;
}

/** A frozen project baseline. Never mutated during analysis. */
export interface Baseline {
  requirements: readonly Requirement[];
  designItems: readonly DesignItem[];
  testCases: readonly TestCase[];
  links: readonly TraceLink[];
}

/** Coverage statistics for a single requirement. */
export interface RequirementCoverage {
  requirementId: ArtifactId;
  /** Number of distinct test cases reachable via directed links. */
  reachableTests: number;
  /** Reachable tests whose verdict is Passed. */
  passedTests: number;
  /** passedTests / reachableTests, or null when reachableTests === 0. */
  passRate: number | null;
  /** True only when the requirement reaches no test case at all. */
  isTraceabilityGap: boolean;
}

/** Whole-baseline summary. */
export interface BaselineSummary {
  totalRequirements: number;
  /** Requirements reaching at least one test case. */
  requirementsWithTests: number;
  /** requirementsWithTests / totalRequirements, null when no requirements. */
  requirementCoverageRatio: number | null;
  /** Distinct tests reached by at least one requirement. */
  tracedTests: number;
  /** Passed tests among the traced-test union. */
  tracedPassedTests: number;
  /** tracedPassedTests / tracedTests, null when tracedTests === 0. */
  baselinePassRate: number | null;
}

/** Downstream impact scope of one requirement. The start node is excluded. */
export interface ImpactScope {
  requirementId: ArtifactId;
  subRequirements: ArtifactId[];
  designItems: ArtifactId[];
  testCases: ArtifactId[];
}
