import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 同步执行 git 命令并返回 stdout（trim 后）。失败抛出带 stderr 的错误。 */
export function git(repoPath: string, args: string[]): string {
  try {
    return execFileSync('git', ['-C', repoPath, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message?: string };
    const stderr = e.stderr ? String(e.stderr).trim() : '';
    throw new Error(`git ${args.join(' ')} failed: ${stderr || e.message}`);
  }
}

/** 解析 ref 为完整提交哈希。 */
export function resolveCommit(repoPath: string, ref: string): string {
  return git(repoPath, ['rev-parse', '--verify', `${ref}^{commit}`]);
}

/** 判断 a 是否为 b 的祖先（含相等）。 */
export function isAncestor(repoPath: string, a: string, b: string): boolean {
  try {
    execFileSync('git', ['-C', repoPath, 'merge-base', '--is-ancestor', a, b], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 基于 baseline 生成一个 squash 提交：唯一父提交为 baseline，
 * 内容为 baseline 叠加 source 相对最近共同祖先的改动。
 * 不移动任何分支引用。返回新提交哈希。
 *
 * 通过临时 worktree 完成，不触碰调用方的工作区与索引。
 */
export function createSquashCommit(
  repoPath: string,
  baseline: string,
  sourceCommit: string,
  message: string,
): string {
  const worktreePath = mkdtempSync(join(tmpdir(), 'squash-merge-'));
  let added = false;
  try {
    git(repoPath, ['worktree', 'add', '--detach', worktreePath, baseline]);
    added = true;
    git(worktreePath, ['merge', '--squash', sourceCommit]);
    git(worktreePath, ['commit', '-m', message]);
    return git(worktreePath, ['rev-parse', 'HEAD']);
  } finally {
    if (added) {
      try {
        git(repoPath, ['worktree', 'remove', '--force', worktreePath]);
      } catch {
        rmSync(worktreePath, { recursive: true, force: true });
        try {
          git(repoPath, ['worktree', 'prune']);
        } catch {
          /* ignore */
        }
      }
    } else {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  }
}

/** 仅当分支当前值等于 expected 时，将其更新为 next。成功返回 true。 */
export function compareAndSwapBranch(
  repoPath: string,
  branch: string,
  next: string,
  expected: string,
): boolean {
  try {
    execFileSync(
      'git',
      ['-C', repoPath, 'update-ref', `refs/heads/${branch}`, next, expected],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    return true;
  } catch {
    return false;
  }
}
