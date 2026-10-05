import { LocalDockError } from './errors.ts';
import type {
  DeployHandle,
  ServiceStatus,
  WorkUnit,
  WorkUnitFactory,
  WorkUnitLifecycle,
} from './types.ts';

type RecordState =
  | 'preparing'
  | 'ready'
  | 'exited'
  | 'terminating'
  | 'terminated';

interface PendingRequest {
  reject(reason: unknown): void;
}

interface VersionRecord {
  readonly seq: number;
  readonly epoch: number;
  unit: WorkUnit;
  readonly pending: Set<PendingRequest>;
  state: RecordState;
  inflight: number;
  /** No longer needed; terminate as soon as allowed. */
  obsolete: boolean;
  terminateRequested: boolean;
  settleResolve: () => void;
  settleReject: (reason: unknown) => void;
  settledDone: boolean;
  /** Resolves once the work unit has fully ended (terminated or exited). */
  done: Promise<void>;
  doneResolve: () => void;
}

interface ServiceState {
  latestSeq: number;
  /** Bumped by stop(); notifications from older epochs are ignored. */
  epoch: number;
  serving: VersionRecord | null;
  /** Live records belonging to the current epoch. */
  records: Set<VersionRecord>;
  stopped: boolean;
}

/**
 * LocalDock: hot-swap lifecycle manager for in-process services.
 *
 * Capabilities: deploy a version, submit a request, stop a service, and
 * query status.
 */
export class LocalDock {
  private readonly services = new Map<string, ServiceState>();

  deploy(
    service: string,
    config: unknown,
    factory: WorkUnitFactory,
  ): DeployHandle {
    const svc = this.getOrCreate(service);
    svc.stopped = false;
    const seq = ++svc.latestSeq;

    let settleResolve!: () => void;
    let settleReject!: (reason: unknown) => void;
    const settled = new Promise<void>((resolve, reject) => {
      settleResolve = resolve;
      settleReject = reject;
    });
    // Deployment rejection is an expected outcome; avoid crashing hosts
    // that do not observe `settled`.
    settled.catch(() => {});
    let doneResolve!: () => void;
    const done = new Promise<void>((resolve) => {
      doneResolve = resolve;
    });

    const record: VersionRecord = {
      seq,
      epoch: svc.epoch,
      unit: undefined as unknown as WorkUnit,
      pending: new Set(),
      state: 'preparing',
      inflight: 0,
      obsolete: false,
      terminateRequested: false,
      settleResolve,
      settleReject,
      settledDone: false,
      done,
      doneResolve,
    };

    // A newer deployment supersedes every earlier non-serving version of
    // the current epoch. The serving version keeps traffic until the new
    // one is ready.
    for (const older of svc.records) {
      if (older === svc.serving) continue;
      if (older.state === 'preparing' || older.state === 'ready') {
        this.supersede(older);
      }
    }
    svc.records.add(record);

    const lifecycle: WorkUnitLifecycle = {
      notifyReady: () => this.onReady(svc, record),
      notifyExited: (error?: unknown) => this.onExited(svc, record, error),
    };

    let unit: WorkUnit;
    try {
      unit = factory(config, lifecycle);
    } catch (error) {
      // Factory failed synchronously: treat as a failed deployment.
      record.state = 'exited';
      record.doneResolve();
      this.settleOnce(
        record,
        'reject',
        new LocalDockError(
          'DEPLOY_FAILED',
          `deployment ${seq} of service "${service}" failed during setup`,
        ),
      );
      svc.records.delete(record);
      return { version: seq, settled };
    }
    record.unit = unit;
    return { version: seq, settled };
  }

  submitRequest(service: string, request: unknown): Promise<unknown> {
    const svc = this.services.get(service);
    const serving = svc?.serving ?? null;
    if (!serving || serving.state !== 'ready') {
      return Promise.reject(
        new LocalDockError(
          'NO_SERVING_VERSION',
          `service "${service}" has no serving version`,
        ),
      );
    }
    serving.inflight += 1;
    return new Promise<unknown>((resolve, reject) => {
      const entry: PendingRequest = { reject };
      serving.pending.add(entry);
      let result: Promise<unknown>;
      try {
        result = serving.unit.handleRequest(request);
      } catch (error) {
        serving.pending.delete(entry);
        serving.inflight -= 1;
        this.maybeTerminate(serving);
        reject(error);
        return;
      }
      Promise.resolve(result).then(
        (value) => {
          serving.pending.delete(entry);
          serving.inflight -= 1;
          this.maybeTerminate(serving);
          resolve(value);
        },
        (error) => {
          serving.pending.delete(entry);
          serving.inflight -= 1;
          this.maybeTerminate(serving);
          reject(error);
        },
      );
    });
  }

  stop(service: string): Promise<void> {
    const svc = this.services.get(service);
    if (!svc) return Promise.resolve();
    // Close the request entry immediately and invalidate everything from
    // the current epoch, including unfinished deployments.
    svc.epoch += 1;
    svc.stopped = true;
    svc.serving = null;
    const affected = [...svc.records];
    svc.records.clear();
    for (const record of affected) {
      record.obsolete = true;
      if (record.state === 'preparing' || record.state === 'ready') {
        this.settleOnce(
          record,
          'reject',
          new LocalDockError(
            'DEPLOY_INVALIDATED',
            `deployment ${record.seq} of service "${service}" was invalidated by stop`,
          ),
        );
      }
      this.maybeTerminate(record);
    }
    // Completes once in-flight requests have drained and every affected
    // work unit has ended.
    return Promise.all(affected.map((record) => record.done)).then(() => {});
  }

  getStatus(service: string): ServiceStatus {
    const svc = this.services.get(service);
    if (!svc) {
      return { phase: 'unavailable', activeVersion: null, inflightRequests: 0 };
    }
    const serving = svc.serving;
    if (serving && serving.state === 'ready') {
      return {
        phase: 'serving',
        activeVersion: serving.seq,
        inflightRequests: serving.inflight,
      };
    }
    if (svc.stopped) {
      return { phase: 'stopped', activeVersion: null, inflightRequests: 0 };
    }
    for (const record of svc.records) {
      if (record.state === 'preparing' && record.seq === svc.latestSeq) {
        return { phase: 'preparing', activeVersion: null, inflightRequests: 0 };
      }
    }
    return { phase: 'unavailable', activeVersion: null, inflightRequests: 0 };
  }

  private getOrCreate(service: string): ServiceState {
    let svc = this.services.get(service);
    if (!svc) {
      svc = {
        latestSeq: 0,
        epoch: 0,
        serving: null,
        records: new Set(),
        stopped: false,
      };
      this.services.set(service, svc);
    }
    return svc;
  }

  private settleOnce(
    record: VersionRecord,
    kind: 'resolve' | 'reject',
    reason?: unknown,
  ): void {
    if (record.settledDone) return;
    record.settledDone = true;
    if (kind === 'resolve') record.settleResolve();
    else record.settleReject(reason);
  }

  private supersede(record: VersionRecord): void {
    record.obsolete = true;
    this.settleOnce(
      record,
      'reject',
      new LocalDockError(
        'DEPLOY_SUPERSEDED',
        `deployment ${record.seq} was superseded by a newer deployment`,
      ),
    );
    this.maybeTerminate(record);
  }

  private onReady(svc: ServiceState, record: VersionRecord): void {
    // Tolerate late, duplicate, or stale notifications.
    if (record.state !== 'preparing') return;
    if (record.epoch !== svc.epoch) return;
    record.state = 'ready';
    if (record.seq !== svc.latestSeq) {
      // Covered by a newer deployment: never allowed to take over.
      this.supersede(record);
      return;
    }
    const previous = svc.serving;
    svc.serving = record;
    this.settleOnce(record, 'resolve');
    if (previous && previous !== record) {
      // Deployment succeeds without waiting for the old version's
      // requests to finish; the old unit terminates once they drain.
      previous.obsolete = true;
      this.maybeTerminate(previous);
    }
  }

  private onExited(
    svc: ServiceState,
    record: VersionRecord,
    error?: unknown,
  ): void {
    // Ignore late or duplicate notifications for units already ending.
    if (
      record.state === 'exited' ||
      record.state === 'terminating' ||
      record.state === 'terminated'
    ) {
      return;
    }
    const wasPreparing = record.state === 'preparing';
    record.state = 'exited';
    // An unexpected exit fails only this unit's unfinished requests.
    const exitError =
      error ??
      new LocalDockError(
        'UNIT_EXITED',
        `work unit of deployment ${record.seq} exited unexpectedly`,
      );
    for (const entry of record.pending) entry.reject(exitError);
    record.pending.clear();
    record.inflight = 0;
    record.doneResolve();
    svc.records.delete(record);
    if (svc.serving === record) {
      // No fallback to versions that already left the serving role.
      svc.serving = null;
    }
    if (wasPreparing && record.epoch === svc.epoch) {
      this.settleOnce(
        record,
        'reject',
        new LocalDockError(
          'DEPLOY_FAILED',
          `deployment ${record.seq} exited before becoming ready`,
        ),
      );
    }
  }

  private maybeTerminate(record: VersionRecord): void {
    if (!record.obsolete || record.terminateRequested) return;
    if (record.state !== 'preparing' && record.state !== 'ready') return;
    // Ready units finish their admitted requests first; units that never
    // became ready own no requests and may terminate immediately.
    if (record.state === 'ready' && record.inflight > 0) return;
    record.terminateRequested = true;
    record.state = 'terminating';
    Promise.resolve()
      .then(() => record.unit.terminate())
      .then(
        () => {
          record.state = 'terminated';
          record.doneResolve();
        },
        () => {
          // Termination must eventually complete; a failing terminate()
          // still ends the unit from LocalDock's perspective.
          record.state = 'terminated';
          record.doneResolve();
        },
      );
  }
}
