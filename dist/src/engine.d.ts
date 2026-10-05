import type { EngineOptions } from "./options.js";
import type { Doc, DocumentIndex, RebuildResult, SearchResult } from "./types.js";
/**
 * Engine implements DocumentIndex on top of a single SQLite file that holds
 * the documents, a change journal, and one FTS5 table per index generation.
 *
 * Schema:
 *   meta(key, value)                -- latest_generation, published_generation, published_fields
 *   docs(id, data)                  -- current document bodies (JSON)
 *   changes(seq, id)                -- journal of committed puts/deletes
 *   fts_<gen>(id UNINDEXED, c0..cN) -- FTS5 index for a generation
 */
export declare class Engine implements DocumentIndex {
    private db;
    private publishedGeneration;
    private publishedFields;
    private latestGeneration;
    /** generation -> changes.seq high-water mark captured at rebuild entry. */
    private activeRebuilds;
    private onScanBatch;
    constructor(path: string, options?: EngineOptions);
    private readMeta;
    private readMetaInt;
    private writeMeta;
    private ftsTable;
    private insertIntoFts;
    /** Apply one committed change to the currently published FTS index. */
    private applyToPublished;
    put(id: string, doc: Doc | null): Promise<void>;
    rebuild(fields: string[]): Promise<RebuildResult>;
    /** Journal entries only needed by rebuilds that have already finished. */
    private pruneChanges;
    search(term: string): Promise<SearchResult>;
    close(): Promise<void>;
}
