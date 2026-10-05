import { MergeStore, type OperationRow } from './db.js';
import { GitRepo, MergeConflictError } from './git.js';
import type {
  FailureReason,
  MergeRequest,
  MergeResult,
  QueryResult,
} from './types.js';

function squashMessage(requestId: string, sourceCommit: string, targetBranch: string): string {
  return `Squash merge ${sourceCommit} into ${targetBranch} (request ${requestId})`;
}

function failure(reason: FailureReason, message: string): MergeResult {
  return { status: 'failed', reason, message };
}

function toResult(row: OperationRow): MergeResult {
  if (row.state === 'succeeded') {
    return { status: 'succeeded', commitId: row.resultCommit! };
  }
  return {
    status: 'failed',
    reason: (row.failureReason ?? 'git_error') as FailureReason,
    message: row.failureMessage ?? '',
  };
}

/** 合并执行库主入口：执行合并、恢复未完成操作、查询结果。 */
export class MergeExecutor {
  private readonly store: MergeStore;

  constructor(dbPath: string) {
    this.store = new MergeStore(dbPath);
  }

  close(): void {
    this.store.close();
  }

  /** 执行（或续办）一次 squash 合并。 */
  async executeMerge(request: MergeRequest): Promise<MergeResult> {
    // 1. 同一幂等键：返回原终态或续办原操作。
    const existing = this.store.getByKey(request.idempotencyKey);
    if (existing) {
      this.assertSameParams(existing, request);
      if (existing.state !== 'pending') return toResult(existing);
      return this.recoverOperation(existing);
    }

    // 2. 同一合并请求已成功：换键也只返回该次成功结果。
    const succeeded = this.store.getSucceededByRequest(request.requestId);
    if (succeeded) {
      const { row } = this.store.claimOperation({
        idempotencyKey: request.idempotencyKey,
        requestId: request.requestId,
        repoPath: request.repoPath,
        sourceCommit: request.sourceCommit,
        targetBranch: request.targetBranch,
        baseline: succeeded.baseline,
      });
      if (row.state === 'pending') {
        this.store.markSucceeded(request.idempotencyKey, succeeded.resultCommit!);
      }
      return { status: 'succeeded', commitId: succeeded.resultCommit! };
    }

    // 3. 新操作：固定目标基线并领取。
    const repo = new GitRepo(request.repoPath);
    let baseline: string;
    try {
      baseline = await repo.revParse(`refs/heads/${request.targetBranch}`);
      await repo.revParse(request.sourceCommit);
    } catch (err) {
      return failure('git_error', (err as Error).message);
    }
    const { row, claimed } = this.store.claimOperation({
      idempotencyKey: request.idempotencyKey,
      requestId: request.requestId,
      repoPath: request.repoPath,
      sourceCommit: request.sourceCommit,
      targetBranch: request.targetBranch,
      baseline,
    });
    if (!claimed) {
      // 并发下已被其他调用领取；按原记录续办。
      return row.state === 'pending' ? this.recoverOperation(row) : toResult(row);
    }
    return this.performMerge(row);
  }

  /** 恢复所有未完成操作。 */
  async recoverPending(): Promise<void> {
    for (const row of this.store.listPending()) {
      await this.recoverOperation(row);
    }
  }

  /** 按幂等键查询结果。 */
  query(idempotencyKey: string): QueryResult {
    const row = this.store.getByKey(idempotencyKey);
    if (!row) return { found: false };
    if (row.state === 'pending') return { found: true, state: 'pending' };
    return { found: true, state: 'terminal', result: toResult(row) };
  }

  private assertSameParams(row: OperationRow, request: MergeRequest): void {
    if (
      row.requestId !== request.requestId ||
      row.repoPath !== request.repoPath ||
      row.sourceCommit !== request.sourceCommit ||
      row.targetBranch !== request.targetBranch
    ) {
      throw new Error(
        `idempotency key ${request.idempotencyKey} was used with different parameters`,
      );
    }
  }

  /** 对 pending 操作执行实际的 squash 合并（目标仍等于基线时调用）。 */
  private async performMerge(row: OperationRow): Promise<MergeResult> {
    const repo = new GitRepo(row.repoPath);
    try {
      const mergeBase = await repo.mergeBase(row.sourceCommit, row.baseline);
      const tree = await repo.squashTree(row.baseline, row.sourceCommit, mergeBase);
      const commit = await repo.commitTree(
        tree,
        row.baseline,
        squashMessage(row.requestId, row.sourceCommit, row.targetBranch),
      );
      // CAS 发布：目标必须仍等于基线，否则按恢复逻辑判定。
      try {
        await repo.updateRef(row.targetBranch, commit, row.baseline);
      } catch {
        return this.recoverOperation(row);
      }
      this.store.markSucceeded(row.idempotencyKey, commit);
      return { status: 'succeeded', commitId: commit };
    } catch (err) {
      if (err instanceof MergeConflictError) {
        this.store.markFailed(row.idempotencyKey, 'merge_conflict', err.message);
        return failure('merge_conflict', err.message);
      }
      this.store.markFailed(row.idempotencyKey, 'git_error', (err as Error).message);
      return failure('git_error', (err as Error).message);
    }
  }

  /**
   * 恢复一个未完成操作：
   * - 目标仍等于基线：完成原操作；
   * - 原 squash 提交已在目标历史中：补齐成功结果；
   * - 目标已前进且不含该提交：终止为基线过期。
   */
  private async recoverOperation(row: OperationRow): Promise<MergeResult> {
    const repo = new GitRepo(row.repoPath);
    let targetHead: string;
    try {
      targetHead = await repo.revParse(`refs/heads/${row.targetBranch}`);
    } catch (err) {
      this.store.markFailed(row.idempotencyKey, 'git_error', (err as Error).message);
      return failure('git_error', (err as Error).message);
    }

    if (targetHead === row.baseline) {
      return this.performMerge(row);
    }

    // 目标已移动：仅当基线仍是其祖先时，原提交才可能已发布。
    if (await repo.isAncestor(row.baseline, targetHead)) {
      const published = await this.findPublishedSquash(repo, row, targetHead);
      if (published) {
        this.store.markSucceeded(row.idempotencyKey, published);
        return { status: 'succeeded', commitId: published };
      }
    }

    const message =
      `target branch ${row.targetBranch} moved from baseline ${row.baseline} ` +
      `to ${targetHead} without the squash commit`;
    this.store.markFailed(row.idempotencyKey, 'baseline_stale', message);
    return failure('baseline_stale', message);
  }

  /**
   * 在目标历史中查找原操作的 squash 提交：
   * 基线在通往目标头的路径上的直接子提交，且其 tree 与预期合并结果一致。
   */
  private async findPublishedSquash(
    repo: GitRepo,
    row: OperationRow,
    targetHead: string,
  ): Promise<string | null> {
    const path = await repo.ancestryPath(row.baseline, targetHead);
    if (path.length === 0) return null;
    const candidate = path[0];
    const parents = await repo.parentsOf(candidate);
    if (parents.length !== 1 || parents[0] !== row.baseline) return null;
    const mergeBase = await repo.mergeBase(row.sourceCommit, row.baseline);
    const expectedTree = await repo.squashTree(row.baseline, row.sourceCommit, mergeBase);
    const actualTree = await repo.treeOf(candidate);
    return actualTree === expectedTree ? candidate : null;
  }
}
