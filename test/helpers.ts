import { ProcessHandle, ProcessRunner } from "../src/process";
import { ServiceSpec, StepSpec } from "../src/types";

/** 假进程：退出由测试手动触发；kill 只记录终止要求，不代表已退出 */
export class FakeProc implements ProcessHandle {
  readonly exited: Promise<number | null>;
  private resolveExit!: (code: number | null) => void;
  killed = false;
  private exitCode: number | null | undefined = undefined;

  constructor(readonly step: StepSpec) {
    this.exited = new Promise((r) => (this.resolveExit = r));
  }

  kill(): void {
    this.killed = true;
  }

  /** 模拟进程实际退出 */
  exit(code: number | null): void {
    if (this.exitCode !== undefined) return;
    this.exitCode = code;
    this.resolveExit(code);
  }

  get hasExited(): boolean {
    return this.exitCode !== undefined;
  }
}

export class FakeRunner implements ProcessRunner {
  readonly procs: FakeProc[] = [];
  active = 0;
  maxActive = 0;

  start(step: StepSpec): ProcessHandle {
    const p = new FakeProc(step);
    this.procs.push(p);
    this.active++;
    if (this.active > this.maxActive) this.maxActive = this.active;
    p.exited.then(() => {
      this.active--;
    });
    return p;
  }

  find(stepName: string): FakeProc | undefined {
    return this.procs.find((p) => p.step.name === stepName);
  }

  started(stepName: string): boolean {
    return this.find(stepName) !== undefined;
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** 构造服务：步骤名即标识，command 统一为 "fake" */
export function svc(name: string, deps: string[], stepNames: string[]): ServiceSpec {
  return {
    name,
    dependencies: deps,
    steps: stepNames.map((n) => ({ name: n, command: "fake" })),
  };
}
