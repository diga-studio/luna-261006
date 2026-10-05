/** A document: only top-level string fields; values are ASCII letters and whitespace. */
export type Doc = Record<string, string>;

/** Result of a rebuild call. */
export interface RebuildResult {
  /** Generation assigned to this rebuild when it was entered. */
  generation: number;
  /** "published" if this rebuild's index became the serving one, else "superseded". */
  status: 'published' | 'superseded';
}

/** Result of a search call. */
export interface SearchResult {
  /** The published generation whose index produced these hits. */
  generation: number;
  /** Ids of all documents matching the term in any indexed field. */
  ids: string[];
}
