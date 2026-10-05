import type { Candidate, Query, SearchHit } from '../src/api.js';
/** Brute-force reference: evaluates every version of every candidate. */
export declare function oracleSearch(candidates: Candidate[], query: Query): SearchHit[];
