import type { CandidateInput, Index } from './types.js';

/** Internal representation of one resume version. */
export interface VersionRec {
  readonly candidateIndex: number;
  readonly versionId: string;
  readonly experienceMonths: number;
  readonly skills: readonly string[];
}

export interface BuiltIndex {
  readonly candidateIds: readonly string[];
  readonly versions: readonly VersionRec[];
  /** tag -> sorted version slots whose candidate carries the tag. */
  readonly tagPostings: ReadonlyMap<string, number[]>;
  /** skill -> sorted version slots carrying the skill. */
  readonly skillPostings: ReadonlyMap<string, number[]>;
  /** Version slots sorted by ascending experienceMonths. */
  readonly slotsByExperience: readonly number[];
}

export function build(candidates: readonly CandidateInput[]): BuiltIndex {
  const candidateIds: string[] = [];
  const versions: VersionRec[] = [];
  const tagPostings = new Map<string, number[]>();
  const skillPostings = new Map<string, number[]>();

  candidates.forEach((candidate, candidateIndex) => {
    candidateIds.push(candidate.id);
    const start = versions.length;
    for (const resume of candidate.resumes) {
      const slot = versions.length;
      versions.push({
        candidateIndex,
        versionId: resume.id,
        experienceMonths: resume.experienceMonths,
        skills: resume.skills,
      });
      for (const skill of resume.skills) {
        let list = skillPostings.get(skill);
        if (list === undefined) {
          list = [];
          skillPostings.set(skill, list);
        }
        list.push(slot);
      }
    }
    const end = versions.length;
    for (const tag of candidate.tags) {
      let list = tagPostings.get(tag);
      if (list === undefined) {
        list = [];
        tagPostings.set(tag, list);
      }
      for (let slot = start; slot < end; slot += 1) {
        list.push(slot);
      }
    }
  });

  const slotsByExperience = versions
    .map((_, slot) => slot)
    .sort((a, b) => versions[a].experienceMonths - versions[b].experienceMonths || a - b);

  return { candidateIds, versions, tagPostings, skillPostings, slotsByExperience };
}

export function buildIndexImpl(candidates: readonly CandidateInput[]): Index {
  return build(candidates) as unknown as Index;
}

export function unwrap(index: Index): BuiltIndex {
  return index as unknown as BuiltIndex;
}
