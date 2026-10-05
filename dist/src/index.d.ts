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
export declare function buildIndex(candidates: Candidate[]): Index;
