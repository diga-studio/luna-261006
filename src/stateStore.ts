import { DatabaseSync } from "node:sqlite";
import { BatchRecord, BatchStatus, DbStepState } from "./types";

const TERMINAL: BatchStatus[] = ["success", "failed"];

interface BatchRow {
  id: string;
  status: string;
  dbs_json: string;
  start_version: number;
  target_version: number;
  sql: string;
  error: string | null;
}

interface DbStateRow {
  idx: number;
  db_path: string;
  state: string;
}

/**
 * 协调器状态库：把批次与单库进度持久化在一个独立的本地 SQLite 文件中。
 * 所有状态迁移先落盘（同步写），再执行对应的文件/数据库操作，
 * 使得进程在任意时刻被杀都能从状态库恢复现场。
 */
export class StateStore {
  private db: DatabaseSync;

  constructor(stateDbPath: string) {
    this.db = new DatabaseSync(stateDbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS batches (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        dbs_json TEXT NOT NULL,
        start_version INTEGER NOT NULL,
        target_version INTEGER NOT NULL,
        sql TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS db_states (
        batch_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        db_path TEXT NOT NULL,
        state TEXT NOT NULL,
        PRIMARY KEY (batch_id, idx)
      );
    `);
  }

  private toRecord(row: BatchRow): BatchRecord {
    return {
      id: row.id,
      status: row.status as BatchStatus,
      dbs: JSON.parse(row.dbs_json) as string[],
      startVersion: row.start_version,
      targetVersion: row.target_version,
      sql: row.sql,
      error: row.error,
    };
  }

  getActiveBatch(): BatchRecord | null {
    const row = this.db
      .prepare("SELECT * FROM batches WHERE status IN ('publishing','rolling_back') ORDER BY created_at LIMIT 1")
      .get() as BatchRow | undefined;
    return row ? this.toRecord(row) : null;
  }

  getBatch(id: string): BatchRecord | null {
    const row = this.db.prepare("SELECT * FROM batches WHERE id = ?").get(id) as BatchRow | undefined;
    return row ? this.toRecord(row) : null;
  }

  createBatch(req: { id: string; dbs: string[]; startVersion: number; sql: string }): BatchRecord {
    const targetVersion = req.startVersion + 1;
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          "INSERT INTO batches (id, status, dbs_json, start_version, target_version, sql, error, created_at) VALUES (?, 'publishing', ?, ?, ?, ?, NULL, ?)"
        )
        .run(req.id, JSON.stringify(req.dbs), req.startVersion, targetVersion, req.sql, new Date().toISOString());
      const insertDb = this.db.prepare("INSERT INTO db_states (batch_id, idx, db_path, state) VALUES (?, ?, ?, 'pending')");
      req.dbs.forEach((dbPath, idx) => {
        insertDb.run(req.id, idx, dbPath);
      });
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    const record = this.getBatch(req.id);
    if (!record) throw new Error("failed to create batch");
    return record;
  }

  /** 终态一旦写入不再改变；对终态批次的后续写入为空操作 */
  setBatchStatus(id: string, status: BatchStatus, error: string | null = null): void {
    this.db
      .prepare(
        `UPDATE batches SET status = ?, error = COALESCE(?, error)
         WHERE id = ? AND status NOT IN ('success', 'failed')`
      )
      .run(status, error, id);
  }

  getDbStates(batchId: string): { index: number; db: string; state: DbStepState }[] {
    const rows = this.db
      .prepare("SELECT idx, db_path, state FROM db_states WHERE batch_id = ? ORDER BY idx")
      .all(batchId) as unknown as DbStateRow[];
    return rows.map((r) => ({ index: r.idx, db: r.db_path, state: r.state as DbStepState }));
  }

  setDbState(batchId: string, index: number, state: DbStepState): void {
    this.db.prepare("UPDATE db_states SET state = ? WHERE batch_id = ? AND idx = ?").run(state, batchId, index);
  }

  isTerminal(status: BatchStatus): boolean {
    return TERMINAL.includes(status);
  }

  close(): void {
    this.db.close();
  }
}
