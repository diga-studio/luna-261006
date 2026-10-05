import { DatabaseSync } from "node:sqlite";
import type { EngineOptions } from "./options.js";
import type { Doc, DocumentIndex, RebuildResult, SearchResult } from "./types.js";

const TERM_RE = /^[a-z]+$/;
const SCAN_BATCH = 256;

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
export class Engine implements DocumentIndex {
  private db: DatabaseSync;
  private publishedGeneration: number;
  private publishedFields: string[];
  private latestGeneration: number;
  /** generation -> changes.seq high-water mark captured at rebuild entry. */
  private activeRebuilds = new Map<number, number>();
  private onScanBatch: (generation: number) => void | Promise<void>;

  constructor(path: string, options: EngineOptions = {}) {
    this.onScanBatch = options.onScanBatch ?? (() => {});
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS docs (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS changes (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL
      );
    `);
    this.latestGeneration = this.readMetaInt("latest_generation", 0);
    this.publishedGeneration = this.readMetaInt("published_generation", 0);
    this.publishedFields = JSON.parse(this.readMeta("published_fields", "[]")) as string[];
  }

  private readMeta(key: string, fallback: string): string {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row === undefined ? fallback : row.value;
  }

  private readMetaInt(key: string, fallback: number): number {
    return Number(this.readMeta(key, String(fallback)));
  }

  private writeMeta(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  private ftsTable(generation: number): string {
    return `fts_${generation}`;
  }

  private insertIntoFts(table: string, fields: string[], id: string, doc: Doc): void {
    const cols = fields.map((_, i) => `c${i}`);
    const values = fields.map((f) => doc[f] ?? "");
    this.db
      .prepare(`INSERT INTO ${table}(id, ${cols.join(", ")}) VALUES (?, ${cols.map(() => "?").join(", ")})`)
      .run(id, ...values);
  }

  /** Apply one committed change to the currently published FTS index. */
  private applyToPublished(id: string, doc: Doc | null): void {
    if (this.publishedFields.length === 0) return;
    const table = this.ftsTable(this.publishedGeneration);
    this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    if (doc !== null) {
      this.insertIntoFts(table, this.publishedFields, id, doc);
    }
  }

  async put(id: string, doc: Doc | null): Promise<void> {
    this.db.exec("BEGIN");
    try {
      if (doc === null) {
        this.db.prepare("DELETE FROM docs WHERE id = ?").run(id);
      } else {
        this.db
          .prepare("INSERT INTO docs(id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data")
          .run(id, JSON.stringify(doc));
      }
      this.db.prepare("INSERT INTO changes(id) VALUES (?)").run(id);
      this.applyToPublished(id, doc);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async rebuild(fields: string[]): Promise<RebuildResult> {
    // Allocate the generation synchronously on entry.
    const generation = this.latestGeneration + 1;
    this.latestGeneration = generation;
    this.writeMeta("latest_generation", String(generation));
    const startSeq = (
      this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM changes").get() as { s: number }
    ).s;
    this.activeRebuilds.set(generation, startSeq);

    const table = this.ftsTable(generation);
    try {
      if (fields.length > 0) {
        const cols = fields.map((_, i) => `c${i}`);
        this.db.exec(`CREATE VIRTUAL TABLE ${table} USING fts5(id UNINDEXED, ${cols.join(", ")})`);

        // Scan the docs table in batches, yielding between batches so that
        // puts and searches keep being served while the rebuild runs.
        let lastId = "";
        for (;;) {
          const rows = this.db
            .prepare("SELECT id, data FROM docs WHERE id > ? ORDER BY id LIMIT ?")
            .all(lastId, SCAN_BATCH) as unknown as { id: string; data: string }[];
          if (rows.length === 0) break;
          this.db.exec("BEGIN");
          try {
            for (const row of rows) {
              this.insertIntoFts(table, fields, row.id, JSON.parse(row.data) as Doc);
            }
            this.db.exec("COMMIT");
          } catch (err) {
            this.db.exec("ROLLBACK");
            throw err;
          }
          lastId = rows[rows.length - 1].id;
          await this.onScanBatch(generation);
          await new Promise((resolve) => setImmediate(resolve));
        }
      }

      if (generation < this.latestGeneration) {
        // A newer rebuild was allocated after this one entered: this call may
        // no longer publish.
        this.db.exec(`DROP TABLE IF EXISTS ${table}`);
        return { generation, status: "superseded" };
      }

      // Atomic publish boundary: replay every change committed since entry,
      // then flip the published generation in the same transaction.
      const previousGeneration = this.publishedGeneration;
      this.db.exec("BEGIN");
      try {
        if (fields.length > 0) {
          const changed = this.db
            .prepare("SELECT DISTINCT id FROM changes WHERE seq > ?")
            .all(startSeq) as unknown as { id: string }[];
          const getDoc = this.db.prepare("SELECT data FROM docs WHERE id = ?");
          const del = this.db.prepare(`DELETE FROM ${table} WHERE id = ?`);
          for (const { id } of changed) {
            del.run(id);
            const row = getDoc.get(id) as { data: string } | undefined;
            if (row !== undefined) {
              this.insertIntoFts(table, fields, id, JSON.parse(row.data) as Doc);
            }
          }
        }
        this.writeMeta("published_generation", String(generation));
        this.writeMeta("published_fields", JSON.stringify(fields));
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
      this.publishedGeneration = generation;
      this.publishedFields = fields;
      if (previousGeneration !== 0 && previousGeneration !== generation) {
        this.db.exec(`DROP TABLE IF EXISTS ${this.ftsTable(previousGeneration)}`);
      }
      return { generation, status: "published" };
    } finally {
      this.activeRebuilds.delete(generation);
      this.pruneChanges();
    }
  }

  /** Journal entries only needed by rebuilds that have already finished. */
  private pruneChanges(): void {
    if (this.activeRebuilds.size === 0) {
      this.db.exec("DELETE FROM changes");
      return;
    }
    const minStart = Math.min(...this.activeRebuilds.values());
    this.db.prepare("DELETE FROM changes WHERE seq <= ?").run(minStart);
  }

  async search(term: string): Promise<SearchResult> {
    if (!TERM_RE.test(term)) {
      throw new Error(`invalid term: ${JSON.stringify(term)}`);
    }
    const generation = this.publishedGeneration;
    if (this.publishedFields.length === 0) {
      return { generation, ids: [] };
    }
    const table = this.ftsTable(generation);
    const rows = this.db
      .prepare(`SELECT id FROM ${table} WHERE ${table} MATCH ? ORDER BY id`)
      .all(`"${term}"`) as unknown as { id: string }[];
    return { generation, ids: rows.map((r) => r.id) };
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
