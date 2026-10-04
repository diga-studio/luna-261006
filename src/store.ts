import { DatabaseSync } from "node:sqlite";

/**
 * SQLite 存储层：域名表与修订信息。
 * 每个修订是整份替换；只有完整导入成功（committed）的修订才生效，
 * 当前生效修订始终是所有已提交修订中的最大修订号。
 */
export class DomainStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS revisions (
        revision INTEGER PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('importing', 'committed'))
      );
      CREATE TABLE IF NOT EXISTS domains (
        revision INTEGER NOT NULL,
        domain TEXT NOT NULL,
        PRIMARY KEY (revision, domain)
      );
      INSERT OR IGNORE INTO meta (key, value) VALUES ('current_revision', '0');
    `);
  }

  /** 当前生效修订号（无成功导入时为 0，对应空表）。 */
  currentRevision(): number {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = 'current_revision'")
      .get() as { value: string };
    return Number(row.value);
  }

  /** 开始一次整份替换导入；revision 为调用方提供的唯一正整数。 */
  beginImport(revision: number): void {
    assertValidRevision(revision);
    const existing = this.db
      .prepare("SELECT status FROM revisions WHERE revision = ?")
      .get(revision) as { status: string } | undefined;
    if (existing !== undefined) {
      throw new Error(`revision ${revision} already exists (${existing.status})`);
    }
    this.db
      .prepare("INSERT INTO revisions (revision, status) VALUES (?, 'importing')")
      .run(revision);
  }

  /** 追加一段域名（调用方需先归一化）；重复条目自动去重。 */
  importChunk(revision: number, domains: string[]): void {
    this.assertImporting(revision);
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO domains (revision, domain) VALUES (?, ?)"
    );
    this.db.exec("BEGIN");
    try {
      for (const domain of domains) {
        insert.run(revision, domain);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * 完成导入：原子地把修订标记为已提交，并把它提升为当前生效修订
   * （仅当其修订号更大；晚完成的旧修订不会回滚新表）。
   */
  commitImport(revision: number): void {
    this.assertImporting(revision);
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("UPDATE revisions SET status = 'committed' WHERE revision = ?")
        .run(revision);
      this.db
        .prepare(
          `UPDATE meta SET value = ?
           WHERE key = 'current_revision' AND CAST(value AS INTEGER) < ?`
        )
        .run(String(revision), revision);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** 中止导入，丢弃未完成的修订数据。 */
  abortImport(revision: number): void {
    this.assertImporting(revision);
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM domains WHERE revision = ?").run(revision);
      this.db.prepare("DELETE FROM revisions WHERE revision = ?").run(revision);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** 读取某修订的完整域名集合（供批次固定使用）。修订 0 为空表。 */
  loadDomains(revision: number): string[] {
    if (revision === 0) {
      return [];
    }
    const row = this.db
      .prepare("SELECT status FROM revisions WHERE revision = ?")
      .get(revision) as { status: string } | undefined;
    if (row === undefined || row.status !== "committed") {
      throw new Error(`revision ${revision} is not committed`);
    }
    const rows = this.db
      .prepare("SELECT domain FROM domains WHERE revision = ?")
      .all(revision) as { domain: string }[];
    return rows.map((r) => r.domain);
  }

  /** 回收除 keep 之外、且非当前生效的已提交修订。 */
  gcRevisions(keep: Set<number>): void {
    const current = this.currentRevision();
    const rows = this.db
      .prepare("SELECT revision FROM revisions WHERE status = 'committed'")
      .all() as { revision: number }[];
    const collect = rows
      .map((r) => r.revision)
      .filter((rev) => rev !== current && !keep.has(rev));
    if (collect.length === 0) {
      return;
    }
    const deleteDomains = this.db.prepare(
      "DELETE FROM domains WHERE revision = ?"
    );
    const deleteRevision = this.db.prepare(
      "DELETE FROM revisions WHERE revision = ?"
    );
    this.db.exec("BEGIN");
    try {
      for (const rev of collect) {
        deleteDomains.run(rev);
        deleteRevision.run(rev);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  private assertImporting(revision: number): void {
    const row = this.db
      .prepare("SELECT status FROM revisions WHERE revision = ?")
      .get(revision) as { status: string } | undefined;
    if (row === undefined) {
      throw new Error(`revision ${revision} has no import in progress`);
    }
    if (row.status !== "importing") {
      throw new Error(`revision ${revision} is already ${row.status}`);
    }
  }
}

function assertValidRevision(revision: number): void {
  if (!Number.isInteger(revision) || revision <= 0) {
    throw new Error(`revision must be a positive integer, got ${revision}`);
  }
}
