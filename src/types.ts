/** 上层提交的合并请求。 */
export interface MergeRequestInput {
  /** 合并请求编号；同一编号绑定的仓库、源提交、目标分支不变。 */
  requestId: string;
  /** 本地 Git 仓库路径。 */
  repoPath: string;
  /** 源提交（commit-ish，始终可读）。 */
  sourceCommit: string;
  /** 目标分支名。 */
  targetBranch: string;
  /** 幂等键。 */
  idempotencyKey: string;
  /** 可选的 squash 提交信息。 */
  message?: string;
}

export type OperationStatus = 'pending' | 'succeeded' | 'failed';

export type FailureReason = 'baseline_stale' | 'error';

/** 一次合并操作的对外结果（终态结果永久可查）。 */
export interface MergeOutcome {
  requestId: string;
  idempotencyKey: string;
  status: OperationStatus;
  /** 首次受理时固定的目标基线提交。 */
  baseline: string;
  /** 成功时实际发布的 squash 提交。 */
  commit?: string;
  failureReason?: FailureReason;
  error?: string;
}

/** 测试/故障注入钩子：用于模拟库在关键节点之间崩溃。 */
export interface ExecutorHooks {
  /** 在固定基线、写入 pending 记录之后、执行合并之前调用。 */
  afterAccept?: () => void;
  /** 在 squash 提交已生成并落库、发布（更新分支引用）之前调用。 */
  beforePublish?: () => void;
  /** 在发布之后、成功结果落库之前调用。 */
  afterPublish?: () => void;
}

export interface ExecutorOptions {
  /** SQLite 数据库文件路径（':memory:' 可用）。 */
  dbPath: string;
  hooks?: ExecutorHooks;
}
