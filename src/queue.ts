import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db";
import {
  BatchInput,
  LEASE_MS,
  BatchView,
  ClaimedTask,
  EnqueuedBatch,
  Priority,
  RenderQueueOptions,
  SubmitResult,
  TaskView,
} from "./types";

export class RenderQueue {
  private readonly db: DatabaseSync;
  private readonly artifactsDir: string;
  private readonly now: () => number;
  private closed = false;

  constructor(options: RenderQueueOptions) {
    mkdirSync(options.dataDir, { recursive: true });
    this.artifactsDir = join(options.dataDir, "artifacts");
    mkdirSync(this.artifactsDir, { recursive: true });
    this.db = openDatabase(join(options.dataDir, "queue.db"));
    this.now = options.now;
  }

  enqueueBatch(input: BatchInput): EnqueuedBatch {
    validateBatchInput(input);
    const contentHash = hashContent(input.priority, input.cameras.map((c) => c.cameraId));

    const existing = this.db
      .prepare("SELECT id, priority, content_hash FROM batches WHERE id = ?")
      .get(input.batchId) as { id: string; priority: number; content_hash: string } | undefined;

    if (existing !== undefined) {
      if (existing.content_hash !== contentHash) {
        throw new Error(
          `batch "${input.batchId}" already exists with different content`,
        );
      }
      const taskIds = (
        this.db
          .prepare("SELECT id FROM tasks WHERE batch_id = ? ORDER BY camera_seq")
          .all(input.batchId) as Array<{ id: number }>
      ).map((row) => row.id);
      return {
        batchId: input.batchId,
        priority: existing.priority as Priority,
        taskIds,
        alreadyExisted: true,
      };
    }

    this.db.exec("BEGIN");
    try {
      const seq = (
        this.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM batches").get() as {
          next: number;
        }
      ).next;
      this.db
        .prepare("INSERT INTO batches (id, priority, content_hash, seq) VALUES (?, ?, ?, ?)")
        .run(input.batchId, input.priority, contentHash, seq);
      const insertTask = this.db.prepare(
        "INSERT INTO tasks (batch_id, camera_seq, camera_id, status) VALUES (?, ?, ?, 'pending')",
      );
      const taskIds: number[] = [];
      input.cameras.forEach((camera, index) => {
        const result = insertTask.run(input.batchId, index, camera.cameraId);
        taskIds.push(Number(result.lastInsertRowid));
      });
      this.db.exec("COMMIT");
      return { batchId: input.batchId, priority: input.priority, taskIds, alreadyExisted: false };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  claim(): ClaimedTask | null {
    const now = this.now();
    this.db.exec("BEGIN");
    try {
      const row = this.db
        .prepare(
          `SELECT t.id AS task_id, t.batch_id, t.camera_id, b.priority
           FROM tasks t
           JOIN batches b ON b.id = t.batch_id
           LEFT JOIN attempts a ON a.id = t.current_attempt_id
           WHERE t.status = 'pending'
              OR (t.status = 'leased' AND a.expires_at <= ?)
           ORDER BY b.priority, b.seq, t.camera_seq
           LIMIT 1`,
        )
        .get(now) as
        | { task_id: number; batch_id: string; camera_id: string; priority: number }
        | undefined;

      if (row === undefined) {
        this.db.exec("COMMIT");
        return null;
      }

      const expiresAt = now + LEASE_MS;
      const attemptId = Number(
        this.db
          .prepare("INSERT INTO attempts (task_id, leased_at, expires_at) VALUES (?, ?, ?)")
          .run(row.task_id, now, expiresAt).lastInsertRowid,
      );
      this.db
        .prepare("UPDATE tasks SET status = 'leased', current_attempt_id = ? WHERE id = ?")
        .run(attemptId, row.task_id);
      this.db.exec("COMMIT");

      return {
        attemptId,
        taskId: row.task_id,
        batchId: row.batch_id,
        cameraId: row.camera_id,
        priority: row.priority as Priority,
        leasedAt: now,
        expiresAt,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  submitResult(attemptId: number, sourceFilePath: string): SubmitResult {
    const now = this.now();
    const attempt = this.db
      .prepare("SELECT id, task_id, leased_at, expires_at FROM attempts WHERE id = ?")
      .get(attemptId) as
      | { id: number; task_id: number; leased_at: number; expires_at: number }
      | undefined;
    if (attempt === undefined) {
      return { ok: false, reason: "unknown-attempt" };
    }

    const task = this.db
      .prepare(
        "SELECT id, status, current_attempt_id, completed_attempt_id, artifact_path FROM tasks WHERE id = ?",
      )
      .get(attempt.task_id) as {
      id: number;
      status: string;
      current_attempt_id: number | null;
      completed_attempt_id: number | null;
      artifact_path: string | null;
    };

    if (task.status === "succeeded") {
      if (task.completed_attempt_id !== attemptId || task.artifact_path === null) {
        return { ok: false, reason: "superseded" };
      }
      let sourceBytes: Buffer;
      try {
        sourceBytes = readFileSync(sourceFilePath);
      } catch {
        return { ok: false, reason: "artifact-missing" };
      }
      const storedBytes = readFileSync(task.artifact_path);
      if (!storedBytes.equals(sourceBytes)) {
        // Never overwrite a stored artifact with different bytes.
        return { ok: false, reason: "conflicting-bytes" };
      }
      // Idempotent replay of the successful submission.
      return {
        ok: true,
        taskId: task.id,
        attemptId,
        artifactPath: task.artifact_path,
      };
    }

    if (task.current_attempt_id !== attemptId) {
      return { ok: false, reason: "superseded" };
    }
    if (now >= attempt.expires_at) {
      return { ok: false, reason: "lease-expired" };
    }

    let sourceBytes: Buffer;
    try {
      sourceBytes = readFileSync(sourceFilePath);
    } catch {
      return { ok: false, reason: "artifact-missing" };
    }

    const artifactPath = join(
      this.artifactsDir,
      `task-${task.id}-attempt-${attemptId}.bin`,
    );
    this.db.exec("BEGIN");
    try {
      writeFileSync(artifactPath, sourceBytes);
      this.db
        .prepare(
          "UPDATE tasks SET status = 'succeeded', completed_attempt_id = ?, artifact_path = ? WHERE id = ?",
        )
        .run(attemptId, artifactPath, task.id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { ok: true, taskId: task.id, attemptId, artifactPath };
  }

  getBatch(batchId: string): BatchView | null {
    const batch = this.db
      .prepare("SELECT id, priority FROM batches WHERE id = ?")
      .get(batchId) as { id: string; priority: number } | undefined;
    if (batch === undefined) {
      return null;
    }
    const rows = this.db
      .prepare(
        "SELECT id, camera_id, status, artifact_path FROM tasks WHERE batch_id = ? ORDER BY camera_seq",
      )
      .all(batchId) as Array<{
      id: number;
      camera_id: string;
      status: string;
      artifact_path: string | null;
    }>;

    const tasks = rows.map((row) => {
      const succeeded = row.status === "succeeded" && row.artifact_path !== null;
      return {
        taskId: row.id,
        cameraId: row.camera_id,
        status: row.status as TaskView["status"],
        artifactPath: succeeded ? row.artifact_path : null,
        artifactBytes: succeeded ? readFileSync(row.artifact_path as string) : null,
      };
    });
    return {
      batchId: batch.id,
      priority: batch.priority as Priority,
      complete: tasks.length > 0 && tasks.every((task) => task.status === "succeeded"),
      tasks,
    };
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
}

function validateBatchInput(input: BatchInput): void {
  if (typeof input.batchId !== "string" || input.batchId.length === 0) {
    throw new Error("batchId must be a non-empty string");
  }
  if (!Number.isInteger(input.priority) || input.priority < 1 || input.priority > 5) {
    throw new Error("priority must be an integer between 1 and 5");
  }
  if (!Array.isArray(input.cameras) || input.cameras.length === 0) {
    throw new Error("cameras must be a non-empty array");
  }
  const seen = new Set<string>();
  for (const camera of input.cameras) {
    if (typeof camera.cameraId !== "string" || camera.cameraId.length === 0) {
      throw new Error("cameraId must be a non-empty string");
    }
    if (seen.has(camera.cameraId)) {
      throw new Error(`duplicate cameraId "${camera.cameraId}" in batch`);
    }
    seen.add(camera.cameraId);
  }
}

function hashContent(priority: Priority, cameraIds: string[]): string {
  // Content identity: priority plus the ordered camera list. A retry with the
  // same batch id and identical content maps back to the original batch.
  let hash = 0x811c9dc5;
  const text = `${priority}${cameraIds.join("")}`;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16);
}
