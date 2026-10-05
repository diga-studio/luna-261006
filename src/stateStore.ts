import { DatabaseSync } from 'node:sqlite';
import { BatchStatus, DbState } from './types';

export interface BatchRow {
  batchId: string;
  status: BatchStatus;
  startVersion: number;
  sql: string;
  dbPaths: string[];
}

export interface BatchDbRow {
  batchId: string;
  idx: number;
  path: string;
  state: DbState;
}

/**
 * 批次状态库：把批次与逐库进度持久化到本地 SQLite 文件。
 * 每次写操作独立提交，保证进程在任意两步之间被杀死时状态一致。
 */
export class StateStore {
  private readonly db: DatabaseSync;

  constructor(stateDbPath: string) {
    this.db = new DatabaseSync(stateDbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS batches (
        batch_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        start_version INTEGER NOT NULL,
        sql TEXT NOT NULL,
        db_paths TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS batch_dbs (
        batch_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        path TEXT NOT NULL,
        state TEXT NOT NULL,
        PRIMARY KEY (batch_id, idx)
      );
    `);
  }

  createBatch(row: BatchRow): void {
    this.db
      .prepare(
        'INSERT INTO batches (batch_id, status, start_version, sql, db_paths) VALUES (?, ?, ?, ?, ?)',
      )
      .run(row.batchId, row.status, row.startVersion, row.sql, JSON.stringify(row.dbPaths));
    const insertDb = this.db.prepare(
      'INSERT INTO batch_dbs (batch_id, idx, path, state) VALUES (?, ?, ?, ?)',
    );
    row.dbPaths.forEach((p, idx) => {
      insertDb.run(row.batchId, idx, p, 'pending');
    });
  }

  getBatch(batchId: string): BatchRow | undefined {
    const r = this.db
      .prepare('SELECT * FROM batches WHERE batch_id = ?')
      .get(batchId) as
      | { batch_id: string; status: string; start_version: number; sql: string; db_paths: string }
      | undefined;
    if (!r) return undefined;
    return {
      batchId: r.batch_id,
      status: r.status as BatchStatus,
      startVersion: r.start_version,
      sql: r.sql,
      dbPaths: JSON.parse(r.db_paths) as string[],
    };
  }

  getUnfinishedBatch(): BatchRow | undefined {
    const r = this.db
      .prepare("SELECT batch_id FROM batches WHERE status IN ('publishing', 'rolling_back')")
      .get() as { batch_id: string } | undefined;
    return r ? this.getBatch(r.batch_id) : undefined;
  }

  listDbRows(batchId: string): BatchDbRow[] {
    const rows = this.db
      .prepare('SELECT * FROM batch_dbs WHERE batch_id = ? ORDER BY idx')
      .all(batchId) as unknown as { batch_id: string; idx: number; path: string; state: string }[];
    return rows.map((r) => ({
      batchId: r.batch_id,
      idx: r.idx,
      path: r.path,
      state: r.state as DbState,
    }));
  }

  setDbState(batchId: string, idx: number, state: DbState): void {
    this.db
      .prepare('UPDATE batch_dbs SET state = ? WHERE batch_id = ? AND idx = ?')
      .run(state, batchId, idx);
  }

  setBatchStatus(batchId: string, status: BatchStatus): void {
    this.db.prepare('UPDATE batches SET status = ? WHERE batch_id = ?').run(status, batchId);
  }

  close(): void {
    this.db.close();
  }
}
