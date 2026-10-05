/** Six pre-computed boolean indicators per student, in fixed order. */
export const INDICATOR_KEYS = [
  'gpaBelow2',
  'attendanceBelow75',
  'aidIncomplete',
  'undeclaredOver30Credits',
  'withdrew2Plus',
  'firstGeneration',
] as const;

export type IndicatorKey = (typeof INDICATOR_KEYS)[number];

export type Tier = 'low' | 'mid' | 'high';

export const TIERS: readonly Tier[] = ['low', 'mid', 'high'];

/** A full, concrete rule set. */
export interface RuleSet {
  weights: Record<IndicatorKey, number>;
  midThreshold: number;
  highThreshold: number;
}

/** A candidate scenario: any subset of the eight parameters may be overridden. */
export interface CandidateRule {
  weights?: Partial<Record<IndicatorKey, number>>;
  midThreshold?: number;
  highThreshold?: number;
}

/**
 * One explainable parameter: one of the six weights or one of the two
 * boundaries.
 */
export type ParamKey =
  | `weight:${IndicatorKey}`
  | 'threshold:mid'
  | 'threshold:high';

export interface StudentInput {
  id: string;
  indicators: Record<IndicatorKey, boolean>;
}

/** One explanation mapped to the number of students it applies to. */
export interface ExplanationCount {
  params: ParamKey[];
  count: number;
}

export type MigrationDirection = `${Tier}->${Tier}`;

export interface PreviewResult {
  /** The candidate resolved against the base rule (all eight values). */
  resolvedRule: RuleSet;
  totalStudents: number;
  /** migration[from][to] = number of students. */
  migration: Record<Tier, Record<Tier, number>>;
  /**
   * Per migration direction (only directions with count > 0 are present),
   * the explanations and how many students each applies to. A student with
   * k explanations contributes to k entries, so counts may sum above the
   * migration count.
   */
  explanations: Partial<Record<MigrationDirection, ExplanationCount[]>>;
}

export interface StudentPreview {
  id: string;
  baseScore: number;
  baseTier: Tier;
  candidateScore: number;
  candidateTier: Tier;
  changed: boolean;
  /** All minimal sufficient explanations; empty when the tier is unchanged. */
  explanations: ParamKey[][];
}
