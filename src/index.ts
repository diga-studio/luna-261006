import type { AnalysisResult, Baseline, ArtifactId, ImpactResult } from "./types";
import { buildGraph } from "./graph";
import { analyzeGraph } from "./analysis";
import { queryImpactOnGraph } from "./impact";

export * from "./types";

/**
 * Analyzer bound to one frozen baseline. The baseline must not be
 * mutated while the analyzer is in use.
 */
export interface TraceabilityAnalyzer {
  /** Full analysis: per-requirement coverage plus baseline summary. */
  analyze(): AnalysisResult;
  /** Downstream impact of a single requirement. */
  queryImpact(requirementId: ArtifactId): ImpactResult;
}

/** Creates an analyzer over a frozen baseline held in process memory. */
export function createAnalyzer(baseline: Baseline): TraceabilityAnalyzer {
  const graph = buildGraph(baseline);
  return {
    analyze: () => analyzeGraph(graph),
    queryImpact: (requirementId: ArtifactId) => queryImpactOnGraph(graph, requirementId),
  };
}

/** One-shot full analysis of a baseline. */
export function analyzeBaseline(baseline: Baseline): AnalysisResult {
  return createAnalyzer(baseline).analyze();
}

/** One-shot downstream impact query for a single requirement. */
export function queryImpact(baseline: Baseline, requirementId: ArtifactId): ImpactResult {
  return createAnalyzer(baseline).queryImpact(requirementId);
}
