import { execFile } from 'node:child_process';

export class GitError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

/** 三方合并产生冲突时抛出。 */
export class MergeConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MergeConflictError';
  }
}

interface RunResult {
  stdout: string;
  stderr: string;
}

/** 对本地 Git 仓库的操作封装（全部通过 git CLI，不依赖工作区状态）。 */
export class GitRepo {
  constructor(public readonly repoPath: string) {}

  private run(args: string[], env: NodeJS.ProcessEnv = {}): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        ['-C', this.repoPath, ...args],
        { env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            const err = new GitError(
              `git ${args.join(' ')} failed: ${stderr.trim() || error.message}`,
              stderr,
            );
            (err as unknown as { code: unknown }).code = (
              error as unknown as { code?: unknown }
            ).code;
            reject(err);
          } else {
            resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
          }
        },
      );
    });
  }

  private async runAllowExit(args: string[]): Promise<{ code: number; stdout: string }> {
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        ['-C', this.repoPath, ...args],
        { env: { ...process.env }, maxBuffer: 64 * 1024 * 1024 },
        (error, stdout) => {
          if (error && typeof (error as { code?: unknown }).code !== 'number') {
            reject(
              new GitError(`git ${args.join(' ')} failed: ${error.message}`, ''),
            );
          } else {
            resolve({
              code: error ? ((error as unknown as { code: number }).code ?? 1) : 0,
              stdout: stdout.toString(),
            });
          }
        },
      );
    });
  }

  /** 解析引用/提交为完整 commit id；失败抛 GitError。 */
  async revParse(ref: string): Promise<string> {
    const { stdout } = await this.run(['rev-parse', '--verify', `${ref}^{commit}`]);
    return stdout.trim();
  }

  /** 两个提交的最近共同祖先。 */
  async mergeBase(a: string, b: string): Promise<string> {
    const { stdout } = await this.run(['merge-base', a, b]);
    return stdout.trim();
  }

  /** 判断 ancestor 是否为 descendant 的祖先（含相等）。 */
  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const { code } = await this.runAllowExit([
      'merge-base',
      '--is-ancestor',
      ancestor,
      descendant,
    ]);
    return code === 0;
  }

  private async identityEnv(): Promise<NodeJS.ProcessEnv> {
    const read = async (key: string): Promise<string> => {
      const { code, stdout } = await this.runAllowExit(['config', '--get', key]);
      return code === 0 ? stdout.trim() : '';
    };
    const name = (await read('user.name')) || 'git-squash-merge';
    const email = (await read('user.email')) || 'git-squash-merge@localhost';
    return {
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
    };
  }

  /** 以 parent 为唯一父、tree 为内容创建提交，返回提交 id。 */
  async commitTree(tree: string, parent: string, message: string): Promise<string> {
    const env = await this.identityEnv();
    const { stdout } = await this.run(
      ['commit-tree', tree, '-p', parent, '-m', message],
      env,
    );
    return stdout.trim();
  }

  /**
   * 计算 squash 合并后的 tree：
   * 以 targetHead 为基础，叠加 source 相对 mergeBase 的改动。
   * 冲突时抛 MergeConflictError。
   */
  async squashTree(targetHead: string, source: string, mergeBase: string): Promise<string> {
    const { code, stdout } = await this.runAllowExit([
      'merge-tree',
      '--write-tree',
      `--merge-base=${mergeBase}`,
      targetHead,
      source,
    ]);
    const tree = stdout.split('\n', 1)[0]?.trim() ?? '';
    if (code !== 0) {
      throw new MergeConflictError(
        `squash merge of ${source} onto ${targetHead} produced conflicts`,
      );
    }
    if (!/^[0-9a-f]{40,64}$/.test(tree)) {
      throw new GitError(`git merge-tree returned unexpected output: ${stdout}`, stdout);
    }
    return tree;
  }

  /**
   * 将分支引用更新到指定提交；提供 expectedOld 时为 compare-and-swap，
   * 当前值不匹配时抛 GitError。
   */
  async updateRef(branch: string, commit: string, expectedOld?: string): Promise<void> {
    const ref = branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
    const args = ['update-ref', ref, commit];
    if (expectedOld !== undefined) args.push(expectedOld);
    await this.run(args);
  }

  /** 提交的 tree id。 */
  async treeOf(commit: string): Promise<string> {
    const { stdout } = await this.run(['rev-parse', '--verify', `${commit}^{tree}`]);
    return stdout.trim();
  }

  /** 提交的父提交列表。 */
  async parentsOf(commit: string): Promise<string[]> {
    const { stdout } = await this.run(['rev-list', '--parents', '-n', '1', commit]);
    const parts = stdout.trim().split(/\s+/);
    return parts.slice(1).filter((p) => p.length > 0);
  }

  /** from..to 之间沿祖先路径的提交（从最接近 from 的开始）。 */
  async ancestryPath(from: string, to: string): Promise<string[]> {
    const { stdout } = await this.run([
      'rev-list',
      '--reverse',
      '--ancestry-path',
      `${from}..${to}`,
    ]);
    return stdout.trim().length === 0 ? [] : stdout.trim().split('\n');
  }
}
