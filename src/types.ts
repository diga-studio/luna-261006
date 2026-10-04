/** 调用方提交/续跑批次时的请求。 */
export interface SubmitBatchRequest {
  /** 稳定批次标识；同一标识的重试必须使用相同清单与密钥。 */
  batchId: string;
  /** 目标文件绝对路径清单（普通文件、无硬链接/符号链接）。 */
  files: string[];
  /** 32 字节密钥；库不持久化密钥本身。 */
  key: Buffer;
}

/** 单个文件的进度状态。 */
export interface FileProgress {
  path: string;
  done: boolean;
}

/** 批次进度查询结果。 */
export interface BatchProgress {
  batchId: string;
  total: number;
  completed: number;
  /** true 表示整批完成且目录无残留临时文件。 */
  complete: boolean;
  files: FileProgress[];
}

/**
 * 故障注入钩子，仅供测试模拟进程在任意时刻被终止。
 * 钩子抛出异常即等价于进程崩溃：库随后应被丢弃，
 * 用相同目录与 SQLite 重新构造实例续跑。
 */
export interface CrashHooks {
  /** 临时密文写入过程中回调；可抛出以留下写了一半的临时文件。 */
  onTempWriteChunk?: (bytesWritten: number, totalBytes: number) => void;
  /** 临时文件写完并 fsync 后、原子替换目标前。 */
  onBeforeRename?: (path: string) => void;
  /** 目标已原子替换为最终密文、完成记录持久化之前。 */
  onAfterRename?: (path: string) => void;
  /** 完成记录已持久化、临时文件清理之前。 */
  onAfterRecord?: (path: string) => void;
}

export interface VaultOptions {
  /** SQLite 数据库文件路径。 */
  dbPath: string;
  /** 测试用故障注入钩子。 */
  hooks?: CrashHooks;
}

/** 批次大小限制。 */
export const MAX_FILES_PER_BATCH = 500;
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
