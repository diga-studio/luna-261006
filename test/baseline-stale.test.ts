import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MergeExecutor } from '../src/index.js';
import type { MergeRequestInput } from '../src/index.js';
import { commitAll, createRepo, fileAt, git, parentsOf, write } from './helpers.js';

test('目标已前进且不包含原提交：恢复终止为基线过期，新键可重新尝试', () => {
  const repo = createRepo();
  const input: MergeRequestInput = {
    requestId: 'req-3',
    repoPath: repo.path,
    sourceCommit: repo.source,
    targetBranch: 'main',
    idempotencyKey: 'key-3',
  };

  // 受理后、合并前“崩溃”，基线已固定。
  const crashed = new MergeExecutor({
    dbPath: repo.dbPath,
    hooks: {
      afterAccept: () => {
        throw new Error('simulated crash');
      },
    },
  });
  assert.throws(() => crashed.executeMerge(input), /simulated crash/);
  crashed.close();

  // 库停止期间，目标分支被其他本地操作快进。
  write(repo.path, 'other.txt', 'other-work\n');
  const advanced = commitAll(repo.path, 'unrelated work on target');
  assert.deepEqual(parentsOf(repo.path, advanced), [repo.baseline]);

  // 恢复：不得覆盖目标，也不得换基线重做，应终止为基线过期。
  const executor = new MergeExecutor({ dbPath: repo.dbPath });
  const outcomes = executor.resumeIncomplete();
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.status, 'failed');
  assert.equal(outcomes[0]!.failureReason, 'baseline_stale');
  assert.equal(outcomes[0]!.baseline, repo.baseline);
  assert.equal(git(repo.path, ['rev-parse', 'main']), advanced);

  // 失败键的终态保持不变。
  const retry = executor.executeMerge(input);
  assert.equal(retry.status, 'failed');
  assert.equal(retry.failureReason, 'baseline_stale');
  assert.equal(executor.getResult('key-3')?.status, 'failed');

  // 同一请求换用新键：以新基线重新尝试并成功。
  const fresh = executor.executeMerge({ ...input, idempotencyKey: 'key-3b' });
  assert.equal(fresh.status, 'succeeded');
  assert.equal(fresh.baseline, advanced);
  const squash = fresh.commit!;
  assert.deepEqual(parentsOf(repo.path, squash), [advanced]);
  assert.equal(git(repo.path, ['rev-parse', 'main']), squash);
  assert.equal(fileAt(repo.path, squash, 'other.txt'), 'other-work\n');
  assert.equal(fileAt(repo.path, squash, 'shared.txt'), 'shared-source\n');
  assert.equal(fileAt(repo.path, squash, 'target.txt'), 'target-only\n');

  // 旧键的失败终态不受新成功影响。
  assert.equal(executor.getResult('key-3')?.status, 'failed');
  assert.equal(executor.getRequestResult('req-3')?.commit, squash);

  executor.close();
});
