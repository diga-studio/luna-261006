import { DatabaseSync } from "node:sqlite";

export interface GatewayState {
  generation: number;
  currentReleaseId: number | null;
}

export interface ReleaseRow {
  id: number;
  createdAt: number;
  eliminated: boolean;
}

export interface ReportRow {
  id: number;
  generation: number;
  timestamp: number;
  success: boolean;
}

export interface StoredRequest {
  kind: string;
  resultJson: string;
}

export interface RollbackCommit {
  eliminatedReleaseId: number;
  targetReleaseId: number | null;
}

/** SQLite 持久化层：发布记录、去重请求、推理报告、当前状态。 */
export class Database {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS releases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        eliminated INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS requests (
        request_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        result_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        success INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        generation INTEGER NOT NULL,
        current_release_id INTEGER
      );
      INSERT OR IGNORE INTO state (id, generation, current_release_id)
      VALUES (1, 0, NULL);
    `);
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  getState(): GatewayState {
    const row = this.db
      .prepare("SELECT generation, current_release_id AS currentReleaseId FROM state WHERE id = 1")
      .get() as { generation: number; currentReleaseId: number | null };
    return { generation: row.generation, currentReleaseId: row.currentReleaseId };
  }

  findRequest(requestId: string): StoredRequest | null {
    const row = this.db
      .prepare("SELECT kind, result_json AS resultJson FROM requests WHERE request_id = ?")
      .get(requestId) as { kind: string; resultJson: string } | undefined;
    return row ?? null;
  }

  nextReleaseId(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM releases").get() as {
      nextId: number;
    };
    return row.nextId;
  }

  /** 原子提交一次发布：新增发布记录、推进运行代次、登记请求结果。 */
  commitPublish(requestId: string, createdAt: number, resultJson: string): void {
    this.transaction(() => {
      this.db.prepare("INSERT INTO releases (created_at, eliminated) VALUES (?, 0)").run(createdAt);
      const release = this.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number };
      this.db
        .prepare("UPDATE state SET generation = generation + 1, current_release_id = ? WHERE id = 1")
        .run(release.id);
      this.db
        .prepare("INSERT INTO requests (request_id, kind, result_json) VALUES (?, 'publish', ?)")
        .run(requestId, resultJson);
    });
  }

  /**
   * 原子提交一次推理报告：登记有效报告、可选执行回退（淘汰当前发布并切换状态）、
   * 登记请求结果。rollback 为 null 表示未触发回退。
   */
  commitReport(
    requestId: string,
    report: { generation: number; timestamp: number; success: boolean } | null,
    rollback: RollbackCommit | null,
    resultJson: string,
  ): void {
    this.transaction(() => {
      if (report !== null) {
        this.db
          .prepare("INSERT INTO reports (request_id, generation, ts, success) VALUES (?, ?, ?, ?)")
          .run(requestId, report.generation, report.timestamp, report.success ? 1 : 0);
      }
      if (rollback !== null) {
        this.db
          .prepare("UPDATE releases SET eliminated = 1 WHERE id = ?")
          .run(rollback.eliminatedReleaseId);
        this.db
          .prepare("UPDATE state SET generation = generation + 1, current_release_id = ? WHERE id = 1")
          .run(rollback.targetReleaseId);
      }
      this.db
        .prepare("INSERT INTO requests (request_id, kind, result_json) VALUES (?, 'report', ?)")
        .run(requestId, resultJson);
    });
  }

  /** 某运行代次最近的报告（按到达顺序逆序）。 */
  recentReports(generation: number, limit: number): ReportRow[] {
    const rows = this.db
      .prepare(
        "SELECT id, generation, ts AS timestamp, success FROM reports WHERE generation = ? ORDER BY id DESC LIMIT ?",
      )
      .all(generation, limit) as Array<{ id: number; generation: number; timestamp: number; success: number }>;
    return rows.map((row) => ({ ...row, success: row.success === 1 }));
  }

  /** 在早于 beforeReleaseId 的发布中，逆序找最近一个未被淘汰的。 */
  findRollbackTarget(beforeReleaseId: number): number | null {
    const row = this.db
      .prepare("SELECT id FROM releases WHERE id < ? AND eliminated = 0 ORDER BY id DESC LIMIT 1")
      .get(beforeReleaseId) as { id: number } | undefined;
    return row ? row.id : null;
  }

  listReleases(): ReleaseRow[] {
    const rows = this.db
      .prepare("SELECT id, created_at AS createdAt, eliminated FROM releases ORDER BY id ASC")
      .all() as Array<{ id: number; createdAt: number; eliminated: number }>;
    return rows.map((row) => ({ ...row, eliminated: row.eliminated === 1 }));
  }
}
