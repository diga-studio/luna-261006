/** A single resume version belonging to a candidate. */
export interface ResumeInput {
  /** Version identifier, unique within the candidate. */
  id: string;
  /** Normalized skill terms for this version. */
  skills: readonly string[];
  /** Integer months of experience. */
  experienceMonths: number;
}

/** A candidate with candidate-level tags and 1..3 resume versions. */
export interface CandidateInput {
  id: string;
  tags: readonly string[];
  resumes: readonly ResumeInput[];
}

/** Exact-containment leaf over candidate tags or version skills. */
export type MatchLeaf =
  | { readonly kind: 'tag'; readonly value: string }
  | { readonly kind: 'skill'; readonly value: string };

/** Boolean filter tree. Leaves are exact containment conditions. */
export type FilterNode =
  | { readonly op: 'and'; readonly children: readonly FilterNode[] }
  | { readonly op: 'or'; readonly children: readonly FilterNode[] }
  | { readonly op: 'not'; readonly child: FilterNode }
  | { readonly op: 'leaf'; readonly leaf: MatchLeaf };

/** A weighted scoring leaf; same matching semantics as filter leaves. */
export interface ScoringLeaf {
  readonly leaf: MatchLeaf;
  /** Integer weight in [1, 100]. */
  readonly weight: number;
}

export interface Query {
  readonly filter: FilterNode;
  /** Up to 12 scoring leaves. */
  readonly scoring: readonly ScoringLeaf[];
  /** Target experience in months for the closeness bonus. */
  readonly experienceTargetMonths: number;
  /** Exact number of top candidates to return. */
  readonly k: number;
}

/** Observer event emitted once per resume version that undergoes
 *  query-dependent scoring work (weighted contribution, experience
 *  distance, or per-version scoring upper bound). */
export interface ScoredVersionEvent {
  readonly candidateId: string;
  readonly versionId: string;
}

export interface SearchOptions {
  /** Injectable observer invoked for every scored version. */
  readonly onVersionScored?: (event: ScoredVersionEvent) => void;
}

export interface ScoredHit {
  readonly leaf: MatchLeaf;
  readonly weight: number;
}

export interface SearchResultItem {
  readonly candidateId: string;
  readonly score: number;
  /** Witness version: highest-scoring qualifying version of the candidate,
   *  ties broken by lexicographically smallest version id. */
  readonly witnessVersionId: string;
  /** Scoring leaves hit by the witness version. */
  readonly matchedScoring: readonly ScoredHit[];
}

export interface SearchOutput {
  readonly results: readonly SearchResultItem[];
  /** Number of distinct resume versions that underwent query-dependent
   *  scoring work during this call. */
  readonly scoredVersions: number;
}

declare const brand: unique symbol;

/** Opaque built index handle. */
export interface Index {
  readonly [brand]: unknown;
}
