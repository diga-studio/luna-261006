import { DatabaseSync } from "node:sqlite";
import { ReleaseInfo } from "./types";

export interface RequestRecord {
  kind: string;
  result: string;
}

export interface RunState {
  generation: number;
  currentReleaseId: number | null;
}

/**
 * SQLite 持久化层。
 * 业务真源：发布记录、淘汰标记、当前运行代次/发布、请求幂等结果、连续失败证据。
 * 所有多步写入都包在事务里，崩溃后要么整体生效要么整体未发生。
 */
export class Database {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS releases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at_ms INTEGER NOT NULL,
        eliminated INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS requests (
        request_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        result TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  /** 在 IMMEDIATE 事务中执行 fn；异常即回滚。 */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // 回滚失败时连接已不可用，由上层关闭重建。
      }
      throw err;
    }
  }

  getRequest(requestId: string): RequestRecord | null {
    const row = this.db
      .prepare("SELECT kind, result FROM requests WHERE request_id = ?")
      .get(requestId) as { kind: string; result: string } | undefined;
    return row ? { kind: row.kind, result: row.result } : null;
  }

  recordRequest(requestId: string, kind: string, result: string): void {
    this.db
      .prepare("INSERT INTO requests (request_id, kind, result) VALUES (?, ?, ?)")
      .run(requestId, kind, result);
  }

  /** 下一个发布 ID（发布目录命名需要先定 ID 再落盘，提交时显式使用该 ID）。 */
  nextReleaseId(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM releases").get() as {
      next_id: number;
    };
    return Number(row.next_id);
  }

  insertRelease(id: number, createdAtMs: number): void {
    this.db
      .prepare("INSERT INTO releases (id, created_at_ms, eliminated) VALUES (?, ?, 0)")
      .run(id, createdAtMs);
  }

  eliminateRelease(id: number): void {
    this.db.prepare("UPDATE releases SET eliminated = 1 WHERE id = ?").run(id);
  }

  /** 在 id 之前的发布历史中，逆序找最近一个未被淘汰的发布。 */
  findRollbackCandidate(beforeId: number): number | null {
    const row = this.db
      .prepare(
        "SELECT id FROM releases WHERE id < ? AND eliminated = 0 ORDER BY id DESC LIMIT 1"
      )
      .get(beforeId) as { id: number } | undefined;
    return row ? Number(row.id) : null;
  }

  listReleases(): ReleaseInfo[] {
    const rows = this.db
      .prepare("SELECT id, created_at_ms, eliminated FROM releases ORDER BY id ASC")
      .all() as unknown as { id: number; created_at_ms: number; eliminated: number }[];
    return rows.map((r) => ({
      id: Number(r.id),
      createdAtMs: Number(r.created_at_ms),
      eliminated: r.eliminated !== 0,
    }));
  }

  getRunState(): RunState {
    const generation = Number(this.getMeta("generation") ?? "0");
    const raw = this.getMeta("current_release_id");
    return { generation, currentReleaseId: raw === null || raw === "" ? null : Number(raw) };
  }

  setRunState(state: RunState): void {
    this.setMeta("generation", String(state.generation));
    this.setMeta(
      "current_release_id",
      state.currentReleaseId === null ? "" : String(state.currentReleaseId)
    );
  }

  /** 当前运行代次的连续失败时间戳（最多保留最近 3 次）。 */
  getFailEvidence(): number[] {
    const raw = this.getMeta("fail_evidence");
    if (!raw) return [];
    const parsed = JSON.parse(raw) as number[];
    return Array.isArray(parsed) ? parsed.map(Number) : [];
  }

  setFailEvidence(timestamps: number[]): void {
    this.setMeta("fail_evidence", JSON.stringify(timestamps));
  }

  private getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  private setMeta(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }
}
