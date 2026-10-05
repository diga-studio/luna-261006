# git-squash-merge-lib

由上层调用的 Git squash 合并执行库：操作真实本地 Git 仓库，合并请求状态与重试结果持久化在 SQLite 中。

## 能力

- `executeMerge(request)`：执行（或续办）一次 squash 合并。
- `recoverPending()`：恢复所有未完成操作。
- `query(idempotencyKey)`：按幂等键查询结果。

## 用法

```ts
import { MergeExecutor } from 'git-squash-merge-lib';

const executor = new MergeExecutor('/path/to/state.db');

const result = await executor.executeMerge({
  requestId: 'req-1',
  repoPath: '/path/to/repo',
  sourceCommit: 'abc123...',
  targetBranch: 'main',
  idempotencyKey: 'key-1',
});
// 成功：{ status: 'succeeded', commitId: '<实际发布的 squash 提交>' }
// 失败：{ status: 'failed', reason: 'baseline_stale' | 'merge_conflict' | 'git_error', message }
```

## 语义

- 新操作首次受理时固定目标基线；成功时只发布一个 squash 提交，其唯一父提交即该基线，
  内容保留目标侧独有修改并引入源提交相对最近共同祖先的改动（`git merge-tree` 三方合并）。
- 同一幂等键重复调用（参数相同）续办原操作或返回原终态，不重新选择基线；幂等结果不过期。
- 同一合并请求成功后，换用新幂等键也只返回该次成功结果，不再产生合并；失败键终态不变。
- 恢复未完成操作时：目标仍等于基线则完成原操作；原 squash 提交已在目标历史中则补齐成功
  结果并保留后续提交；目标已前进且不含该提交则终止为 `baseline_stale`，不覆盖目标、
  不自动换基线重做，请求可用新键重试。

## 环境要求

- Node.js >= 22.13（使用内置 `node:sqlite`，无原生依赖；个别更早的 22.x 需 `--experimental-sqlite`）。
- Git >= 2.38（`git merge-tree --write-tree`）。
- 输入限定为无冲突的普通文本改动，且最近共同祖先唯一。

## 构建与测试

```sh
npm install
npm test        # 编译后运行 node --test，覆盖恢复与幂等场景
```
