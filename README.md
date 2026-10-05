# git-squash-merge-executor

由上层调用的 Git 合并执行库：仅支持 **squash 合并**，操作对象是真实的本地 Git 仓库，
合并请求状态与重试结果持久化在 **SQLite**（使用 Node 内置 `node:sqlite`，无原生依赖）。

## 要求

- Node.js >= 22.5（`node:sqlite`）
- 本机可用的 `git` 命令

## 使用

```bash
npm install
npm run build
npm test
```

```ts
import { MergeExecutor } from 'git-squash-merge-executor';

const executor = new MergeExecutor({ dbPath: 'merge-state.db' });

// 1. 执行合并（幂等）
const outcome = executor.executeMerge({
  requestId: 'req-1',
  repoPath: '/path/to/repo',
  sourceCommit: 'feature',      // 或完整提交哈希
  targetBranch: 'main',
  idempotencyKey: 'key-1',
});

// 2. 恢复未完成操作（进程重启后调用）
const recovered = executor.resumeIncomplete(); // 或按请求过滤 resumeIncomplete('req-1')

// 3. 查询结果（终态永久可查）
const byKey = executor.getResult('key-1');
const byRequest = executor.getRequestResult('req-1');

executor.close();
```

## 语义

- **基线固定**：每个新操作首次受理时记录目标分支当前提交为基线。成功时只发布一个
  squash 提交，其唯一父提交是该基线；内容保留目标侧独有修改，并引入源提交相对
  最近共同祖先的改动。
- **幂等**：同一幂等键重复调用（参数相同）续办原操作或返回原终态，不重新选择基线；
  成功结果包含实际发布的提交标识，目标后来前进也仍返回原标识；结果不设过期时间。
- **请求级成功唯一**：同一请求一旦成功，换用新幂等键也只返回该次成功结果，
  不会再产生合并。失败键的终态同样保持不变。
- **恢复**：恢复未完成操作时——
  - 目标仍等于原基线：完成原操作；
  - 原 squash 提交已是目标或其祖先：补齐成功结果，保留后续提交；
  - 目标已前进且不包含该提交：终止为 `baseline_stale`，不覆盖目标、不换基线重做；
    请求可用新键重新尝试。

## 实现要点

- 合并通过临时 `git worktree` 完成（`merge --squash` + `commit`），不触碰调用方工作区。
- 发布用 `git update-ref <branch> <new> <baseline>` 做比较并交换，目标被移动则失败。
- 崩溃安全顺序：生成 squash 提交 → 落库 → 发布引用 → 落库成功结果；
  任意两步之间崩溃都能在恢复时被正确识别。
- `ExecutorOptions.hooks`（`afterAccept` / `beforePublish` / `afterPublish`）仅供测试
  注入崩溃点。

## 测试

`npm test` 使用 Node 内置 test runner（经 `tsx` 直接运行 TypeScript），覆盖：

- 发布前目标未变化，恢复后恰有一个正确的 squash 提交；
- 已发布但成功结果未落盘、目标随后快进，恢复及不同键重试均返回原提交且保留后续提交；
- 目标已前进且不包含原提交，恢复终止为基线过期，新键可重新尝试。

每个用例都校验 Git 提交父关系、文件内容与 SQLite 记录三者一致。
