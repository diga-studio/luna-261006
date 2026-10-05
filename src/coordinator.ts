import * as fs from "fs";
import * as path from "path";
import { DatabaseSync } from "node:sqlite";
import { removeFileQuiet, restoreFile, snapshotFile } from "./backup";
import { StateStore } from "./stateStore";
import {
  AdvanceHooks,
  AdvanceResult,
  BatchProgress,
  BatchRecord,
  BatchRequest,
  BatchStatus,
  CrashPoint,
} from "./types";

const TERMINAL: BatchStatus[] = ["success", "failed"];

/** 单库迁移失败（SQL 错误或外键违规），触发整批撤回 */
class MigrationError extends Error {}

/**
 * 金丝雀迁移协调器。
 * 用法：new CanaryMigrator(stateDbPath) -> submit(req) -> advance(id) -> query(id)
 * 进程被杀后重新构造实例再调用 advance(id) 即可从断点继续。
 */
export class CanaryMigrator {
  private store: StateStore;
  private backupsDir: string;

  constructor(stateDbPath: string) {
    this.store = new StateStore(stateDbPath);
    this.backupsDir = path.join(path.dirname(stateDbPath), "backups");
  }

  submit(req: BatchRequest): BatchProgress {
    this.validate(req);
    const existing = this.store.getBatch(req.id);
    if (existing) return this.toProgress(existing);
    const active = this.store.getActiveBatch();
    if (active) {
      throw new Error(`batch "${active.id}" is still active (status=${active.status}); finish it before submitting a new one`);
    }
    const record = this.store.createBatch(req);
    return this.toProgress(record);
  }

  advance(id: string, hooks: AdvanceHooks = {}): AdvanceResult {
    const batch = this.store.getBatch(id);
    if (!batch) throw new Error(`unknown batch "${id}"`);
    if (!TERMINAL.includes(batch.status)) {
      if (batch.status === "publishing") this.publish(batch, hooks);
      const current = this.store.getBatch(id)!;
      if (current.status === "rolling_back") this.rollback(current, hooks);
    }
    const finalBatch = this.store.getBatch(id)!;
    return { id, status: finalBatch.status, error: finalBatch.error };
  }

  query(id: string): BatchProgress | null {
    const batch = this.store.getBatch(id);
    return batch ? this.toProgress(batch) : null;
  }

  close(): void {
    this.store.close();
  }

  // ---- 内部实现 ----

  private validate(req: BatchRequest): void {
    if (!req || typeof req.id !== "string" || req.id.length === 0) throw new Error("batch id must be a non-empty string");
    if (!Array.isArray(req.dbs) || req.dbs.length < 1 || req.dbs.length > 20) {
      throw new Error("batch must contain 1..20 databases");
    }
    if (new Set(req.dbs).size !== req.dbs.length) throw new Error("databases must be unique within a batch");
    if (!Number.isInteger(req.startVersion) || req.startVersion < 0) throw new Error("startVersion must be a non-negative integer");
    if (typeof req.sql !== "string" || req.sql.trim().length === 0) throw new Error("sql must be a non-empty string");
  }

  private toProgress(batch: BatchRecord): BatchProgress {
    const states = this.store.getDbStates(batch.id);
    return {
      id: batch.id,
      status: batch.status,
      startVersion: batch.startVersion,
      targetVersion: batch.targetVersion,
      error: batch.error,
      dbs: states.map((s) => ({ db: s.db, index: s.index, state: s.state })),
    };
  }

  private backupPath(batchId: string, index: number): string {
    return path.join(this.backupsDir, encodeURIComponent(batchId), `${index}.db`);
  }

  private fire(hooks: AdvanceHooks, point: CrashPoint, batchId: string, dbIndex: number | null): void {
    hooks.atPoint?.(point, { batchId, dbIndex });
  }

  /** 发布阶段：按顺序逐库迁移，任何失败都转入撤回 */
  private publish(batch: BatchRecord, hooks: AdvanceHooks): void {
    const states = this.store.getDbStates(batch.id);
    for (const dbState of states) {
      if (dbState.state === "migrated" || dbState.state === "rolled_back") continue;

      if (dbState.state === "pending") {
        this.fire(hooks, "beforeDbBackup", batch.id, dbState.index);
        snapshotFile(dbState.db, this.backupPath(batch.id, dbState.index));
        this.store.setDbState(batch.id, dbState.index, "backed_up");
        this.fire(hooks, "afterDbBackup", batch.id, dbState.index);
      }

      // 此刻快照一定已落盘。若上次在“事务已提交但尚未记录”时被杀，
      // 通过 user_version 识别真实提交结果，避免重做非幂等迁移。
      const version = readUserVersion(dbState.db);
      if (version === batch.targetVersion) {
        this.store.setDbState(batch.id, dbState.index, "migrated");
        this.fire(hooks, "afterDbRecorded", batch.id, dbState.index);
        continue;
      }
      if (version !== batch.startVersion) {
        this.store.setBatchStatus(batch.id, "rolling_back", `db ${dbState.db} is at version ${version}, expected ${batch.startVersion} or ${batch.targetVersion}`);
        return;
      }

      this.fire(hooks, "beforeDbCommit", batch.id, dbState.index);
      try {
        migrateOneDb(dbState.db, batch.sql, batch.targetVersion);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.store.setBatchStatus(batch.id, "rolling_back", `db ${dbState.db}: ${msg}`);
        return;
      }
      this.fire(hooks, "afterDbCommit", batch.id, dbState.index);
      this.store.setDbState(batch.id, dbState.index, "migrated");
      this.fire(hooks, "afterDbRecorded", batch.id, dbState.index);
    }
    this.fire(hooks, "beforeMarkSuccess", batch.id, null);
    this.store.setBatchStatus(batch.id, "success");
    this.cleanupBackups(batch.id);
  }

  /** 撤回阶段：把所有已提交库从快照恢复，最终标记 failed */
  private rollback(batch: BatchRecord, hooks: AdvanceHooks): void {
    const states = this.store.getDbStates(batch.id);
    for (const dbState of [...states].reverse()) {
      if (dbState.state !== "migrated") continue;
      this.fire(hooks, "beforeRestore", batch.id, dbState.index);
      restoreFile(this.backupPath(batch.id, dbState.index), dbState.db);
      this.store.setDbState(batch.id, dbState.index, "rolled_back");
      this.fire(hooks, "afterRestore", batch.id, dbState.index);
    }
    this.fire(hooks, "beforeMarkFailed", batch.id, null);
    this.store.setBatchStatus(batch.id, "failed");
    this.cleanupBackups(batch.id);
  }

  private cleanupBackups(batchId: string): void {
    const dir = path.join(this.backupsDir, encodeURIComponent(batchId));
    for (let idx = 0; idx < 20; idx++) removeFileQuiet(path.join(dir, `${idx}.db`));
    try {
      fs.rmdirSync(dir);
    } catch {
      // 目录不存在或非空时忽略，下次清理再处理
    }
  }
}

function readUserVersion(dbPath: string): number {
  // 必须以读写方式打开：若上次在事务中途被杀，需要由本次打开完成日志回滚
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
    return row.user_version;
  } finally {
    db.close();
  }
}

/** 在单库内执行整份迁移 SQL + 外键校验 + 版本推进，同事务提交或整体回滚 */
function migrateOneDb(dbPath: string, sql: string, targetVersion: number): void {
  const db = new DatabaseSync(dbPath);
  try {
    // 迁移期间关闭外键强制（允许表重建类迁移暂时破坏引用），
    // 提交前统一用 foreign_key_check 校验目标数据是否满足全部外键
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(sql);
      const violations = db.prepare("PRAGMA foreign_key_check").all() as unknown as Record<string, unknown>[];
      if (violations.length > 0) {
        const sample = violations.slice(0, 3).map((v) => JSON.stringify(v)).join("; ");
        throw new MigrationError(`foreign key violations after migration (${violations.length} rows): ${sample}`);
      }
      db.exec(`PRAGMA user_version = ${targetVersion}`);
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // 连接关闭时事务也会被回滚
      }
      throw err;
    }
  } finally {
    db.close();
  }
}
