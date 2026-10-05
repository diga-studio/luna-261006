import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export function git(repo: string, ...args: string[]): string {
  return gitRaw(repo, ...args).trim();
}

export function gitRaw(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

export class TestRepo {
  private constructor(public readonly path: string) {}

  static create(): TestRepo {
    const dir = mkdtempSync(join(tmpdir(), 'squash-merge-test-'));
    git(dir, 'init', '-b', 'main');
    git(dir, 'config', 'user.name', 'test');
    git(dir, 'config', 'user.email', 'test@example.com');
    return new TestRepo(dir);
  }

  dispose(): void {
    rmSync(this.path, { recursive: true, force: true });
  }

  run(...args: string[]): string {
    return git(this.path, ...args);
  }

  /** 写入文件并提交，返回提交 id。 */
  commitFile(branch: string, file: string, content: string, message: string): string {
    try {
      this.run('show-ref', '--verify', '--quiet', `refs/heads/${branch}`);
      this.run('switch', '-q', branch);
    } catch {
      this.run('symbolic-ref', 'HEAD', `refs/heads/${branch}`);
    }
    const abs = join(this.path, file);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    this.run('add', file);
    this.run('commit', '-q', '-m', message);
    return this.run('rev-parse', 'HEAD');
  }

  head(branch: string): string {
    return this.run('rev-parse', `refs/heads/${branch}`);
  }

  fileAt(commit: string, file: string): string {
    return gitRaw(this.path, 'show', `${commit}:${file}`);
  }
}
