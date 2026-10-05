import { spawn } from 'node:child_process';

/** Abstraction over process spawning so tests can observe/intercept. */
export interface SpawnedProcess {
  readonly pid: number | undefined;
  /** Fires exactly once when the process has actually exited. */
  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  /** Fires at most once if the process failed to start. */
  onStartError(cb: (err: Error) => void): void;
  /** Send a signal; delivering a signal does not imply the process has exited. */
  kill(signal: NodeJS.Signals): void;
}

export interface ProcessRunner {
  spawn(
    command: string,
    args: string[],
    opts: { env?: Record<string, string>; cwd?: string },
  ): SpawnedProcess;
}

class NodeSpawnedProcess implements SpawnedProcess {
  private exitResult: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private startError: Error | null = null;
  private exitCbs: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  private errCbs: Array<(err: Error) => void> = [];
  private child: ReturnType<typeof spawn>;

  constructor(command: string, args: string[], opts: { env?: Record<string, string>; cwd?: string }) {
    this.child = spawn(command, args, {
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      cwd: opts.cwd,
      stdio: 'ignore',
    });
    this.child.on('error', (err) => {
      if (this.startError) return;
      this.startError = err;
      for (const cb of this.errCbs.splice(0)) cb(err);
    });
    this.child.on('exit', (code, signal) => {
      if (this.exitResult) return;
      this.exitResult = { code, signal };
      for (const cb of this.exitCbs.splice(0)) cb(code, signal);
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    if (this.exitResult) {
      const { code, signal } = this.exitResult;
      queueMicrotask(() => cb(code, signal));
    } else {
      this.exitCbs.push(cb);
    }
  }

  onStartError(cb: (err: Error) => void): void {
    if (this.startError) {
      const err = this.startError;
      queueMicrotask(() => cb(err));
    } else {
      this.errCbs.push(cb);
    }
  }

  kill(signal: NodeJS.Signals): void {
    try {
      this.child.kill(signal);
    } catch {
      // Process may already be gone; the exit notification (or its absence) is authoritative.
    }
  }
}

export class NodeProcessRunner implements ProcessRunner {
  spawn(
    command: string,
    args: string[],
    opts: { env?: Record<string, string>; cwd?: string },
  ): SpawnedProcess {
    return new NodeSpawnedProcess(command, args, opts);
  }
}
