import { DatabaseSync, StatementSync } from 'node:sqlite';
import { Doc, RebuildResult, SearchResult } from './types';

export { Doc, RebuildResult, SearchResult } from './types';

export interface DocumentIndexOptions {
  /** Path of the SQLite file holding both documents and indexes. */
  path: string;
}

const TERM_RE = /^[a-z]+$/;
const FIELD_VALUE_RE = /^[A-Za-z\s]*$/;
const SCAN_BATCH = 500;

function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

interface ActiveRebuild {
  generation: number;
  baseSeq: number;
}

/**
 * Online full-text index over a collection of documents.
 * Documents and indexes live in the same SQLite file.
 *
 * Layout inside the file:
 * - docs(id, data): current committed documents, data is JSON.
 * - meta(key, value): published generation / field set / FTS table name.
 * - changelog(seq, id): ids touched by put since the oldest in-flight
 *   rebuild started; drained into staging indexes and pruned on publish.
 * - fts_N: one FTS5 table per rebuild generation (docid UNINDEXED + fields).
 */
export class DocumentIndex {
  private db: DatabaseSync;
  private stmts = new Map<string, StatementSync>();
  private maxEnteredGeneration: number;
  private activeRebuilds: ActiveRebuild[] = [];

  constructor(options: DocumentIndexOptions) {
    this.db = new DatabaseSync(options.path);
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS docs(' +
        'id TEXT PRIMARY KEY, data TEXT NOT NULL);' +
        'CREATE TABLE IF NOT EXISTS meta(' +
        'key TEXT PRIMARY KEY, value TEXT NOT NULL);' +
        'CREATE TABLE IF NOT EXISTS changelog(' +
        'seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL);' +
        "INSERT OR IGNORE INTO meta(key, value) VALUES" +
        "('published_generation', '0')," +
        "('published_fields', '[]')," +
        "('published_fts', '');"
    );
    this.maxEnteredGeneration = Number(this.metaGet('published_generation'));
  }

  /** Create or fully replace a document; doc === null deletes it. Committed on return. */
  async put(id: string, doc: Doc | null): Promise<void> {
    validateId(id);
    if (doc !== null) validateDoc(doc);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (doc === null) {
        this.stmt('DELETE FROM docs WHERE id = ?').run(id);
      } else {
        this.stmt(
          'INSERT INTO docs(id, data) VALUES(?, ?)' +
            'ON CONFLICT(id) DO UPDATE SET data = excluded.data'
        ).run(id, JSON.stringify(doc));
      }
      const fts = this.metaGet('published_fts');
      if (fts !== '') {
        this.stmt('DELETE FROM ' + quoteIdent(fts) + ' WHERE docid = ?').run(id);
        if (doc !== null) {
          const fields = JSON.parse(this.metaGet('published_fields')) as string[];
          this.stmt(insertSql(fts, fields)).run(
            id,
            ...fields.map((f) => (doc[f] === undefined ? '' : doc[f]))
          );
        }
      }
      this.stmt('INSERT INTO changelog(id) VALUES(?)').run(id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Build an index over the given field set and try to publish it. */
  async rebuild(fields: string[]): Promise<RebuildResult> {
    const fieldSet = validateFields(fields);
    const generation = ++this.maxEnteredGeneration;
    const baseSeq = this.maxChangelogSeq();
    const rec: ActiveRebuild = { generation, baseSeq };
    this.activeRebuilds.push(rec);
    try {
      let staging = '';
      if (fieldSet.length > 0) {
        staging = 'fts_' + generation;
        this.db.exec(
          'CREATE VIRTUAL TABLE ' +
            quoteIdent(staging) +
            ' USING fts5(docid UNINDEXED, ' +
            fieldSet.map(quoteIdent).join(', ') +
            ')'
        );
        await this.scanInto(staging, fieldSet);
      }
      return this.tryPublish(rec, staging, fieldSet);
    } finally {
      this.activeRebuilds = this.activeRebuilds.filter((r) => r !== rec);
    }
  }

  /** Full-word, case-insensitive match of a single lowercase ASCII word. */
  async search(term: string): Promise<SearchResult> {
    if (!TERM_RE.test(term)) {
      throw new RangeError('term must be a single lowercase ASCII word');
    }
    this.db.exec('BEGIN');
    try {
      const generation = Number(this.metaGet('published_generation'));
      const fts = this.metaGet('published_fts');
      let ids: string[] = [];
      if (fts !== '') {
        ids = this.stmt(
          'SELECT docid FROM ' + quoteIdent(fts) +
            ' WHERE ' + quoteIdent(fts) + ' MATCH ? ORDER BY docid'
        )
          .all('"' + term + '"')
          .map((row) => row.docid as string);
      }
      this.db.exec('COMMIT');
      return { generation, ids };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Close the underlying database. */
  async close(): Promise<void> {
    this.db.close();
  }

  private stmt(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (s === undefined) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  private metaGet(key: string): string {
    const row = this.stmt('SELECT value FROM meta WHERE key = ?').get(key);
    return row === undefined ? '' : (row.value as string);
  }

  private metaSet(key: string, value: string): void {
    this.stmt(
      'INSERT INTO meta(key, value) VALUES(?, ?)' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(key, value);
  }

  private maxChangelogSeq(): number {
    const row = this.stmt('SELECT MAX(seq) AS m FROM changelog').get();
    return row === undefined || row.m === null ? 0 : Number(row.m);
  }

  /** Copy the docs table into the staging FTS, in batches, yielding between them. */
  private async scanInto(staging: string, fields: string[]): Promise<void> {
    const insert = this.stmt(insertSql(staging, fields));
    let last = '';
    for (;;) {
      const rows = this.stmt(
        'SELECT id, data FROM docs WHERE id > ? ORDER BY id LIMIT ' + SCAN_BATCH
      ).all(last);
      if (rows.length === 0) return;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const row of rows) {
          const doc = JSON.parse(row.data as string) as Doc;
          insert.run(
            row.id as string,
            ...fields.map((f) => (doc[f] === undefined ? '' : doc[f]))
          );
        }
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
      last = rows[rows.length - 1].id as string;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  /**
   * Apply every change committed after baseSeq to the staging index,
   * using the current state of the docs table.
   */
  private drain(baseSeq: number, staging: string, fields: string[]): void {
    const changed = this.stmt(
      'SELECT DISTINCT id FROM changelog WHERE seq > ?'
    ).all(baseSeq);
    const del = this.stmt('DELETE FROM ' + quoteIdent(staging) + ' WHERE docid = ?');
    const insert = this.stmt(insertSql(staging, fields));
    const get = this.stmt('SELECT data FROM docs WHERE id = ?');
    for (const row of changed) {
      const id = row.id as string;
      del.run(id);
      const cur = get.get(id);
      if (cur !== undefined) {
        const doc = JSON.parse(cur.data as string) as Doc;
        insert.run(id, ...fields.map((f) => (doc[f] === undefined ? '' : doc[f])));
      }
    }
  }

  /**
   * Synchronous, hence atomic with respect to put/search: either this
   * rebuild is still the newest one entered and its index is swapped in
   * inside a single write transaction, or it is superseded and dropped.
   */
  private tryPublish(
    rec: ActiveRebuild,
    staging: string,
    fields: string[]
  ): RebuildResult {
    const generation = rec.generation;
    if (generation !== this.maxEnteredGeneration) {
      if (staging !== '') {
        this.db.exec('DROP TABLE IF EXISTS ' + quoteIdent(staging));
      }
      return { generation, status: 'superseded' };
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (staging !== '') {
        this.drain(rec.baseSeq, staging, fields);
      }
      const oldFts = this.metaGet('published_fts');
      this.metaSet('published_generation', String(generation));
      this.metaSet('published_fields', JSON.stringify(fields));
      this.metaSet('published_fts', staging);
      if (oldFts !== '') {
        this.db.exec('DROP TABLE IF EXISTS ' + quoteIdent(oldFts));
      }
      this.pruneChangelog();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { generation, status: 'published' };
  }

  /**
   * Changelog rows at or below every in-flight rebuild's baseSeq are
   * covered by their scans, so they can be dropped. Must be called from
   * within the publish transaction; this rebuild is still registered.
   */
  private pruneChangelog(): void {
    if (this.activeRebuilds.length <= 1) {
      this.db.exec('DELETE FROM changelog');
      return;
    }
    let minBase = Infinity;
    for (const r of this.activeRebuilds) {
      if (r.baseSeq < minBase) minBase = r.baseSeq;
    }
    this.stmt('DELETE FROM changelog WHERE seq <= ?').run(minBase);
  }
}

function insertSql(fts: string, fields: string[]): string {
  const cols = ['docid'].concat(fields).map(quoteIdent).join(', ');
  const marks = fields.map(() => '?').join(', ');
  return (
    'INSERT INTO ' + quoteIdent(fts) + '(' + cols + ') VALUES(?, ' + marks + ')'
  );
}

function validateId(id: string): void {
  if (typeof id !== 'string' || id.length === 0) {
    throw new TypeError('id must be a non-empty string');
  }
}

function validateDoc(doc: Doc): void {
  for (const key of Object.keys(doc)) {
    const value = doc[key];
    if (typeof value !== 'string' || !FIELD_VALUE_RE.test(value)) {
      throw new TypeError(
        'doc values must be strings of ASCII letters and whitespace'
      );
    }
  }
}

function validateFields(fields: string[]): string[] {
  if (!Array.isArray(fields)) throw new TypeError('fields must be an array');
  const seen = new Set<string>();
  for (const f of fields) {
    if (typeof f !== 'string' || f.length === 0) {
      throw new TypeError('fields must be non-empty strings');
    }
    seen.add(f);
  }
  return Array.from(seen);
}
