import { analyzeCoverage } from "./coverage.js";
import { buildGraph, type FrozenGraph } from "./graph.js";
import { computeImpactScope } from "./impact.js";
import type {
  Baseline,
  BaselineSummary,
  ImpactScope,
  RequirementCoverage,
} from "./types.js";

/**
 * Analyzer bound to one frozen baseline. All data lives in process memory;
 * the baseline is indexed once at construction and never mutated.
 */
export interface TraceabilityAnalyzer {
  /** Coverage statistics for one requirement. Throws for unknown ids. */
  coverageFor(requirementId: string): RequirementCoverage;
  /** Coverage statistics for every requirement, in baseline order. */
  allCoverage(): readonly RequirementCoverage[];
  /** Whole-baseline summary. */
  summary(): BaselineSummary;
  /** Downstream impact scope of one requirement. Throws for unknown ids. */
  impactOf(requirementId: string): ImpactScope;
}

/** Create an analyzer over a frozen baseline. */
export function createAnalyzer(baseline: Baseline): TraceabilityAnalyzer {
  const graph: FrozenGraph = buildGraph(baseline);
  const { coverage, summary } = analyzeCoverage(graph);
  const byId = new Map<string, RequirementCoverage>();
  for (const entry of coverage) byId.set(entry.requirementId, entry);

  return {
    coverageFor(requirementId: string): RequirementCoverage {
      const entry = byId.get(requirementId);
      if (entry === undefined) throw new Error(`unknown requirement id: ${requirementId}`);
      return entry;
    },
    allCoverage(): readonly RequirementCoverage[] {
      return coverage;
    },
    summary(): BaselineSummary {
      return summary;
    },
    impactOf(requirementId: string): ImpactScope {
      return computeImpactScope(graph, requirementId);
    },
  };
}
