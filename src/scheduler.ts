import { NodeProcessRunner } from './runner.ts';
import type { ProcessRunner, SpawnedProcess } from './runner.ts';
import type {
  PipelineHandle,
  PipelineRequest,
  PipelineResult,
  PipelineSnapshot,
  PipelineStatus,
  ServiceSnapshot,
  ServiceStatus,
  StepSnapshot,
  StepSpec,
  StepStatus,
} from './types.ts';

export interface SchedulerOptions {
  runner?: ProcessRunner;
  now?: () => number;
}

const TERMINAL_STEP: ReadonlySet<StepStatus> = new Set([
  'succeeded',
  'failed',
  'timeout',
  'cancelled',
  'skipped',
]);

const TERMINAL_SERVICE: ReadonlySet<ServiceStatus> = new Set([
  'succeeded',
  'failed',
  'blocked',
  'cancelled',
  'out-of-scope',
]);

interface StepState {
  spec: StepSpec;
  status: StepStatus;
  exitCode: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  proc: SpawnedProcess | null;
  timer: ReturnType<typeof setTimeout> | null;
  killTimer: ReturnType<typeof setTimeout> | null;
  slotHeld: boolean;
}

interface ServiceState {
  name: string;
  inScope: boolean;
  status: ServiceStatus;
  steps: StepState[];
  nextStep: number;
  deps: string[];
  dependents: string[];
}

let nextPipelineSeq = 1;

class Pipeline implements PipelineHandle {
  readonly id: string;

  private readonly services = new Map<string, ServiceState>();
  private readonly order: string[] = [];
  private readonly runner: ProcessRunner;
  private readonly now: () => number;
  private readonly concurrency: number;
  private readonly killGraceMs: number | null;
  private readonly startedAt: number;
  private readonly deadlineAt: number;
  private pipelineTimer: ReturnType<typeof setTimeout> | null = null;

  private slotsInUse = 0;
  private activeProcesses = 0;
  private timedOut = false;
  private stepTimedOut = false;
  private finalStatus: Exclude<PipelineStatus, 'running'> | null = null;
  private resultPromise: Promise<PipelineResult>;
  private resolveResult!: (r: PipelineResult) => void;

  constructor(req: PipelineRequest, runner: ProcessRunner, now: () => number) {
    this.runner = runner;
    this.now = now;
    this.id = `pipeline-${nextPipelineSeq++}`;
    this.concurrency = req.concurrency;
    this.killGraceMs = req.killGraceMs ?? null;
    this.startedAt = this.now();
    this.deadlineAt = this.startedAt + req.pipelineTimeoutMs;
    this.resultPromise = new Promise((resolve) => {
      this.resolveResult = resolve;
    });

    this.buildGraph(req);

    this.pipelineTimer = setTimeout(() => this.onPipelineTimeout(), req.pipelineTimeoutMs);
    this.pump();
  }

  private buildGraph(req: PipelineRequest): void {
    if (!Number.isFinite(req.concurrency) || req.concurrency < 1) {
      throw new Error('concurrency must be a positive integer');
    }
    if (!Number.isFinite(req.pipelineTimeoutMs) || req.pipelineTimeoutMs <= 0) {
      throw new Error('pipelineTimeoutMs must be positive');
    }
    const names = new Set<string>();
    for (const svc of req.services) {
      if (names.has(svc.name)) throw new Error(`duplicate service: ${svc.name}`);
      names.add(svc.name);
      for (const step of svc.steps) {
        if (!Number.isFinite(step.timeoutMs) || step.timeoutMs <= 0) {
          throw new Error(`step ${svc.name}/${step.name}: timeoutMs must be positive`);
        }
      }
    }
    const depsOf = new Map<string, string[]>();
    for (const name of names) depsOf.set(name, []);
    for (const [svc, deps] of Object.entries(req.dependencies)) {
      if (!names.has(svc)) throw new Error(`unknown service in dependencies: ${svc}`);
      for (const dep of deps) {
        if (!names.has(dep)) throw new Error(`unknown dependency ${dep} of ${svc}`);
      }
      depsOf.set(svc, [...deps]);
    }
    for (const changed of req.changedServices) {
      if (!names.has(changed)) throw new Error(`unknown changed service: ${changed}`);
    }

    // Cycle check (caller promises acyclic, but never trust blindly).
    const color = new Map<string, number>();
    const visit = (n: string, stack: string[]): void => {
      const c = color.get(n) ?? 0;
      if (c === 1) throw new Error(`dependency cycle detected: ${[...stack, n].join(' -> ')}`);
      if (c === 2) return;
      color.set(n, 1);
      for (const d of depsOf.get(n)!) visit(d, [...stack, n]);
      color.set(n, 2);
    };
    for (const n of names) visit(n, []);

    // Scope = changed services + all transitive dependents.
    const dependentsOf = new Map<string, string[]>();
    for (const n of names) dependentsOf.set(n, []);
    for (const [svc, deps] of depsOf) {
      for (const dep of deps) dependentsOf.get(dep)!.push(svc);
    }
    const inScope = new Set<string>();
    const queue = [...req.changedServices];
    while (queue.length > 0) {
      const n = queue.pop()!;
      if (inScope.has(n)) continue;
      inScope.add(n);
      for (const d of dependentsOf.get(n)!) queue.push(d);
    }

    for (const svc of req.services) {
      const scoped = inScope.has(svc.name);
      const state: ServiceState = {
        name: svc.name,
        inScope: scoped,
        status: scoped ? 'pending' : 'out-of-scope',
        steps: svc.steps.map((spec) => ({
          spec,
          status: 'pending',
          exitCode: null,
          startedAt: null,
          finishedAt: null,
          proc: null,
          timer: null,
          killTimer: null,
          slotHeld: false,
        })),
        nextStep: 0,
        deps: depsOf.get(svc.name)!,
        dependents: dependentsOf.get(svc.name)!,
      };
      this.services.set(svc.name, state);
      this.order.push(svc.name);
    }
  }

  snapshot(): PipelineSnapshot {
    const services: ServiceSnapshot[] = this.order.map((name) => {
      const s = this.services.get(name)!;
      const steps: StepSnapshot[] = s.steps.map((st) => ({
        name: st.spec.name,
        status: st.status,
        exitCode: st.exitCode,
        startedAt: st.startedAt,
        finishedAt: st.finishedAt,
      }));
      return { name: s.name, inScope: s.inScope, status: s.status, steps };
    });
    return {
      id: this.id,
      status: this.finalStatus ?? 'running',
      slotsTotal: this.concurrency,
      slotsInUse: this.slotsInUse,
      startedAt: this.startedAt,
      deadlineAt: this.deadlineAt,
      services,
    };
  }

  result(): Promise<PipelineResult> {
    return this.resultPromise;
  }

  /** Central scheduling pass: start ready work, then check for completion. */
  private pump(): void {
    if (this.finalStatus !== null) return;

    if (!this.timedOut) {
      for (const name of this.order) {
        if (this.slotsInUse >= this.concurrency) break;
        const svc = this.services.get(name)!;
        if (!svc.inScope || TERMINAL_SERVICE.has(svc.status)) continue;
        if (svc.status === 'pending') {
          if (!this.depsSucceeded(svc)) continue;
          if (svc.steps.length === 0) {
            svc.status = 'succeeded';
            continue;
          }
          svc.status = 'running';
        }
        // svc.status === 'running' with a pending next step.
        if (svc.nextStep < svc.steps.length && svc.steps[svc.nextStep].status === 'pending') {
          this.startStep(svc, svc.steps[svc.nextStep]);
        }
      }
    }

    this.checkCompletion();
  }

  private depsSucceeded(svc: ServiceState): boolean {
    for (const dep of svc.deps) {
      const d = this.services.get(dep)!;
      if (d.inScope && d.status !== 'succeeded') return false;
    }
    return true;
  }

  private startStep(svc: ServiceState, step: StepState): void {
    step.status = 'running';
    step.startedAt = this.now();
    step.slotHeld = true;
    this.slotsInUse++;
    this.activeProcesses++;

    let proc: SpawnedProcess;
    try {
      proc = this.runner.spawn(step.spec.command, step.spec.args ?? [], {
        env: step.spec.env,
        cwd: step.spec.cwd,
      });
    } catch (err) {
      this.releaseSlot(step);
      this.failStep(svc, step, null);
      return;
    }
    step.proc = proc;

    proc.onStartError(() => {
      if (TERMINAL_STEP.has(step.status)) return;
      this.releaseSlot(step);
      this.failStep(svc, step, null);
      this.pump();
    });

    proc.onExit((code) => {
      this.clearStepTimers(step);
      this.releaseSlot(step);
      if (TERMINAL_STEP.has(step.status)) {
        // Late exit notification: terminal states are immutable.
        this.pump();
        return;
      }
      if (code === 0) {
        step.status = 'succeeded';
        step.exitCode = 0;
        step.finishedAt = this.now();
        svc.nextStep++;
        if (svc.nextStep >= svc.steps.length) {
          svc.status = 'succeeded';
        }
      } else {
        this.failStep(svc, step, code);
      }
      this.pump();
    });

    step.timer = setTimeout(() => this.onStepTimeout(svc, step), step.spec.timeoutMs);
  }

  private releaseSlot(step: StepState): void {
    if (!step.slotHeld) return;
    step.slotHeld = false;
    this.slotsInUse--;
    this.activeProcesses--;
  }

  private clearStepTimers(step: StepState): void {
    if (step.timer) {
      clearTimeout(step.timer);
      step.timer = null;
    }
    if (step.killTimer) {
      clearTimeout(step.killTimer);
      step.killTimer = null;
    }
  }

  private failStep(svc: ServiceState, step: StepState, exitCode: number | null): void {
    step.status = 'failed';
    step.exitCode = exitCode;
    step.finishedAt = this.now();
    this.failService(svc);
  }

  private failService(svc: ServiceState): void {
    svc.status = 'failed';
    for (const st of svc.steps) {
      if (st.status === 'pending') st.status = 'skipped';
    }
    this.blockDependents(svc.name);
  }

  private blockDependents(name: string): void {
    for (const depName of this.services.get(name)!.dependents) {
      const svc = this.services.get(depName)!;
      if (!svc.inScope || TERMINAL_SERVICE.has(svc.status)) continue;
      svc.status = 'blocked';
      for (const st of svc.steps) {
        if (st.status === 'pending') st.status = 'skipped';
      }
      this.blockDependents(depName);
    }
  }

  private onStepTimeout(svc: ServiceState, step: StepState): void {
    step.timer = null;
    if (this.finalStatus !== null || TERMINAL_STEP.has(step.status)) return;
    this.stepTimedOut = true;
    step.status = 'timeout';
    step.finishedAt = this.now();
    this.terminate(step);
    this.failService(svc);
    this.pump();
  }

  private onPipelineTimeout(): void {
    this.pipelineTimer = null;
    if (this.finalStatus !== null || this.timedOut) return;
    this.timedOut = true;
    for (const svc of this.services.values()) {
      if (!svc.inScope || TERMINAL_SERVICE.has(svc.status)) continue;
      for (const st of svc.steps) {
        if (st.status === 'running') {
          this.clearStepTimers(st);
          st.status = 'cancelled';
          st.finishedAt = this.now();
          this.terminate(st);
        } else if (st.status === 'pending') {
          st.status = 'cancelled';
        }
      }
      svc.status = 'cancelled';
    }
    this.pump();
  }

  private terminate(step: StepState): void {
    if (!step.proc) return;
    step.proc.kill('SIGTERM');
    if (this.killGraceMs !== null) {
      step.killTimer = setTimeout(() => {
        step.killTimer = null;
        step.proc?.kill('SIGKILL');
      }, this.killGraceMs);
    }
  }

  private checkCompletion(): void {
    if (this.finalStatus !== null) return;
    for (const svc of this.services.values()) {
      if (svc.inScope && !TERMINAL_SERVICE.has(svc.status)) return;
    }
    if (this.activeProcesses > 0) return;

    if (this.pipelineTimer) {
      clearTimeout(this.pipelineTimer);
      this.pipelineTimer = null;
    }
    const anyFailure = [...this.services.values()].some(
      (s) => s.inScope && (s.status === 'failed' || s.status === 'blocked' || s.status === 'cancelled'),
    );
    const anyTimeout = this.timedOut || this.stepTimedOut;
    this.finalStatus = anyTimeout ? 'timeout' : anyFailure ? 'failed' : 'succeeded';
    const finishedAt = this.now();
    this.resolveResult({
      status: this.finalStatus,
      startedAt: this.startedAt,
      finishedAt,
      snapshot: this.snapshot(),
    });
  }
}

export class CiScheduler {
  private readonly runner: ProcessRunner;
  private readonly now: () => number;

  constructor(opts?: SchedulerOptions) {
    this.runner = opts?.runner ?? new NodeProcessRunner();
    this.now = opts?.now ?? (() => Date.now());
  }

  submitPipeline(req: PipelineRequest): PipelineHandle {
    return new Pipeline(req, this.runner, this.now);
  }
}
