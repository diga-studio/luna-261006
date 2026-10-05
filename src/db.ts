import { DatabaseSync } from 'node:sqlite';
import type { FailureReason, OperationStatus } from './types.js';

export interface OperationRow {
  idempotencyKey: string;
  requestId: string;
  repoPath: string;
  sourceCommit: string;
  targetBranch: string;
  baseline: string;
  message: string;
  squashCommit: string | null;
  status: OperationStatus;
  failureReason: FailureReason | null;
  error: string | null;
}

interface RawRow {
  idempotency_key: string;
  request_id: string;
  repo_path: string;
  source_commit: string;
  target_branch: string;
  baseline: string;
  message: string;
  squash_commit: string | null;
  status: string;
  failure_reason: string | null;
  error: string | null;
}

function toRow(r: RawRow): OperationRow {
  return {
    idempotencyKey: r.idempotency_key,
    requestId: r.request_id,
    repoPath: r.repo_path,
    sourceCommit: r.source_commit,
    targetBranch: r.target_branch,
    baseline: r.baseline,
    message: r.message,
    squashCommit: r.squash_commit,
    status: r.status as OperationStatus,
    failureReason: r.failure_reason as FailureReason | null,
    error: r.error,
  };
}

/** SQLite 持久化层：保存操作状态与终态结果（无过期）。 */
export class OperationStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS operations (
        idempotency_key TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        repo_path TEXT NOT NULL,
        source_commit TEXT NOT NULL,
        target_branch TEXT NOT NULL,
        baseline TEXT NOT NULL,
        message TEXT NOT NULL DEFAULT '',
        squash_commit TEXT,
        status TEXT NOT NULL,
        failure_reason TEXT,
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_operations_request
        ON operations(request_id, status);
    `);
  }

  /** 按幂等键查询操作。 */
  getByKey(idempotencyKey: string): OperationRow | null {
    const row = this.db
      .prepare('SELECT * FROM operations WHERE idempotency_key = ?')
      .get(idempotencyKey) as RawRow | undefined;
    return row ? toRow(row) : null;
  }

  /** 查询某请求已成功落盘的终态操作。 */
  getSucceededByRequest(requestId: string): OperationRow | null {
    const row = this.db
      .prepare(
        "SELECT * FROM operations WHERE request_id = ? AND status = 'succeeded' ORDER BY created_at LIMIT 1",
      )
      .get(requestId) as RawRow | undefined;
    return row ? toRow(row) : null;
  }

  /** 列出未完成（pending）操作，可按请求过滤。 */
  listPending(requestId?: string): OperationRow[] {
    const rows = (
      requestId === undefined
        ? this.db
            .prepare("SELECT * FROM operations WHERE status = 'pending' ORDER BY created_at")
            .all()
        : this.db
            .prepare(
              "SELECT * FROM operations WHERE status = 'pending' AND request_id = ? ORDER BY created_at",
            )
            .all(requestId)
    ) as unknown as RawRow[];
    return rows.map(toRow);
  }

  /** 首次受理时插入 pending 记录（固定基线）。 */
  insertPending(
    row: Omit<OperationRow, 'squashCommit' | 'status' | 'failureReason' | 'error'>,
  ): void {
    this.db
      .prepare(
        `INSERT INTO operations
          (idempotency_key, request_id, repo_path, source_commit, target_branch, baseline, message, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
      )
      .run(
        row.idempotencyKey,
        row.requestId,
        row.repoPath,
        row.sourceCommit,
        row.targetBranch,
        row.baseline,
        row.message,
      );
  }

  /**
   * 请求已成功后又出现新幂等键：登记一条指向同一终态的别名记录，
   * 使新键查询也得到原成功结果，而不产生新的合并。
   */
  insertSucceededAlias(idempotencyKey: string, src: OperationRow): void {
    this.db
      .prepare(
        `INSERT INTO operations
          (idempotency_key, request_id, repo_path, source_commit, target_branch, baseline, message, squash_commit, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'succeeded')`,
      )
      .run(
        idempotencyKey,
        src.requestId,
        src.repoPath,
        src.sourceCommit,
        src.targetBranch,
        src.baseline,
        src.message,
        src.squashCommit,
      );
  }

  /** 记录已生成的 squash 提交（先于发布落库）。 */
  setSquashCommit(idempotencyKey: string, squashCommit: string): void {
    this.db
      .prepare(
        "UPDATE operations SET squash_commit = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE idempotency_key = ?",
      )
      .run(squashCommit, idempotencyKey);
  }

  markSucceeded(idempotencyKey: string, commit: string): void {
    this.db
      .prepare(
        "UPDATE operations SET status = 'succeeded', squash_commit = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE idempotency_key = ?",
      )
      .run(commit, idempotencyKey);
  }

  markFailed(idempotencyKey: string, reason: FailureReason, error?: string): void {
    this.db
      .prepare(
        "UPDATE operations SET status = 'failed', failure_reason = ?, error = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE idempotency_key = ?",
      )
      .run(reason, error ?? null, idempotencyKey);
  }

  close(): void {
    this.db.close();
  }
}
