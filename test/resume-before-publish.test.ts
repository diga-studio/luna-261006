import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MergeExecutor } from '../src/index.js';
import type { MergeRequestInput } from '../src/index.js';
import { createRepo, fileAt, git, parentsOf } from './helpers.js';

test('发布前目标未变化：恢复后恰有一个正确的 squash 提交', () => {
  const repo = createRepo();
  const input: MergeRequestInput = {
    requestId: 'req-1',
    repoPath: repo.path,
    sourceCommit: repo.source,
    targetBranch: 'main',
    idempotencyKey: 'key-1',
  };

  // 第一次受理：固定基线后、执行合并前“崩溃”。
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

  // 崩溃后：目标仍停在基线，没有产生新提交。
  assert.equal(git(repo.path, ['rev-parse', 'main']), repo.baseline);
  assert.equal(git(repo.path, ['rev-list', '--count', 'main']), '2');

  // 重启库，恢复未完成操作。
  const executor = new MergeExecutor({ dbPath: repo.dbPath });
  const outcomes = executor.resumeIncomplete();
  assert.equal(outcomes.length, 1);
  const outcome = outcomes[0]!;
  assert.equal(outcome.status, 'succeeded');
  assert.equal(outcome.baseline, repo.baseline);
  const squash = outcome.commit!;
  assert.ok(squash);

  // Git 侧：main 恰好前进一个提交，且该提交唯一父提交是原基线。
  assert.equal(git(repo.path, ['rev-parse', 'main']), squash);
  assert.equal(git(repo.path, ['rev-list', '--count', 'main']), '3');
  assert.deepEqual(parentsOf(repo.path, squash), [repo.baseline]);

  // 文件内容：保留目标侧独有修改，引入源侧相对共同祖先的改动。
  assert.equal(fileAt(repo.path, squash, 'target.txt'), 'target-only\n');
  assert.equal(fileAt(repo.path, squash, 'shared.txt'), 'shared-source\n');
  assert.equal(fileAt(repo.path, squash, 'source.txt'), 'source-only\n');

  // SQLite 侧：记录与 Git 一致。
  const byKey = executor.getResult('key-1');
  assert.equal(byKey?.status, 'succeeded');
  assert.equal(byKey?.commit, squash);
  assert.equal(byKey?.baseline, repo.baseline);
  const byRequest = executor.getRequestResult('req-1');
  assert.equal(byRequest?.commit, squash);

  // 同一幂等键重试：返回原终态，不产生新提交。
  const retry = executor.executeMerge(input);
  assert.equal(retry.status, 'succeeded');
  assert.equal(retry.commit, squash);
  assert.equal(git(repo.path, ['rev-list', '--count', 'main']), '3');

  executor.close();
});
