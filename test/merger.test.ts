import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MergeStore } from '../src/db.js';
import { GitRepo } from '../src/git.js';
import { MergeExecutor } from '../src/merger.js';
import { TestRepo } from './helpers.js';

interface Fixture {
  repo: TestRepo;
  dbPath: string;
  dbDir: string;
  base: string;
  baseline: string;
  sourceCommit: string;
  cleanup: () => void;
}

/**
 * 仓库布局：
 * - base：shared.txt=base、target.txt=t0
 * - source 分支（自 base）：shared.txt=source、新增 source.txt
 * - main 前进到 baseline：target.txt=t1（目标侧独有修改）
 */
function setup(): Fixture {
  const repo = TestRepo.create();
  const dbDir = mkdtempSync(join(tmpdir(), 'squash-merge-db-'));
  const dbPath = join(dbDir, 'merge.db');

  const base = repo.commitFile('main', 'shared.txt', 'base\n', 'base shared');
  repo.commitFile('main', 'target.txt', 't0\n', 'base target');
  repo.run('checkout', '-q', '-b', 'source', base);
  repo.commitFile('source', 'shared.txt', 'source\n', 'source change');
  const sourceCommit = repo.commitFile('source', 'source.txt', 'from source\n', 'add source file');
  const baseline = repo.commitFile('main', 'target.txt', 't1\n', 'target own change');

  return {
    repo,
    dbPath,
    dbDir,
    base,
    baseline,
    sourceCommit,
    cleanup: () => {
      repo.dispose();
      rmSync(dbDir, { recursive: true, force: true });
    },
  };
}

const REQUEST_ID = 'req-1';
const TARGET = 'main';

test('发布前目标未变化：恢复后恰有一个正确的 squash 提交', async () => {
  const f = setup();
  try {
    // 模拟“领取操作后、发布前”库停止：直接写入 pending 记录。
    const store = new MergeStore(f.dbPath);
    store.claimOperation({
      idempotencyKey: 'key-1',
      requestId: REQUEST_ID,
      repoPath: f.repo.path,
      sourceCommit: f.sourceCommit,
      targetBranch: TARGET,
      baseline: f.baseline,
    });
    store.close();

    const executor = new MergeExecutor(f.dbPath);
    await executor.recoverPending();

    // Git：目标分支恰前进一个提交，且其父为基线。
    const head = f.repo.head(TARGET);
    assert.equal(f.repo.run('rev-list', '--count', `${f.baseline}..${TARGET}`), '1');
    assert.deepEqual(f.repo.run('rev-list', '--parents', '-n', '1', head).split(' '), [
      head,
      f.baseline,
    ]);

    // 文件内容：保留目标侧独有修改，引入源侧改动。
    assert.equal(f.repo.fileAt(head, 'target.txt'), 't1\n');
    assert.equal(f.repo.fileAt(head, 'shared.txt'), 'source\n');
    assert.equal(f.repo.fileAt(head, 'source.txt'), 'from source\n');

    // SQLite：记录与 Git 一致。
    const check = new MergeStore(f.dbPath);
    const row = check.getByKey('key-1')!;
    assert.equal(row.state, 'succeeded');
    assert.equal(row.resultCommit, head);
    assert.equal(row.baseline, f.baseline);
    check.close();

    // 查询与同键重试都返回原提交。
    const q = executor.query('key-1');
    assert.deepEqual(q, {
      found: true,
      state: 'terminal',
      result: { status: 'succeeded', commitId: head },
    });
    const again = await executor.executeMerge({
      requestId: REQUEST_ID,
      repoPath: f.repo.path,
      sourceCommit: f.sourceCommit,
      targetBranch: TARGET,
      idempotencyKey: 'key-1',
    });
    assert.deepEqual(again, { status: 'succeeded', commitId: head });
    assert.equal(f.repo.head(TARGET), head);
    executor.close();
  } finally {
    f.cleanup();
  }
});

test('已发布未落盘且目标随后快进：恢复与换键重试均返回原提交', async () => {
  const f = setup();
  try {
    // 模拟“领取操作后”库停止。
    const store = new MergeStore(f.dbPath);
    store.claimOperation({
      idempotencyKey: 'key-1',
      requestId: REQUEST_ID,
      repoPath: f.repo.path,
      sourceCommit: f.sourceCommit,
      targetBranch: TARGET,
      baseline: f.baseline,
    });
    store.close();

    // 模拟库已发布 squash 提交但成功结果未落盘。
    const gitRepo = new GitRepo(f.repo.path);
    const mergeBase = await gitRepo.mergeBase(f.sourceCommit, f.baseline);
    const tree = await gitRepo.squashTree(f.baseline, f.sourceCommit, mergeBase);
    const squashCommit = await gitRepo.commitTree(
      tree,
      f.baseline,
      `Squash merge ${f.sourceCommit} into ${TARGET} (request ${REQUEST_ID})`,
    );
    await gitRepo.updateRef(TARGET, squashCommit, f.baseline);

    // 目标随后快进一个后续提交。
    f.repo.run('reset', '--hard', '-q', TARGET);
    const later = f.repo.commitFile(TARGET, 'later.txt', 'later\n', 'later target commit');
    assert.equal(f.repo.head(TARGET), later);

    const executor = new MergeExecutor(f.dbPath);
    await executor.recoverPending();

    // Git：后续提交保留，历史为 baseline -> squash -> later。
    assert.equal(f.repo.head(TARGET), later);
    assert.equal(f.repo.run('rev-list', '--count', `${f.baseline}..${TARGET}`), '2');
    assert.deepEqual(f.repo.run('rev-list', '--parents', '-n', '1', later).split(' '), [
      later,
      squashCommit,
    ]);
    assert.deepEqual(
      f.repo.run('rev-list', '--parents', '-n', '1', squashCommit).split(' '),
      [squashCommit, f.baseline],
    );
    assert.equal(f.repo.fileAt(later, 'shared.txt'), 'source\n');
    assert.equal(f.repo.fileAt(later, 'target.txt'), 't1\n');
    assert.equal(f.repo.fileAt(later, 'later.txt'), 'later\n');

    // SQLite：补齐成功结果，指向原 squash 提交。
    const check = new MergeStore(f.dbPath);
    const row = check.getByKey('key-1')!;
    assert.equal(row.state, 'succeeded');
    assert.equal(row.resultCommit, squashCommit);
    check.close();

    // 换用新幂等键重试：返回原提交，不再产生合并。
    const retry = await executor.executeMerge({
      requestId: REQUEST_ID,
      repoPath: f.repo.path,
      sourceCommit: f.sourceCommit,
      targetBranch: TARGET,
      idempotencyKey: 'key-2',
    });
    assert.deepEqual(retry, { status: 'succeeded', commitId: squashCommit });
    assert.equal(f.repo.head(TARGET), later);
    assert.equal(f.repo.run('rev-list', '--count', `${f.baseline}..${TARGET}`), '2');

    const check2 = new MergeStore(f.dbPath);
    const row2 = check2.getByKey('key-2')!;
    assert.equal(row2.state, 'succeeded');
    assert.equal(row2.resultCommit, squashCommit);
    check2.close();
    executor.close();
  } finally {
    f.cleanup();
  }
});
