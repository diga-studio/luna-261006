import {
  PipelineHandle,
  PipelineResult,
  PipelineSpec,
  PipelineStatus,
  ServiceName,
  ServiceState,
  ServiceStatus,
  StepSpec,
  StepState,
} from "./types";
import { ProcessHandle, ProcessRunner } from "./process";

interface StepRuntime {
  spec: StepSpec;
  state: StepState;
  exitCode: number | null;
  /** 退出通知是否已处理（保证名额只归还一次、终态不被改写） */
  exitHandled: boolean;
  /** 运行中的进程句柄（用于超时终止） */
  proc: ProcessHandle | null;
}

interface ServiceRuntime {
  name: ServiceName;
  state: ServiceState;
  steps: StepRuntime[];
  nextStepIndex: number;
  /** 范围内尚未成功的依赖数 */
  pendingDeps: number;
  /** 当前是否有一个步骤进程在跑 */
  activeProcess: boolean;
  /** 是否已进过就绪队列 */
  scheduled: boolean;
}

export class Pipeline implements PipelineHandle {
  private readonly spec: PipelineSpec;
  private readonly runner: ProcessRunner;
  private readonly pipelineId: string;

  private readonly services = new Map<ServiceName, ServiceRuntime>();
  private readonly dependents = new Map<ServiceName, ServiceName[]>();
  private readonly scope = new Set<ServiceName>();

  private freeSlots: number;
  private readonly slotQueue: ServiceRuntime[] = [];
  private activeProcesses = 0;
  private readonly stepTimers = new Set<NodeJS.Timeout>();
  private pipelineTimer: NodeJS.Timeout | null = null;

  private stopped = false;
  private timeoutOccurred = false;
  private anyFailed = false;
  private completed = false;
  private finalStatus: PipelineStatus | null = null;
  private waiters: Array<(s: PipelineStatus) => void> = [];

  constructor(spec: PipelineSpec, runner: ProcessRunner, id: string) {
    this.spec = spec;
    this.runner = runner;
    this.pipelineId = id;
    this.freeSlots = Math.max(1, spec.maxParallel);

    this.buildGraph();
    this.computeScope();
    this.initRuntimes();

    this.pipelineTimer = setTimeout(() => this.onPipelineTimeout(), spec.pipelineTimeoutMs);
    this.schedule();
  }

  get id(): string {
    return this.pipelineId;
  }

  status(): PipelineStatus {
    if (this.finalStatus) return this.finalStatus;
    return this.snapshot(null);
  }

  wait(): Promise<PipelineStatus> {
    if (this.finalStatus) return Promise.resolve(this.finalStatus);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  // ---------- 图与范围 ----------

  private buildGraph(): void {
    const names = new Set<ServiceName>();
    for (const s of this.spec.services) {
      if (names.has(s.name)) throw new Error(`duplicate service: ${s.name}`);
      names.add(s.name);
    }
    for (const s of this.spec.services) {
      for (const d of s.dependencies) {
        if (!names.has(d)) throw new Error(`unknown dependency ${d} of ${s.name}`);
        const list = this.dependents.get(d) ?? [];
        list.push(s.name);
        this.dependents.set(d, list);
      }
    }
    // 拓扑排序做环检测
    const indeg = new Map<ServiceName, number>();
    for (const s of this.spec.services) indeg.set(s.name, s.dependencies.length);
    const queue = this.spec.services.filter((s) => s.dependencies.length === 0).map((s) => s.name);
    let visited = 0;
    while (queue.length > 0) {
      const n = queue.pop()!;
      visited++;
      for (const dep of this.dependents.get(n) ?? []) {
        const d = indeg.get(dep)! - 1;
        indeg.set(dep, d);
        if (d === 0) queue.push(dep);
      }
    }
    if (visited !== this.spec.services.length) throw new Error("dependency graph has a cycle");
  }

  private computeScope(): void {
    // 范围 = 变更服务 + 所有直接/间接依赖它们的服务（下游）
    const queue: ServiceName[] = [];
    for (const c of this.spec.changed) {
      if (!this.spec.services.some((s) => s.name === c)) {
        throw new Error(`changed service not defined: ${c}`);
      }
      if (!this.scope.has(c)) {
        this.scope.add(c);
        queue.push(c);
      }
    }
    while (queue.length > 0) {
      const n = queue.pop()!;
      for (const dep of this.dependents.get(n) ?? []) {
        if (!this.scope.has(dep)) {
          this.scope.add(dep);
          queue.push(dep);
        }
      }
    }
  }

  private initRuntimes(): void {
    for (const s of this.spec.services) {
      if (!this.scope.has(s.name)) continue;
      const inScopeDeps = s.dependencies.filter((d) => this.scope.has(d));
      this.services.set(s.name, {
        name: s.name,
        state: "pending",
        steps: s.steps.map((spec) => ({
          spec,
          state: "pending",
          exitCode: null,
          exitHandled: false,
          proc: null,
        })),
        nextStepIndex: 0,
        pendingDeps: inScopeDeps.length,
        activeProcess: false,
        scheduled: false,
      });
    }
  }

  // ---------- 调度 ----------

  private schedule(): void {
    if (this.stopped) return;
    for (const svc of this.services.values()) {
      if (svc.state === "pending" && svc.pendingDeps === 0 && !svc.scheduled) {
        svc.state = "running";
        svc.scheduled = true;
        this.slotQueue.push(svc);
      }
    }
    this.pumpSlots();
  }

  private pumpSlots(): void {
    while (!this.stopped && this.freeSlots > 0 && this.slotQueue.length > 0) {
      const svc = this.slotQueue.shift()!;
      if (svc.state !== "running") continue;
      this.startNextStep(svc);
    }
  }

  private startNextStep(svc: ServiceRuntime): void {
    if (this.stopped || svc.state !== "running") return;
    if (svc.nextStepIndex >= svc.steps.length) {
      this.onServiceSucceeded(svc);
      return;
    }
    const step = svc.steps[svc.nextStepIndex]!;
    this.freeSlots--;
    this.activeProcesses++;
    svc.activeProcess = true;

    let proc: ProcessHandle;
    try {
      proc = this.runner.start(step.spec);
    } catch {
      // 启动失败：没有进程，立即归还名额
      this.freeSlots++;
      this.activeProcesses--;
      svc.activeProcess = false;
      step.state = "failed";
      this.onServiceFailed(svc);
      return;
    }

    step.state = "running";
    step.proc = proc;
    const timer = setTimeout(() => this.onStepTimeout(svc, step), this.spec.stepTimeoutMs);
    this.stepTimers.add(timer);

    proc.exited.then((code) => {
      clearTimeout(timer);
      this.stepTimers.delete(timer);
      this.onStepExit(svc, step, code);
    });
  }

  private onStepExit(svc: ServiceRuntime, step: StepRuntime, code: number | null): void {
    // 名额只在进程实际退出时归还，且只归还一次
    if (step.exitHandled) return;
    step.exitHandled = true;
    this.freeSlots++;
    this.activeProcesses--;
    svc.activeProcess = false;
    step.proc = null;

    // 步骤已有终态（如超时）：晚到的退出通知不得改写
    if (step.state !== "running") {
      this.pumpSlots();
      this.checkCompletion();
      return;
    }

    step.exitCode = code;
    if (code === 0) {
      step.state = "succeeded";
      svc.nextStepIndex++;
      if (svc.state !== "running") {
        // 服务在等待退出期间已被阻断/停止：不再推进
      } else if (svc.nextStepIndex >= svc.steps.length) {
        this.onServiceSucceeded(svc);
      } else if (!this.stopped) {
        this.slotQueue.push(svc);
      }
    } else {
      step.state = "failed";
      if (svc.state === "running") this.onServiceFailed(svc);
    }
    this.pumpSlots();
    this.checkCompletion();
  }

  private onStepTimeout(svc: ServiceRuntime, step: StepRuntime): void {
    if (step.state !== "running") return;
    this.timeoutOccurred = true;
    step.state = "timed_out";
    step.proc?.kill(); // 发出终止要求；名额等实际退出才归还
    if (svc.state === "running") this.onServiceFailed(svc);
    this.checkCompletion();
  }

  private onPipelineTimeout(): void {
    if (this.completed) return;
    this.timeoutOccurred = true;
    this.stopped = true;
    this.slotQueue.length = 0;

    for (const svc of this.services.values()) {
      if (svc.state === "pending") {
        svc.state = "blocked";
        this.skipRemainingSteps(svc);
      } else if (svc.state === "running") {
        const step = svc.steps[svc.nextStepIndex];
        if (svc.activeProcess && step && step.state === "running") {
          step.state = "timed_out";
          step.proc?.kill(); // 已启动步骤必须终止；名额等实际退出才归还
        }
        svc.state = "failed";
        this.anyFailed = true;
        this.skipRemainingSteps(svc);
      }
    }
    this.checkCompletion();
  }

  private onServiceSucceeded(svc: ServiceRuntime): void {
    svc.state = "succeeded";
    for (const depName of this.dependents.get(svc.name) ?? []) {
      const dep = this.services.get(depName);
      if (!dep || dep.state !== "pending") continue;
      dep.pendingDeps--;
    }
    this.schedule();
    this.checkCompletion();
  }

  private onServiceFailed(svc: ServiceRuntime): void {
    svc.state = "failed";
    this.anyFailed = true;
    this.skipRemainingSteps(svc);
    this.blockDependents(svc.name);
    this.checkCompletion();
  }

  private blockDependents(name: ServiceName): void {
    for (const depName of this.dependents.get(name) ?? []) {
      const dep = this.services.get(depName);
      if (!dep) continue;
      if (dep.state === "pending" || dep.state === "running") {
        dep.state = "blocked";
        this.skipRemainingSteps(dep);
        this.blockDependents(depName);
      }
    }
  }

  private skipRemainingSteps(svc: ServiceRuntime): void {
    for (const step of svc.steps) {
      if (step.state === "pending") step.state = "skipped";
    }
  }

  // ---------- 完成 ----------

  private checkCompletion(): void {
    if (this.completed) return;
    for (const svc of this.services.values()) {
      if (svc.state === "pending" || svc.state === "running") return;
    }
    // 所有属于本流水线的构建进程都已实际退出后才能报告完成
    if (this.activeProcesses > 0) return;

    this.completed = true;
    if (this.pipelineTimer) clearTimeout(this.pipelineTimer);
    for (const t of this.stepTimers) clearTimeout(t);
    this.stepTimers.clear();

    const result: PipelineResult = this.timeoutOccurred
      ? "timeout"
      : this.anyFailed
        ? "failure"
        : "success";
    this.finalStatus = this.snapshot(result);
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w(this.finalStatus);
  }

  private snapshot(result: PipelineResult | null): PipelineStatus {
    const services: Record<ServiceName, ServiceStatus> = {};
    for (const svc of this.services.values()) {
      services[svc.name] = {
        name: svc.name,
        state: svc.state,
        steps: svc.steps.map((s) => ({
          name: s.spec.name,
          state: s.state,
          exitCode: s.exitCode,
        })),
      };
    }
    return {
      id: this.pipelineId,
      phase: result === null ? "running" : "completed",
      result,
      services,
    };
  }
}
