import { DatabaseSync } from 'node:sqlite';

export interface OperationRow {
  idempotencyKey: string;
  requestId: string;
  repoPath: string;
  sourceCommit: string;
  targetBranch: string;
  baseline: string;
  state: 'pending' | 'succeeded' | 'failed';
  resultCommit: string | null;
  failureReason: string | null;
  failureMessage: string | null;
}

interface RawRow {
  idempotency_key: string;
  request_id: string;
  repo_path: string;
  source_commit: string;
  target_branch: string;
  baseline: string;
  state: string;
  result_commit: string | null;
  failure_reason: string | null;
  failure_message: string | null;
}

function toRow(raw: RawRow): OperationRow {
  return {
    idempotencyKey: raw.idempotency_key,
    requestId: raw.request_id,
    repoPath: raw.repo_path,
    sourceCommit: raw.source_commit,
    targetBranch: raw.target_branch,
    baseline: raw.baseline,
    state: raw.state as OperationRow['state'],
    resultCommit: raw.result_commit,
    failureReason: raw.failure_reason,
    failureMessage: raw.failure_message,
  };
}

/** SQLite 持久化层：合并请求状态与重试结果。 */
export class MergeStore {
  private readonly db: DatabaseSync;

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
        state TEXT NOT NULL CHECK (state IN ('pending', 'succeeded', 'failed')),
        result_commit TEXT,
        failure_reason TEXT,
        failure_message TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE INDEX IF NOT EXISTS idx_operations_request ON operations (request_id, state);
    `);
  }

  close(): void {
    this.db.close();
  }

  /**
   * 以幂等键领取操作：不存在则插入 pending 记录（claimed=true），
   * 已存在则返回原记录（claimed=false）；参数不一致时抛错。
   */
  claimOperation(input: {
    idempotencyKey: string;
    requestId: string;
    repoPath: string;
    sourceCommit: string;
    targetBranch: string;
    baseline: string;
  }): { row: OperationRow; claimed: boolean } {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO operations
        (idempotency_key, request_id, repo_path, source_commit, target_branch, baseline, state)
      VALUES (?, ?, ?, ?, ?, ?, 'pending')
    `);
    const { changes } = insert.run(
      input.idempotencyKey,
      input.requestId,
      input.repoPath,
      input.sourceCommit,
      input.targetBranch,
      input.baseline,
    );
    const row = this.getByKey(input.idempotencyKey);
    if (!row) throw new Error('failed to claim operation');
    if (Number(changes) === 0) {
      const mismatch =
        row.requestId !== input.requestId ||
        row.repoPath !== input.repoPath ||
        row.sourceCommit !== input.sourceCommit ||
        row.targetBranch !== input.targetBranch;
      if (mismatch) {
        throw new Error(
          `idempotency key ${input.idempotencyKey} was used with different parameters`,
        );
      }
    }
    return { row, claimed: Number(changes) > 0 };
  }

  markSucceeded(idempotencyKey: string, commitId: string): void {
    this.db
      .prepare(
        `UPDATE operations
         SET state = 'succeeded', result_commit = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE idempotency_key = ?`,
      )
      .run(commitId, idempotencyKey);
  }

  markFailed(idempotencyKey: string, reason: string, message: string): void {
    this.db
      .prepare(
        `UPDATE operations
         SET state = 'failed', failure_reason = ?, failure_message = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE idempotency_key = ?`,
      )
      .run(reason, message, idempotencyKey);
  }

  getByKey(idempotencyKey: string): OperationRow | null {
    const raw = this.db
      .prepare('SELECT * FROM operations WHERE idempotency_key = ?')
      .get(idempotencyKey) as RawRow | undefined;
    return raw ? toRow(raw) : null;
  }

  /** 同一合并请求是否已有成功终态。 */
  getSucceededByRequest(requestId: string): OperationRow | null {
    const raw = this.db
      .prepare(
        `SELECT * FROM operations WHERE request_id = ? AND state = 'succeeded' LIMIT 1`,
      )
      .get(requestId) as RawRow | undefined;
    return raw ? toRow(raw) : null;
  }

  /** 所有未完成的操作（用于恢复）。 */
  listPending(): OperationRow[] {
    const raws = this.db
      .prepare(`SELECT * FROM operations WHERE state = 'pending' ORDER BY created_at`)
      .all() as unknown as RawRow[];
    return raws.map(toRow);
  }
}
