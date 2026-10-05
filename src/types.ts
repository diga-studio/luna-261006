/** A document: top-level string fields only. Fields may be absent. */
export type Doc = Record<string, string>;

/** Outcome of a rebuild call. */
export type RebuildStatus = "published" | "superseded";

export interface RebuildResult {
  /** Generation allocated to this rebuild call at entry. */
  generation: number;
  status: RebuildStatus;
}

export interface SearchResult {
  /** Published generation whose index produced these hits. */
  generation: number;
  /** Ids of documents containing the term in any indexed field. */
  ids: string[];
}

export interface DocumentIndex {
  /**
   * Create or fully replace a document. `doc === null` deletes it.
   * Resolves after the change is committed.
   */
  put(id: string, doc: Doc | null): Promise<void>;

  /**
   * Build a new index over `fields` and try to publish it.
   * A monotonically increasing generation is allocated on entry.
   */
  rebuild(fields: string[]): Promise<RebuildResult>;

  /**
   * Full-word, case-insensitive match of a single lowercase ASCII word
   * against the currently published index.
   */
  search(term: string): Promise<SearchResult>;

  /** Flush and close the underlying database. */
  close(): Promise<void>;
}
