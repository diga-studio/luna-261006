import { spawn } from "child_process";
import { StepSpec } from "./types";

/** 一个已启动的构建进程句柄 */
export interface ProcessHandle {
  /** 进程实际退出时 resolve，携带退出码；被信号杀死时为 null */
  readonly exited: Promise<number | null>;
  /** 请求终止该进程（不保证立即退出） */
  kill(): void;
}

/** 进程启动器：可注入假实现用于测试 */
export interface ProcessRunner {
  /** 启动进程；启动失败应 throw */
  start(step: StepSpec): ProcessHandle;
}

/** 基于 child_process.spawn 的真实实现 */
export class SpawnProcessRunner implements ProcessRunner {
  start(step: StepSpec): ProcessHandle {
    const child = spawn(step.command, step.args ?? [], {
      cwd: step.cwd,
      env: step.env ? { ...process.env, ...step.env } : process.env,
      stdio: "ignore",
    });

    const exited = new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
      child.on("error", () => resolve(null));
    });

    return {
      exited,
      kill: () => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* 进程可能已退出 */
        }
      },
    };
  }
}
