import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

export interface TestRepo {
  path: string;
  dbPath: string;
  /** 最近共同祖先。 */
  base: string;
  /** 源提交（feature 分支顶端）。 */
  source: string;
  /** 目标基线（受理时 main 的位置）。 */
  baseline: string;
}

export function write(repo: string, name: string, content: string): void {
  writeFileSync(join(repo, name), content);
}

export function commitAll(repo: string, message: string): string {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

/**
 * 构造仓库：
 * - base：shared.txt=shared-base, target.txt=target-base
 * - source（feature）：shared.txt=shared-source, 新增 source.txt
 * - baseline（main）：target.txt=target-only（目标侧独有修改）
 */
export function createRepo(): TestRepo {
  const path = mkdtempSync(join(tmpdir(), 'merge-exec-test-'));
  git(path, ['init', '-b', 'main']);
  git(path, ['config', 'user.email', 'test@example.com']);
  git(path, ['config', 'user.name', 'Test']);
  git(path, ['config', 'commit.gpgsign', 'false']);

  write(path, 'shared.txt', 'shared-base\n');
  write(path, 'target.txt', 'target-base\n');
  const base = commitAll(path, 'base');

  git(path, ['checkout', '-b', 'feature']);
  write(path, 'shared.txt', 'shared-source\n');
  write(path, 'source.txt', 'source-only\n');
  const source = commitAll(path, 'source change');

  git(path, ['checkout', 'main']);
  write(path, 'target.txt', 'target-only\n');
  const baseline = commitAll(path, 'target-only change');

  return { path, dbPath: join(path, 'merge-state.db'), base, source, baseline };
}

export function parentsOf(repo: string, commit: string): string[] {
  const out = git(repo, ['rev-list', '--parents', '-n', '1', commit]);
  return out.split(/\s+/).slice(1);
}

export function fileAt(repo: string, ref: string, name: string): string | null {
  try {
    return execFileSync('git', ['-C', repo, 'show', `${ref}:${name}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}
