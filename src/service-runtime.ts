import type {
  DeploymentHandle,
  DeploymentResult,
  ServiceConfig,
  ServiceStatus,
  WorkUnit,
  WorkUnitContext,
  WorkUnitFactory,
} from "./types";

type RecordState = "preparing" | "active" | "draining" | "closing" | "done";

interface DeploymentRecord {
  readonly id: string;
  readonly config: ServiceConfig;
  unit: WorkUnit | undefined;
  state: RecordState;
  inflight: number;
  terminateRequested: boolean;
  readonly pending: Map<number, (error: Error) => void>;
  readonly result: Promise<DeploymentResult>;
  resolveResult: (result: DeploymentResult) => void;
  readonly done: Promise<void>;
  resolveDone: () => void;
}

export class ServiceRuntime {
  private readonly deployments = new Map<string, DeploymentRecord>();
  private activeId: string | null = null;
  private deploySeq = 0;
  private requestSeq = 0;

  deploy(config: ServiceConfig, factory: WorkUnitFactory): DeploymentHandle {
    this.deploySeq += 1;
    const id = `d${this.deploySeq}`;

    for (const record of this.deployments.values()) {
      if (record.state === "preparing") {
        record.resolveResult({ kind: "superseded" });
        this.requestTerminate(record);
      }
    }

    let resolveResult!: (result: DeploymentResult) => void;
    let resolveDone!: () => void;
    const record: DeploymentRecord = {
      id,
      config,
      unit: undefined,
      state: "preparing",
      inflight: 0,
      terminateRequested: false,
      pending: new Map(),
      result: new Promise<DeploymentResult>((resolve) => {
        resolveResult = resolve;
      }),
      resolveResult,
      done: new Promise<void>((resolve) => {
        resolveDone = resolve;
      }),
      resolveDone,
    };
    this.deployments.set(id, record);

    const context: WorkUnitContext = {
      notifyReady: () => this.dispatch(record, () => this.onReady(record)),
      notifyFailed: (error: unknown) =>
        this.dispatch(record, () => this.onFailed(record, error)),
      notifyExited: (error?: unknown) =>
        this.dispatch(record, () => this.onExited(record, error)),
    };

    let unit: WorkUnit;
    try {
      unit = factory(context);
    } catch (error) {
      record.resolveResult({ kind: "failed", error });
      record.state = "done";
      record.resolveDone();
      return { id, result: record.result };
    }
    record.unit = unit;
    return { id, result: record.result };
  }

  private dispatch(record: DeploymentRecord, action: () => void): void {
    if (record.unit === undefined && record.state === "preparing") {
      queueMicrotask(() => this.dispatch(record, action));
      return;
    }
    action();
  }

  private onReady(record: DeploymentRecord): void {
    if (record.state !== "preparing") {
      return;
    }
    const previous = this.activeId
      ? this.deployments.get(this.activeId)
      : undefined;
    this.activeId = record.id;
    record.state = "active";
    record.resolveResult({ kind: "active" });
    if (previous && previous.state === "active") {
      previous.state = "draining";
      this.maybeTerminate(previous);
    }
  }

  private onFailed(record: DeploymentRecord, error: unknown): void {
    if (record.state !== "preparing") {
      return;
    }
    record.resolveResult({ kind: "failed", error });
    this.requestTerminate(record);
  }

  private onExited(record: DeploymentRecord, error?: unknown): void {
    if (record.state === "done" || record.state === "closing") {
      return;
    }
    const failure =
      error instanceof Error ? error : new Error("work unit exited");
    const rejects = [...record.pending.values()];
    record.pending.clear();
    record.inflight = 0;
    if (record.state === "active" && this.activeId === record.id) {
      this.activeId = null;
    }
    if (record.state === "preparing") {
      record.resolveResult({ kind: "failed", error: failure });
    }
    record.state = "done";
    record.resolveDone();
    for (const reject of rejects) {
      reject(failure);
    }
  }

  private maybeTerminate(record: DeploymentRecord): void {
    if (record.state === "draining" && record.inflight === 0) {
      this.requestTerminate(record);
    }
  }

  private requestTerminate(record: DeploymentRecord): void {
    if (record.terminateRequested || record.state === "done") {
      return;
    }
    record.terminateRequested = true;
    record.state = "closing";
    const unit = record.unit;
    if (!unit) {
      record.state = "done";
      record.resolveDone();
      return;
    }
    Promise.resolve()
      .then(() => unit.terminate())
      .then(
        () => {
          record.state = "done";
          record.resolveDone();
        },
        () => {
          record.state = "done";
          record.resolveDone();
        },
      );
  }

  submit(request: unknown): Promise<unknown> {
    const active = this.activeId
      ? this.deployments.get(this.activeId)
      : undefined;
    if (!active || active.state !== "active" || !active.unit) {
      return Promise.reject(new Error("service unavailable"));
    }
    const record = active;
    const unit = active.unit;
    record.inflight += 1;
    this.requestSeq += 1;
    const key = this.requestSeq;
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const settle = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (record.pending.delete(key)) {
          record.inflight -= 1;
          this.maybeTerminate(record);
        }
      };
      record.pending.set(key, (error: Error) => {
        settle();
        reject(error);
      });
      let outcome: Promise<unknown>;
      try {
        outcome = Promise.resolve(unit.handleRequest(request));
      } catch (error) {
        outcome = Promise.reject(error);
      }
      outcome.then(
        (value) => {
          settle();
          resolve(value);
        },
        (error) => {
          settle();
          reject(error);
        },
      );
    });
  }

  async stop(): Promise<void> {
    const affected = [...this.deployments.values()].filter(
      (record) => record.state !== "done",
    );
    if (this.activeId) {
      const active = this.deployments.get(this.activeId);
      this.activeId = null;
      if (active && active.state === "active") {
        active.state = "draining";
        this.maybeTerminate(active);
      }
    }
    for (const record of affected) {
      if (record.state === "preparing") {
        record.resolveResult({ kind: "stopped" });
        this.requestTerminate(record);
      }
    }
    await Promise.all(affected.map((record) => record.done));
  }

  status(): ServiceStatus {
    const active = this.activeId
      ? this.deployments.get(this.activeId)
      : undefined;
    const serving = !!active && active.state === "active";
    const preparing = [...this.deployments.values()].find(
      (record) => record.state === "preparing",
    );
    return {
      serving,
      ...(serving && active
        ? {
            active: {
              deploymentId: active.id,
              config: active.config,
              inflight: active.inflight,
            },
          }
        : {}),
      ...(preparing ? { preparing: { deploymentId: preparing.id } } : {}),
    };
  }
}
