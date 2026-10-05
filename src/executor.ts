import { OperationStore, type OperationRow } from './db.js';
import {
  compareAndSwapBranch,
  createSquashCommit,
  isAncestor,
  resolveCommit,
} from './git.js';
import type {
  ExecutorHooks,
  ExecutorOptions,
  MergeOutcome,
  MergeRequestInput,
} from './types.js';

function toOutcome(row: OperationRow): MergeOutcome {
  return {
    requestId: row.requestId,
    idempotencyKey: row.idempotencyKey,
    status: row.status,
    baseline: row.baseline,
    commit: row.status === 'succeeded' ? (row.squashCommit ?? undefined) : undefined,
    failureReason: row.failureReason ?? undefined,
    error: row.error ?? undefined,
  };
}

/** Git squash 合并执行器：执行合并、恢复未完成操作、查询结果。 */
export class MergeExecutor {
  private store: OperationStore;
  private hooks: ExecutorHooks;

  constructor(options: ExecutorOptions) {
    this.store = new OperationStore(options.dbPath);
    this.hooks = options.hooks ?? {};
  }

  /**
   * 受理/续办一次合并。
   * - 同一幂等键重复调用：续办原操作或返回原终态，不重新选择基线。
   * - 请求已成功：换用新键也只返回原成功结果，不再合并。
   */
  executeMerge(input: MergeRequestInput): MergeOutcome {
    const existing = this.store.getByKey(input.idempotencyKey);
    if (existing) {
      if (existing.status === 'pending') {
        return this.resumeOne(existing);
      }
      return toOutcome(existing);
    }

    const succeeded = this.store.getSucceededByRequest(input.requestId);
    if (succeeded) {
      this.store.insertSucceededAlias(input.idempotencyKey, succeeded);
      return toOutcome(this.store.getByKey(input.idempotencyKey)!);
    }

    // 首次受理：固定目标基线。
    const baseline = resolveCommit(input.repoPath, input.targetBranch);
    const sourceCommit = resolveCommit(input.repoPath, input.sourceCommit);
    const message =
      input.message ??
      `Squash merge ${sourceCommit} into ${input.targetBranch} (request ${input.requestId})`;
    this.store.insertPending({
      idempotencyKey: input.idempotencyKey,
      requestId: input.requestId,
      repoPath: input.repoPath,
      sourceCommit,
      targetBranch: input.targetBranch,
      baseline,
      message,
    });
    this.hooks.afterAccept?.();

    this.runOperation(this.store.getByKey(input.idempotencyKey)!);
    return toOutcome(this.store.getByKey(input.idempotencyKey)!);
  }

  /** 恢复未完成操作（可按请求过滤）。 */
  resumeIncomplete(requestId?: string): MergeOutcome[] {
    return this.store.listPending(requestId).map((op) => this.resumeOne(op));
  }

  /** 按幂等键查询结果。 */
  getResult(idempotencyKey: string): MergeOutcome | null {
    const row = this.store.getByKey(idempotencyKey);
    return row ? toOutcome(row) : null;
  }

  /** 查询某合并请求的已成功终态结果。 */
  getRequestResult(requestId: string): MergeOutcome | null {
    const row = this.store.getSucceededByRequest(requestId);
    return row ? toOutcome(row) : null;
  }

  close(): void {
    this.store.close();
  }

  /**
   * 恢复单个 pending 操作：
   * - 目标仍等于原基线：完成原操作；
   * - 原 squash 提交已是目标或其祖先：补齐成功结果，保留后续提交；
   * - 目标已前进且不包含该提交：终止为基线过期，不覆盖、不换基线重做。
   */
  private resumeOne(op: OperationRow): MergeOutcome {
    let target: string;
    try {
      target = resolveCommit(op.repoPath, op.targetBranch);
    } catch (err) {
      this.store.markFailed(op.idempotencyKey, 'error', String(err));
      return toOutcome(this.store.getByKey(op.idempotencyKey)!);
    }

    if (target === op.baseline) {
      this.runOperation(op);
    } else if (op.squashCommit && isAncestor(op.repoPath, op.squashCommit, target)) {
      this.store.markSucceeded(op.idempotencyKey, op.squashCommit);
    } else {
      this.store.markFailed(
        op.idempotencyKey,
        'baseline_stale',
        `target branch ${op.targetBranch} advanced beyond baseline ${op.baseline}`,
      );
    }
    return toOutcome(this.store.getByKey(op.idempotencyKey)!);
  }

  /** 执行合并并发布：生成 squash 提交 → 落库 → 原子更新分支引用 → 落库成功结果。 */
  private runOperation(op: OperationRow): void {
    let squash: string;
    try {
      squash = createSquashCommit(op.repoPath, op.baseline, op.sourceCommit, op.message);
    } catch (err) {
      this.store.markFailed(op.idempotencyKey, 'error', String(err));
      return;
    }
    this.store.setSquashCommit(op.idempotencyKey, squash);
    this.hooks.beforePublish?.();

    const published = compareAndSwapBranch(
      op.repoPath,
      op.targetBranch,
      squash,
      op.baseline,
    );
    if (!published) {
      this.store.markFailed(
        op.idempotencyKey,
        'baseline_stale',
        `target branch ${op.targetBranch} no longer at baseline ${op.baseline}`,
      );
      return;
    }
    this.hooks.afterPublish?.();
    this.store.markSucceeded(op.idempotencyKey, squash);
  }
}
