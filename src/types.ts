/** A single resume version: skills and experience belong to a version. */
export interface ResumeVersion {
  versionId: string;
  skills: string[];
  experienceMonths: number;
}

/** A candidate: tags belong to the candidate, resumes are its 1..3 versions. */
export interface Candidate {
  id: string;
  tags: string[];
  resumes: ResumeVersion[];
}

export type FilterNode =
  | { op: 'and'; children: FilterNode[] }
  | { op: 'or'; children: FilterNode[] }
  | { op: 'not'; child: FilterNode }
  | { op: 'tag'; tag: string }
  | { op: 'skill'; skill: string };

/** A scoring leaf: same match semantics as filter leaves, plus an integer weight 1..100. */
export interface ScoringItem {
  kind: 'tag' | 'skill';
  value: string;
  weight: number;
}

export interface Query {
  filter: FilterNode;
  /** At most 12 scoring leaves. */
  scoring: ScoringItem[];
  targetExperienceMonths: number;
  k: number;
}

export interface SearchHit {
  candidateId: string;
  score: number;
  witnessVersionId: string;
  /** Scoring items matched by the witness version. */
  matchedScoring: ScoringItem[];
}

/** Observer event fired once per distinct resume that undergoes query-dependent scoring work. */
export interface ScoreObservation {
  candidateId: string;
  versionId: string;
}

export interface SearchOptions {
  onScoreVersion?: (obs: ScoreObservation) => void;
}

export interface SearchResult {
  hits: SearchHit[];
  /** Distinct resumes that underwent query-dependent scoring work in this call. */
  scoredVersions: number;
}
