/** 上层发起一次合并所需的全部输入。 */
export interface MergeRequest {
  /** 合并请求编号；同一编号绑定的仓库、源提交、目标分支不变。 */
  requestId: string;
  /** 本地 Git 仓库路径。 */
  repoPath: string;
  /** 源提交（commit-ish，可读）。 */
  sourceCommit: string;
  /** 目标分支名。 */
  targetBranch: string;
  /** 幂等键。 */
  idempotencyKey: string;
}

/** 操作终态。 */
export type TerminalStatus = 'succeeded' | 'failed';

/** 失败原因。 */
export type FailureReason = 'baseline_stale' | 'merge_conflict' | 'git_error';

export interface MergeSuccess {
  status: 'succeeded';
  /** 实际发布的 squash 提交标识。 */
  commitId: string;
}

export interface MergeFailure {
  status: 'failed';
  reason: FailureReason;
  message: string;
}

export type MergeResult = MergeSuccess | MergeFailure;

/** 查询结果：操作可能仍在进行中。 */
export type QueryResult =
  | { found: false }
  | { found: true; state: 'pending' }
  | { found: true; state: 'terminal'; result: MergeResult };
