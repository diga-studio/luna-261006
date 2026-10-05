import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { StateStore, BatchRow, BatchDbRow } from './stateStore';
import {
  BatchProgress,
  BatchError,
  CoordinatorOptions,
  StepPoint,
  SubmitBatchRequest,
} from './types';

const META_TABLE = '__canary_meta';
const MIN_DBS = 1;
const MAX_DBS = 20;

/**
 * 金丝雀迁移协调器。
 * submit 登记批次（幂等）；advance 推进直到终态；query 查询进度。
 * 进程任意时刻被杀后，重新构造实例并对同一批次调用 advance 即可收敛。
 */
export class CanaryCoordinator {
  private readonly store: StateStore;
  private readonly backupDir: string;
  private readonly onStep?: CoordinatorOptions['onStep'];

  constructor(options: CoordinatorOptions) {
    this.store = new StateStore(options.stateDbPath);
    this.backupDir =
      options.backupDir ?? path.join(path.dirname(options.stateDbPath), 'backups');
    this.onStep = options.onStep;
    fs.mkdirSync(this.backupDir, { recursive: true });
  }

  submit(request: SubmitBatchRequest): BatchProgress {
    this.validate(request);
    const existing = this.store.getBatch(request.batchId);
    if (existing) {
      // 同一标识代表同一请求：直接返回原批次，终态批次也不会再被修改
      return this.progress(existing);
    }
    const unfinished = this.store.getUnfinishedBatch();
    if (unfinished) {
      throw new BatchError(
        'BATCH_IN_PROGRESS',
        `batch ${unfinished.batchId} is still ${unfinished.status}`,
      );
    }
    const row: BatchRow = {
      batchId: request.batchId,
      status: 'publishing',
      startVersion: request.startVersion,
      sql: request.sql,
      dbPaths: request.dbPaths,
    };
    this.store.createBatch(row);
    return this.progress(row);
  }

  advance(batchId: string): BatchProgress {
    const batch = this.store.getBatch(batchId);
    if (!batch) throw new BatchError('NOT_FOUND', `unknown batch ${batchId}`);
    if (batch.status === 'succeeded' || batch.status === 'failed') {
      return this.progress(batch);
    }
    if (batch.status === 'publishing') {
      const failure = this.publishAll(batch);
      if (failure) {
        this.store.setBatchStatus(batch.batchId, 'rolling_back');
        this.emit('batch-rolling-back', batch.batchId);
        batch.status = 'rolling_back';
      }
    }
    if (batch.status === 'rolling_back') {
      this.rollbackAll(batch);
      this.store.setBatchStatus(batch.batchId, 'failed');
      this.emit('batch-failed', batch.batchId);
      return this.progress(this.store.getBatch(batch.batchId)!);
    }
    // 全部库已提交：清理备份并确认终态
    for (const row of this.store.listDbRows(batch.batchId)) {
      this.removeBackup(batch.batchId, row.idx);
    }
    this.store.setBatchStatus(batch.batchId, 'succeeded');
    this.emit('batch-succeeded', batch.batchId);
    return this.progress(this.store.getBatch(batch.batchId)!);
  }

  query(batchId: string): BatchProgress {
    const batch = this.store.getBatch(batchId);
    if (!batch) throw new BatchError('NOT_FOUND', `unknown batch ${batchId}`);
    return this.progress(batch);
  }

  close(): void {
    this.store.close();
  }

  // ---- 发布阶段 ----

  /** 依序发布；返回是否发生迁移错误（此时状态库已可恢复） */
  private publishAll(batch: BatchRow): boolean {
    const rows = this.store.listDbRows(batch.batchId);
    for (const row of rows) {
      if (row.state === 'committed') continue;
      this.ensureBackup(batch.batchId, row.idx, row.path);
      this.emit('backup-created', batch.batchId, row.path);
      try {
        this.migrateOne(batch, row.path);
      } catch {
        return true; // 迁移错误：转入撤回；状态库里该库仍为 pending，备份完好
      }
      this.store.setDbState(batch.batchId, row.idx, 'committed');
      this.emit('db-committed', batch.batchId, row.path);
    }
    return false;
  }

  /**
   * 单库迁移：版本检查、迁移 SQL、外键校验、版本推进在同一事务内。
   * 崩溃恢复时若版本已是目标版本，说明事务已提交，直接视为成功，绝不重放 SQL。
   */
  private migrateOne(batch: BatchRow, dbPath: string): void {
    const target = batch.startVersion + 1;
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('PRAGMA foreign_keys = ON');
      db.exec('BEGIN IMMEDIATE');
      db.exec(`CREATE TABLE IF NOT EXISTS ${META_TABLE} (version INTEGER NOT NULL)`);
      const row = db.prepare(`SELECT version FROM ${META_TABLE}`).get() as
        | { version: number }
        | undefined;
      if (!row) {
        throw new BatchError('MIGRATION_FAILED', `${dbPath}: missing migration version`);
      }
      if (row.version === batch.startVersion) {
        db.exec(batch.sql);
        const violations = db.prepare('PRAGMA foreign_key_check').all();
        if (violations.length > 0) {
          throw new BatchError(
            'MIGRATION_FAILED',
            `${dbPath}: foreign key violations after migration`,
          );
        }
        db.prepare(`UPDATE ${META_TABLE} SET version = ?`).run(target);
      } else if (row.version !== target) {
        throw new BatchError(
          'MIGRATION_FAILED',
          `${dbPath}: expected version ${batch.startVersion} or ${target}, got ${row.version}`,
        );
      }
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* 连接级错误时事务已由 SQLite 回滚 */
      }
      throw err;
    } finally {
      db.close();
    }
  }

  // ---- 撤回阶段 ----

  /** 逆序撤回所有有备份的库；可重入，恢复期间再次被杀也能继续 */
  private rollbackAll(batch: BatchRow): void {
    const rows = this.store.listDbRows(batch.batchId);
    for (const row of [...rows].reverse()) {
      if (row.state === 'rolled_back') continue;
      const backup = this.backupPath(batch.batchId, row.idx);
      if (fs.existsSync(backup)) {
        this.restoreBackup(backup, row.path);
        fs.unlinkSync(backup);
      }
      this.store.setDbState(batch.batchId, row.idx, 'rolled_back');
      this.emit('db-rolled-back', batch.batchId, row.path);
    }
  }

  // ---- 备份与恢复（崩溃安全：先写临时文件再原子改名） ----

  private backupPath(batchId: string, idx: number): string {
    const safe = Buffer.from(batchId, 'utf8').toString('base64url');
    return path.join(this.backupDir, `${safe}__${idx}.bak`);
  }

  private ensureBackup(batchId: string, idx: number, dbPath: string): void {
    const backup = this.backupPath(batchId, idx);
    if (fs.existsSync(backup)) return;
    const tmp = backup + '.tmp';
    fs.rmSync(tmp, { force: true }); // 上次可能死在备份中途，临时文件不可信
    fs.copyFileSync(dbPath, tmp);
    const fd = fs.openSync(tmp, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, backup);
  }

  private restoreBackup(backup: string, dbPath: string): void {
    const tmp = dbPath + '.restore-tmp';
    fs.rmSync(tmp, { force: true });
    fs.copyFileSync(backup, tmp);
    const fd = fs.openSync(tmp, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, dbPath);
  }

  private removeBackup(batchId: string, idx: number): void {
    fs.rmSync(this.backupPath(batchId, idx), { force: true });
  }

  // ---- 辅助 ----

  private validate(request: SubmitBatchRequest): void {
    if (!request.batchId || typeof request.batchId !== 'string') {
      throw new BatchError('INVALID_REQUEST', 'batchId must be a non-empty string');
    }
    const n = request.dbPaths?.length ?? 0;
    if (n < MIN_DBS || n > MAX_DBS) {
      throw new BatchError('INVALID_REQUEST', `dbPaths must contain ${MIN_DBS}..${MAX_DBS} paths`);
    }
    if (new Set(request.dbPaths).size !== n) {
      throw new BatchError('INVALID_REQUEST', 'dbPaths must not contain duplicates');
    }
    if (!Number.isInteger(request.startVersion) || request.startVersion < 0) {
      throw new BatchError('INVALID_REQUEST', 'startVersion must be a non-negative integer');
    }
    if (!request.sql || typeof request.sql !== 'string') {
      throw new BatchError('INVALID_REQUEST', 'sql must be a non-empty string');
    }
  }

  private progress(batch: BatchRow): BatchProgress {
    const rows: BatchDbRow[] = this.store.listDbRows(batch.batchId);
    return {
      batchId: batch.batchId,
      status: batch.status,
      startVersion: batch.startVersion,
      targetVersion: batch.startVersion + 1,
      dbs: rows.map((r) => ({ path: r.path, state: r.state })),
    };
  }

  private emit(point: StepPoint, batchId: string, dbPath?: string): void {
    this.onStep?.(point, { batchId, dbPath });
  }
}

export { BatchError };
