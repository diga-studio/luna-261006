import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS revisions (
  revision INTEGER PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS rules (
  revision INTEGER NOT NULL,
  domain TEXT NOT NULL,
  labels INTEGER NOT NULL,
  PRIMARY KEY (revision, domain)
);
CREATE TABLE IF NOT EXISTS staging_sessions (
  revision INTEGER PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS staging (
  revision INTEGER NOT NULL,
  domain TEXT NOT NULL,
  PRIMARY KEY (revision, domain)
);
CREATE TABLE IF NOT EXISTS batch_refs (
  token INTEGER PRIMARY KEY AUTOINCREMENT,
  revision INTEGER NOT NULL
);
`;

/** SQLite 持久层：规则表、修订状态、批次引用计数与回收。 */
export class RuleStore {
  protected readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
  }

  /** 当前生效修订号；初始为 0（空表）。 */
  currentRevision(): number {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = 'current_revision'")
      .get() as { value: string } | undefined;
    return row === undefined ? 0 : Number(row.value);
  }

  /** 开启一个修订的暂存导入（整份替换，分段到达）。 */
  beginStaging(revision: number): void {
    if (!Number.isInteger(revision) || revision <= 0) {
      throw new Error(`revision must be a positive integer, got ${revision}`);
    }
    const committed = this.db
      .prepare("SELECT 1 FROM revisions WHERE revision = ?")
      .get(revision);
    if (committed !== undefined) {
      throw new Error(`revision ${revision} already committed`);
    }
    const staging = this.db
      .prepare("SELECT 1 FROM staging_sessions WHERE revision = ?")
      .get(revision);
    if (staging !== undefined) {
      throw new Error(`revision ${revision} already being imported`);
    }
    this.db
      .prepare("INSERT INTO staging_sessions (revision) VALUES (?)")
      .run(revision);
  }

  addToStaging(revision: number, domains: string[]): void {
    this.assertStaging(revision);
    const stmt = this.db.prepare(
      "INSERT OR IGNORE INTO staging (revision, domain) VALUES (?, ?)",
    );
    for (const domain of domains) {
      stmt.run(revision, domain);
    }
  }

  discardStaging(revision: number): void {
    this.assertStaging(revision);
    this.db.prepare("DELETE FROM staging WHERE revision = ?").run(revision);
    this.db
      .prepare("DELETE FROM staging_sessions WHERE revision = ?")
      .run(revision);
  }

  /**
   * 提交暂存修订：仅当其为已成功导入中的最大修订时生效；
   * 晚完成的旧修订保留提交记录但不回滚当前表。返回是否生效。
   */
  commitStaging(revision: number): boolean {
    this.assertStaging(revision);
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT INTO rules (revision, domain, labels)
           SELECT ?, domain, length(domain) - length(replace(domain, '.', '')) + 1
           FROM staging WHERE revision = ?`,
        )
        .run(revision, revision);
      this.db.prepare("DELETE FROM staging WHERE revision = ?").run(revision);
      this.db
        .prepare("DELETE FROM staging_sessions WHERE revision = ?")
        .run(revision);
      this.db
        .prepare("INSERT INTO revisions (revision) VALUES (?)")
        .run(revision);
      const current = this.currentRevision();
      const effective = revision > current;
      if (effective) {
        this.db
          .prepare(
            "INSERT INTO meta (key, value) VALUES ('current_revision', ?) " +
              "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          )
          .run(String(revision));
      }
      this.collectGarbage();
      this.db.exec("COMMIT");
      return effective;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** 在指定修订的规则表中查找完整标签边界上的最长后缀匹配。 */
  lookup(revision: number, normalizedDomain: string): string | null {
    const parts = normalizedDomain.split(".");
    const suffixes: string[] = [];
    for (let i = 0; i < parts.length; i += 1) {
      suffixes.push(parts.slice(i).join("."));
    }
    const placeholders = suffixes.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT domain, labels FROM rules
         WHERE revision = ? AND domain IN (${placeholders})
         ORDER BY labels DESC LIMIT 1`,
      )
      .all(revision, ...suffixes) as { domain: string }[];
    return rows.length === 0 ? null : rows[0].domain;
  }

  /** 批次受理：固定并占用一个修订。返回批次占用令牌。 */
  acquireRevision(revision: number): number {
    const available =
      revision === this.currentRevision() ||
      this.db
        .prepare("SELECT 1 FROM revisions WHERE revision = ?")
        .get(revision) !== undefined;
    if (!available) {
      throw new Error(`revision ${revision} is not available`);
    }
    const result = this.db
      .prepare("INSERT INTO batch_refs (revision) VALUES (?)")
      .run(revision);
    return Number(result.lastInsertRowid);
  }

  /** 批次结束/取消：释放占用；回收失效且无人使用的修订。 */
  releaseRevision(token: number): void {
    this.db.prepare("DELETE FROM batch_refs WHERE token = ?").run(token);
    this.db.exec("BEGIN");
    try {
      this.collectGarbage();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  protected assertStaging(revision: number): void {
    const row = this.db
      .prepare("SELECT 1 FROM staging_sessions WHERE revision = ?")
      .get(revision);
    if (row === undefined) {
      throw new Error(`revision ${revision} has no active import`);
    }
  }

  /** 回收：保留当前生效修订与仍被批次占用的修订，其余已提交修订删除。 */
  protected collectGarbage(): void {
    const current = this.currentRevision();
    this.db
      .prepare(
        `DELETE FROM rules
         WHERE revision != ?
           AND revision NOT IN (SELECT revision FROM batch_refs)`,
      )
      .run(current);
    this.db
      .prepare(
        `DELETE FROM revisions
         WHERE revision != ?
           AND revision NOT IN (SELECT revision FROM batch_refs)`,
      )
      .run(current);
  }
}
