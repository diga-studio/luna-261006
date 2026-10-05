import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MergeExecutor } from '../src/index.js';
import type { MergeRequestInput } from '../src/index.js';
import { commitAll, createRepo, fileAt, git, parentsOf, write } from './helpers.js';

test('已发布未落盘且目标随后快进：恢复与新键重试均返回原提交，保留后续提交', () => {
  const repo = createRepo();
  const input: MergeRequestInput = {
    requestId: 'req-2',
    repoPath: repo.path,
    sourceCommit: repo.source,
    targetBranch: 'main',
    idempotencyKey: 'key-2',
  };

  // 第一次受理：squash 提交已发布到 main，但成功结果尚未落盘即“崩溃”。
  const crashed = new MergeExecutor({
    dbPath: repo.dbPath,
    hooks: {
      afterPublish: () => {
        throw new Error('simulated crash after publish');
      },
    },
  });
  assert.throws(() => crashed.executeMerge(input), /simulated crash after publish/);
  crashed.close();

  // 发布已经发生：main 指向 squash 提交，其父提交是基线；但库里仍是 pending。
  const squash = git(repo.path, ['rev-parse', 'main']);
  assert.notEqual(squash, repo.baseline);
  assert.deepEqual(parentsOf(repo.path, squash), [repo.baseline]);
  const checker = new MergeExecutor({ dbPath: repo.dbPath });
  assert.equal(checker.getResult('key-2')?.status, 'pending');
  checker.close();

  // 库停止期间，其他本地操作使目标分支快进。
  git(repo.path, ['checkout', 'main']);
  git(repo.path, ['reset', '--hard', 'main']);
  write(repo.path, 'later.txt', 'after-merge\n');
  const later = commitAll(repo.path, 'later commit on target');
  assert.deepEqual(parentsOf(repo.path, later), [squash]);

  // 恢复：应补齐成功结果并返回原提交，保留后续提交。
  const executor = new MergeExecutor({ dbPath: repo.dbPath });
  const outcomes = executor.resumeIncomplete();
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.status, 'succeeded');
  assert.equal(outcomes[0]!.commit, squash);
  assert.equal(git(repo.path, ['rev-parse', 'main']), later);
  assert.equal(git(repo.path, ['rev-list', '--count', 'main']), '4');

  // 同一幂等键重试：返回原终态。
  const retry = executor.executeMerge(input);
  assert.equal(retry.status, 'succeeded');
  assert.equal(retry.commit, squash);

  // 换用新的幂等键：同一请求已成功，只返回原结果，不再产生合并。
  const newKey = executor.executeMerge({ ...input, idempotencyKey: 'key-2b' });
  assert.equal(newKey.status, 'succeeded');
  assert.equal(newKey.commit, squash);
  assert.equal(git(repo.path, ['rev-parse', 'main']), later);
  assert.equal(git(repo.path, ['rev-list', '--count', 'main']), '4');

  // SQLite 记录与 Git 状态一致。
  const rec = executor.getResult('key-2');
  assert.equal(rec?.status, 'succeeded');
  assert.equal(rec?.commit, squash);
  assert.equal(rec?.baseline, repo.baseline);
  const alias = executor.getResult('key-2b');
  assert.equal(alias?.status, 'succeeded');
  assert.equal(alias?.commit, squash);
  const byRequest = executor.getRequestResult('req-2');
  assert.equal(byRequest?.commit, squash);

  // 文件内容贯穿始终正确。
  assert.equal(fileAt(repo.path, 'main', 'target.txt'), 'target-only\n');
  assert.equal(fileAt(repo.path, 'main', 'shared.txt'), 'shared-source\n');
  assert.equal(fileAt(repo.path, 'main', 'source.txt'), 'source-only\n');
  assert.equal(fileAt(repo.path, 'main', 'later.txt'), 'after-merge\n');

  executor.close();
});
