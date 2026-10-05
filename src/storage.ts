import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";

/** SQLite 持久化层：负责条目表与元信息表的读写。 */
export interface StoredEntry {
  seq: number;
  kind: "record" | "erase";
  subject: string | null;
  body: string | null;
  subjectHash: string | null;
  leafHash: string;
  prevHash: string;
  entryHash: string;
  erasedSeqs: string | null;
  erased: number;
}

const GENESIS_HASH =
  "0000000000000000000000000000000000000000000000000000000000000000";

export class Storage {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS entries (
        seq INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        subject TEXT,
        body TEXT,
        subject_hash TEXT,
        leaf_hash TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        entry_hash TEXT NOT NULL,
        erased_seqs TEXT,
        erased INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_entries_subject_hash
        ON entries(subject_hash);
    `);
  }

  close(): void {
    this.db.close();
  }

  /** 读取或初始化账本元信息（ledgerId、secret）。 */
  loadMeta(): { ledgerId: string; secret: string } {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = 'ledgerId'")
      .get() as { value: string } | undefined;
    if (row) {
      const secretRow = this.db
        .prepare("SELECT value FROM meta WHERE key = 'secret'")
        .get() as { value: string } | undefined;
      if (!secretRow) {
        throw new Error("ledger meta corrupted: missing secret");
      }
      return { ledgerId: row.value, secret: secretRow.value };
    }
    const ledgerId = randomBytes(16).toString("hex");
    const secret = randomBytes(32).toString("hex");
    this.db.prepare("INSERT INTO meta (key, value) VALUES ('ledgerId', ?)").run(ledgerId);
    this.db.prepare("INSERT INTO meta (key, value) VALUES ('secret', ?)").run(secret);
    return { ledgerId, secret };
  }

  nextSeq(): number {
    const row = this.db.prepare("SELECT MAX(seq) AS maxSeq FROM entries").get() as {
      maxSeq: number | null;
    };
    return (row.maxSeq ?? 0) + 1;
  }

  lastEntryHash(): string {
    const row = this.db
      .prepare("SELECT entry_hash AS h FROM entries ORDER BY seq DESC LIMIT 1")
      .get() as { h: string } | undefined;
    return row ? row.h : GENESIS_HASH;
  }

  entryCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS c FROM entries").get() as {
      c: number;
    };
    return row.c;
  }

  appendEntry(entry: StoredEntry): void {
    this.db
      .prepare(
        `INSERT INTO entries
         (seq, kind, subject, body, subject_hash, leaf_hash, prev_hash, entry_hash, erased_seqs, erased)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.seq,
        entry.kind,
        entry.subject,
        entry.body,
        entry.subjectHash,
        entry.leafHash,
        entry.prevHash,
        entry.entryHash,
        entry.erasedSeqs,
        entry.erased
      );
  }

  /** 返回某主体全部存活记录。 */
  liveRecordsBySubjectHash(subjectHash: string): StoredEntry[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM entries WHERE kind = 'record' AND erased = 0 AND subject_hash = ? ORDER BY seq"
      )
      .all(subjectHash);
    return rows.map(toStoredEntry);
  }

  /** 将指定序号的记录标记为已擦除并清除明文。 */
  tombstone(seqs: number[]): void {
    const stmt = this.db.prepare(
      "UPDATE entries SET erased = 1, subject = NULL, body = NULL WHERE seq = ?"
    );
    for (const seq of seqs) {
      stmt.run(seq);
    }
  }

  /** 按序号升序返回全部条目。 */
  allEntries(): StoredEntry[] {
    const rows = this.db.prepare("SELECT * FROM entries ORDER BY seq").all();
    return rows.map(toStoredEntry);
  }

  /** 按序号升序返回全部存活业务记录。 */
  liveRecords(): StoredEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM entries WHERE kind = 'record' AND erased = 0 ORDER BY seq")
      .all();
    return rows.map(toStoredEntry);
  }
}

function toStoredEntry(row: unknown): StoredEntry {
  const r = row as Record<string, unknown>;
  return {
    seq: Number(r.seq),
    kind: r.kind as "record" | "erase",
    subject: (r.subject as string | null) ?? null,
    body: (r.body as string | null) ?? null,
    subjectHash: (r.subject_hash as string | null) ?? null,
    leafHash: String(r.leaf_hash),
    prevHash: String(r.prev_hash),
    entryHash: String(r.entry_hash),
    erasedSeqs: (r.erased_seqs as string | null) ?? null,
    erased: Number(r.erased),
  };
}

export { GENESIS_HASH };
