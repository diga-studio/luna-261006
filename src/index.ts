import type { CandidateInput, Index, Query, SearchOptions, SearchOutput } from './types.js';
import { buildIndexImpl } from './build.js';
import { searchImpl } from './search.js';

export * from './types.js';

export function buildIndex(candidates: readonly CandidateInput[]): Index {
  return buildIndexImpl(candidates);
}

export function search(
  index: Index,
  query: Query,
  options?: SearchOptions,
): SearchOutput {
  return searchImpl(index, query, options);
}
