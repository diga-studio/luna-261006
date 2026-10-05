/** 批次状态：发布中 / 撤回中 / 成功 / 失败（终态不可变） */
export type BatchStatus = "publishing" | "rolling_back" | "success" | "failed";

/** 单个库在批次内的推进状态 */
export type DbStepState =
  | "pending"      // 尚未处理
  | "backed_up"    // 已完成提交前快照，迁移事务未确认
  | "migrated"     // 迁移事务已真实提交
  | "rolled_back"; // 已从快照恢复

/** 提交批次的请求 */
export interface BatchRequest {
  /** 稳定标识：同一标识只代表同一请求 */
  id: string;
  /** 有序且不重复的 1..20 个库文件路径，第一个为金丝雀 */
  dbs: string[];
  /** 起始版本（PRAGMA user_version），目标版本为 startVersion + 1 */
  startVersion: number;
  /** 迁移 SQL：可含多条语句，不含事务控制 / PRAGMA / ATTACH */
  sql: string;
}

/** 批次持久化记录 */
export interface BatchRecord {
  id: string;
  status: BatchStatus;
  dbs: string[];
  startVersion: number;
  targetVersion: number;
  sql: string;
  error: string | null;
}

/** 单库进度（对外查询用） */
export interface DbProgress {
  db: string;
  index: number;
  state: DbStepState;
}

/** 批次进度（对外查询用） */
export interface BatchProgress {
  id: string;
  status: BatchStatus;
  startVersion: number;
  targetVersion: number;
  error: string | null;
  dbs: DbProgress[];
}

/** 崩溃注入点：advance 在每个持久化边界调用，用于测试模拟进程被杀 */
export type CrashPoint =
  | "beforeDbBackup"
  | "afterDbBackup"
  | "beforeDbCommit"
  | "afterDbCommit"     // 业务库事务已提交，但协调器尚未记录
  | "afterDbRecorded"   // 协调器已记录 migrated
  | "beforeMarkSuccess"
  | "beforeRestore"
  | "afterRestore"
  | "beforeMarkFailed";

export interface AdvanceHooks {
  /** 在指定持久化边界被调用；抛出异常即模拟进程终止（现场已持久化） */
  atPoint?(point: CrashPoint, ctx: { batchId: string; dbIndex: number | null }): void;
}

/** 推进结果 */
export interface AdvanceResult {
  id: string;
  status: BatchStatus;
  error: string | null;
}
