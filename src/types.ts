/** 批次状态：发布中 / 撤回中 / 成功 / 失败 */
export type BatchStatus = 'publishing' | 'rolling_back' | 'succeeded' | 'failed';

/** 单个参与库在批次内的推进状态 */
export type DbState = 'pending' | 'committed' | 'rolled_back';

export interface SubmitBatchRequest {
  /** 批次稳定标识；同一标识代表同一请求 */
  batchId: string;
  /** 有序且不重复的 1..20 个业务库文件路径；第一个为金丝雀 */
  dbPaths: string[];
  /** 起始版本；目标版本为 startVersion + 1 */
  startVersion: number;
  /** 迁移 SQL，可含多条语句；不含事务控制 / PRAGMA / ATTACH */
  sql: string;
}

export interface DbProgress {
  path: string;
  state: DbState;
}

export interface BatchProgress {
  batchId: string;
  status: BatchStatus;
  startVersion: number;
  targetVersion: number;
  dbs: DbProgress[];
}

/** 推进步骤名，用于故障注入（模拟进程在任意时刻被强杀） */
export type StepPoint =
  | 'backup-created'
  | 'db-committed'
  | 'db-rolled-back'
  | 'batch-rolling-back'
  | 'batch-succeeded'
  | 'batch-failed';

export interface CoordinatorOptions {
  /** 批次状态库（SQLite 文件）路径 */
  stateDbPath: string;
  /** 备份文件存放目录；缺省为状态库同级目录下的 backups */
  backupDir?: string;
  /**
   * 测试用故障注入钩子：每完成一个持久化步骤后调用。
   * 钩子抛出异常即模拟进程在该点被强制结束。
   */
  onStep?: (point: StepPoint, ctx: { batchId: string; dbPath?: string }) => void;
}

export class BatchError extends Error {
  readonly code:
    | 'INVALID_REQUEST'
    | 'BATCH_IN_PROGRESS'
    | 'NOT_FOUND'
    | 'MIGRATION_FAILED';
  constructor(code: BatchError['code'], message: string) {
    super(message);
    this.code = code;
    this.name = 'BatchError';
  }
}
