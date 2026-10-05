/**
 * Public data model for the traceability coverage library.
 *
 * A baseline is a frozen, in-memory snapshot handed in by the caller.
 * All analysis derives from directed links; reverse navigation in any UI
 * does not change link direction.
 */

export type ArtifactId = string;

/** The single frozen execution verdict of a test case in a baseline. */
export enum TestVerdict {
  Passed = "passed",
  Failed = "failed",
  NotExecuted = "not_executed",
}

export interface Requirement {
  id: ArtifactId;
}

export interface DesignItem {
  id: ArtifactId;
}

export interface TestCase {
  id: ArtifactId;
  verdict: TestVerdict;
}

/**
 * A directed downstream link. `fromId` may be a requirement or a design
 * item; `toId` may be a requirement (sub-requirement), a design item, or
 * a test case. Test cases never appear as `fromId`.
 */
export interface TraceLink {
  fromId: ArtifactId;
  toId: ArtifactId;
}

export interface Baseline {
  requirements: readonly Requirement[];
  designItems: readonly DesignItem[];
  testCases: readonly TestCase[];
  links: readonly TraceLink[];
}

/** Coverage statistics for a single requirement. */
export interface RequirementCoverage {
  requirementId: ArtifactId;
  /** Distinct test cases reachable via directed links (any depth). */
  reachableTestCount: number;
  /** Reachable test cases whose verdict is Passed. */
  passedTestCount: number;
  /**
   * passedTestCount / reachableTestCount, where the denominator includes
   * failed and not-executed tests. Null when there are no reachable tests
   * (no data), never 0 in that case.
   */
  passRate: number | null;
  /** True only when the requirement has zero reachable tests. */
  isTraceabilityGap: boolean;
}

export interface BaselineSummary {
  requirementCount: number;
  /** Requirements with at least one reachable test. */
  requirementsWithTests: number;
  /**
   * requirementsWithTests / requirementCount.
   * Null when the baseline has no requirements (no data).
   */
  requirementCoverageRatio: number | null;
  /** Size of the deduplicated union of tests reachable from any requirement. */
  tracedTestCount: number;
  /** Passed tests within that union (each test counted once). */
  tracedPassedCount: number;
  /**
   * tracedPassedCount / tracedTestCount. Tests not traced by any
   * requirement are excluded. Null when no test is traced (no data).
   */
  overallPassRate: number | null;
}

export interface AnalysisResult {
  requirements: RequirementCoverage[];
  summary: BaselineSummary;
}

/**
 * Full downstream impact of one requirement: every artifact reachable via
 * directed links, each listed once, excluding the start requirement.
 */
export interface ImpactResult {
  requirementId: ArtifactId;
  /** Reachable (sub-)requirements, excluding the start requirement. */
  requirementIds: ArtifactId[];
  designItemIds: ArtifactId[];
  testCaseIds: ArtifactId[];
}
