import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from './database.js';
import type {
  BatchView,
  ClaimedTask,
  EnqueueBatchInput,
  EnqueueBatchResult,
  Priority,
  RenderQueueOptions,
  SubmitResult,
  TaskStatus,
  TaskView,
} from './types.js';

/** Fixed lease duration in milliseconds. */
export const LEASE_MS = 60_000;

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export class RenderQueue {
  private readonly db: Database;
  private readonly resultsDir: string;

  constructor(options: RenderQueueOptions) {
    this.db = new Database(join(options.dir, 'queue.db'));
    this.resultsDir = join(options.dir, 'results');
  }

  async open(): Promise<void> {
    mkdirSync(this.resultsDir, { recursive: true });
    await this.db.open();
  }

  async enqueueBatch(input: EnqueueBatchInput): Promise<EnqueueBatchResult> {
    const { batchId, priority, cameras } = input;
    if (!batchId) throw new Error('batchId must be non-empty');
    if (!Number.isInteger(priority) || priority < 1 || priority > 5) {
      throw new Error('priority must be an integer between 1 and 5');
    }
    if (!Array.isArray(cameras) || cameras.length === 0) {
      throw new Error('cameras must be a non-empty array');
    }
    const contentHash = sha256(JSON.stringify({ priority, cameras }));

    const existing = this.db.queryOne('SELECT * FROM batches WHERE id = ?', [batchId]);
    if (existing) {
      if (existing.content_hash !== contentHash) {
        throw new Error(`batch ${batchId} already exists with different content`);
      }
      const count = this.db.queryOne(
        'SELECT COUNT(*) AS n FROM tasks WHERE batch_id = ?',
        [batchId],
      );
      return { batchId, created: false, taskCount: Number(count?.n ?? 0) };
    }

    return this.db.transaction(() => {
      const seqRow = this.db.queryOne('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM batches');
      const seq = Number(seqRow?.seq ?? 1);
      this.db.runInTransaction(
        'INSERT INTO batches (id, seq, priority, content_hash) VALUES (?, ?, ?, ?)',
        [batchId, seq, priority, contentHash],
      );
      cameras.forEach((camera, index) => {
        this.db.runInTransaction(
          'INSERT INTO tasks (batch_id, camera_index, camera) VALUES (?, ?, ?)',
          [batchId, index, camera],
        );
      });
      return { batchId, created: true, taskCount: cameras.length };
    });
  }

  claim(now: number): ClaimedTask | null {
    const candidate = this.db.queryOne(
      `SELECT t.id AS task_id, t.camera, t.camera_index, b.id AS batch_id, b.priority
       FROM tasks t
       JOIN batches b ON b.id = t.batch_id
       WHERE t.status = 'pending'
         AND NOT EXISTS (
           SELECT 1 FROM attempts a
           WHERE a.task_id = t.id AND a.status = 'active' AND a.expires_at > ?
         )
       ORDER BY b.priority ASC, b.seq ASC, t.camera_index ASC
       LIMIT 1`,
      [now],
    );
    if (!candidate) return null;

    const attemptId = randomUUID();
    const expiresAt = now + LEASE_MS;
    this.db.transaction(() => {
      this.db.runInTransaction(
        "UPDATE attempts SET status = 'superseded' WHERE task_id = ? AND status = 'active'",
        [candidate.task_id],
      );
      this.db.runInTransaction(
        "INSERT INTO attempts (id, task_id, leased_at, expires_at, status) VALUES (?, ?, ?, ?, 'active')",
        [attemptId, candidate.task_id, now, expiresAt],
      );
    });

    return {
      taskId: Number(candidate.task_id),
      attemptId,
      batchId: String(candidate.batch_id),
      camera: String(candidate.camera),
      priority: Number(candidate.priority) as Priority,
      leasedAt: now,
      leaseExpiresAt: expiresAt,
    };
  }

  submit(attemptId: string, sourceFilePath: string, now: number): SubmitResult {
    const attempt = this.db.queryOne('SELECT * FROM attempts WHERE id = ?', [attemptId]);
    if (!attempt) return { status: 'rejected', reason: 'unknown-attempt' };

    const task = this.db.queryOne('SELECT * FROM tasks WHERE id = ?', [attempt.task_id]);
    if (!task) return { status: 'rejected', reason: 'unknown-attempt' };
    const taskId = Number(task.id);

    if (task.status === 'completed') {
      if (task.completed_attempt_id !== attemptId) {
        return { status: 'rejected', reason: 'stale-attempt', taskId };
      }
      const bytes = readFileSync(sourceFilePath);
      if (sha256(bytes) === attempt.result_sha256) {
        return { status: 'duplicate', taskId };
      }
      return { status: 'rejected', reason: 'byte-mismatch', taskId };
    }

    if (attempt.status !== 'active') {
      return { status: 'rejected', reason: 'stale-attempt', taskId };
    }
    if (now >= Number(attempt.expires_at)) {
      return { status: 'rejected', reason: 'lease-expired', taskId };
    }

    const bytes = readFileSync(sourceFilePath);
    const hash = sha256(bytes);
    const fileName = `task-${taskId}.bin`;
    const finalPath = join(this.resultsDir, fileName);
    const tmpPath = join(this.resultsDir, `.${fileName}.${process.pid}.tmp`);
    writeFileSync(tmpPath, bytes);
    renameSync(tmpPath, finalPath);

    this.db.transaction(() => {
      this.db.runInTransaction(
        "UPDATE attempts SET status = 'completed', result_path = ?, result_sha256 = ? WHERE id = ?",
        [fileName, hash, attemptId],
      );
      this.db.runInTransaction(
        "UPDATE tasks SET status = 'completed', completed_attempt_id = ? WHERE id = ?",
        [attemptId, taskId],
      );
    });

    return { status: 'accepted', taskId };
  }

  getBatch(batchId: string, now?: number): BatchView | null {
    const batch = this.db.queryOne('SELECT * FROM batches WHERE id = ?', [batchId]);
    if (!batch) return null;

    const tasks = this.db.query(
      'SELECT * FROM tasks WHERE batch_id = ? ORDER BY camera_index ASC',
      [batchId],
    );
    const views: TaskView[] = tasks.map((task) => {
      const taskId = Number(task.id);
      let status: TaskStatus;
      if (task.status === 'completed') {
        status = 'completed';
      } else {
        const lease = this.db.queryOne(
          "SELECT 1 AS x FROM attempts WHERE task_id = ? AND status = 'active' AND expires_at > ?",
          [taskId, now ?? Number.NEGATIVE_INFINITY],
        );
        status = lease ? 'leased' : 'pending';
      }
      const view: TaskView = { taskId, camera: String(task.camera), status };
      if (status === 'completed') {
        const attempt = this.db.queryOne(
          'SELECT result_path FROM attempts WHERE id = ?',
          [task.completed_attempt_id],
        );
        const fileName = String(attempt?.result_path);
        const fullPath = join(this.resultsDir, fileName);
        view.result = { path: fullPath, read: () => readFileSync(fullPath) };
      }
      return view;
    });

    return {
      batchId,
      priority: Number(batch.priority) as Priority,
      complete: views.every((view) => view.status === 'completed'),
      tasks: views,
    };
  }

  close(): void {
    this.db.close();
  }
}
