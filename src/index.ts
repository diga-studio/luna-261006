import type { Candidate } from './types.js';

/** Static inverted index over candidates and their resume versions. */
export interface Index {
  /** Total number of resume versions (doc ids are 0..versionCount-1). */
  readonly versionCount: number;
  /** version doc id -> candidate position in `candidateIds`. */
  readonly candidateOfVersion: Uint32Array;
  /** version doc id -> experience months. */
  readonly experienceOfVersion: Uint32Array;
  /** version doc id -> public version id string. */
  readonly versionIds: string[];
  /** candidate position -> candidate id string. */
  readonly candidateIds: string[];
  /** candidate position -> version doc ids (ascending). */
  readonly candidateVersions: number[][];
  /** skill -> sorted version doc ids containing the skill. */
  readonly skillPostings: Map<string, number[]>;
  /** tag -> sorted candidate positions carrying the tag. */
  readonly tagPostings: Map<string, number[]>;
  /** version doc ids sorted by experience months (ties by doc id). */
  readonly versionsByExperience: number[];
}

/**
 * Build a static index. Takes no query; one index serves many different
 * queries with different weights and experience targets.
 */
export function buildIndex(candidates: Candidate[]): Index {
  const candidateIds: string[] = [];
  const candidateVersions: number[][] = [];
  const candidateOfVersion: number[] = [];
  const experienceOfVersion: number[] = [];
  const versionIds: string[] = [];
  const skillPostings = new Map<string, number[]>();
  const tagPostings = new Map<string, number[]>();

  candidates.forEach((candidate, candidatePos) => {
    candidateIds.push(candidate.id);
    const versions: number[] = [];
    for (const resume of candidate.resumes) {
      const docId = versionIds.length;
      versions.push(docId);
      candidateOfVersion.push(candidatePos);
      experienceOfVersion.push(resume.experienceMonths);
      versionIds.push(resume.versionId);
      for (const skill of resume.skills) {
        let list = skillPostings.get(skill);
        if (list === undefined) {
          list = [];
          skillPostings.set(skill, list);
        }
        list.push(docId);
      }
    }
    candidateVersions.push(versions);
    for (const tag of candidate.tags) {
      let list = tagPostings.get(tag);
      if (list === undefined) {
        list = [];
        tagPostings.set(tag, list);
      }
      list.push(candidatePos);
    }
  });

  const versionsByExperience = Array.from({ length: versionIds.length }, (_, i) => i);
  versionsByExperience.sort((a, b) => experienceOfVersion[a]! - experienceOfVersion[b]! || a - b);

  return {
    versionCount: versionIds.length,
    candidateOfVersion: Uint32Array.from(candidateOfVersion),
    experienceOfVersion: Uint32Array.from(experienceOfVersion),
    versionIds,
    candidateIds,
    candidateVersions,
    skillPostings,
    tagPostings,
    versionsByExperience,
  };
}
