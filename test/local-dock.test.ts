import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LocalDock, LocalDockError } from '../src/index.ts';
import type { WorkUnit, WorkUnitLifecycle } from '../src/index.ts';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let queued microtasks (e.g. termination kicks) run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

class FakeUnit implements WorkUnit {
  lifecycle!: WorkUnitLifecycle;
  config: unknown;
  terminateCalls = 0;
  terminateCompleted = false;
  autoCompleteTerminate = true;
  readonly handled: unknown[] = [];
  private readonly pending = new Map<unknown, Deferred<unknown>>();
  private readonly terminateWaiters: Array<() => void> = [];

  handleRequest(request: unknown): Promise<unknown> {
    this.handled.push(request);
    const slot = deferred<unknown>();
    this.pending.set(request, slot);
    return slot.promise;
  }

  complete(request: unknown, value: unknown): void {
    const slot = this.pending.get(request);
    assert.ok(slot, `no pending request: ${String(request)}`);
    this.pending.delete(request);
    slot.resolve(value);
  }

  get inflight(): number {
    return this.pending.size;
  }

  terminate(): Promise<void> {
    this.terminateCalls += 1;
    return new Promise<void>((resolve) => {
      const finish = () => {
        this.terminateCompleted = true;
        resolve();
      };
      if (this.autoCompleteTerminate) finish();
      else this.terminateWaiters.push(finish);
    });
  }

  finishTermination(): void {
    for (const waiter of this.terminateWaiters.splice(0)) waiter();
  }
}

function deployFake(
  dock: LocalDock,
  service: string,
  config: unknown = {},
): { handle: ReturnType<LocalDock['deploy']>; unit: FakeUnit } {
  const unit = new FakeUnit();
  const handle = dock.deploy(service, config, (cfg, lifecycle) => {
    unit.config = cfg;
    unit.lifecycle = lifecycle;
    return unit;
  });
  return { handle, unit };
}

test('ready deployment takes over; old requests drain on the old version', async () => {
  const dock = new LocalDock();
  const v1 = deployFake(dock, 'svc', { n: 1 });
  v1.unit.lifecycle.notifyReady();
  assert.equal(dock.getStatus('svc').activeVersion, 1);

  const sticky = dock.submitRequest('svc', 'sticky');
  const v2 = deployFake(dock, 'svc', { n: 2 });
  v2.unit.lifecycle.notifyReady();

  // Deployment succeeds without waiting for the old request to finish.
  await v2.handle.settled;
  assert.equal(dock.getStatus('svc').activeVersion, 2);
  assert.equal(v1.unit.terminateCalls, 0, 'old unit waits for its request');

  // Requests admitted before the switch stay on the old version.
  v1.unit.complete('sticky', 'old-result');
  assert.equal(await sticky, 'old-result');
  await flush();
  assert.equal(v1.unit.terminateCalls, 1);
  assert.ok(v1.unit.terminateCompleted);

  // New requests only go to the new version.
  const fresh = dock.submitRequest('svc', 'fresh');
  v2.unit.complete('fresh', 'new-result');
  assert.equal(await fresh, 'new-result');
  assert.deepEqual(v2.unit.handled, ['fresh']);
});

test('request fails immediately when no version is serving', async () => {
  const dock = new LocalDock();
  await assert.rejects(dock.submitRequest('svc', 'x'), (error: unknown) => {
    assert.ok(error instanceof LocalDockError);
    assert.equal(error.code, 'NO_SERVING_VERSION');
    return true;
  });
  assert.equal(dock.getStatus('svc').phase, 'unavailable');
});

test('overlapping deploys: later fails first, earlier ready later must not take over', async () => {
  const dock = new LocalDock();
  const stable = deployFake(dock, 'svc');
  stable.unit.lifecycle.notifyReady();
  assert.equal(dock.getStatus('svc').activeVersion, 1);

  const first = deployFake(dock, 'svc');
  const second = deployFake(dock, 'svc');
  // The newer deployment supersedes the earlier one immediately.
  await assert.rejects(first.handle.settled, /superseded/);
  await flush();
  assert.equal(first.unit.terminateCalls, 1, 'superseded unit is terminated even before ready');

  // The later version fails while the earlier one is still preparing.
  second.unit.lifecycle.notifyExited(new Error('boom'));
  await assert.rejects(second.handle.settled, /exited before becoming ready/);

  // The earlier version's late readiness must not let it take over.
  first.unit.lifecycle.notifyReady();
  await flush();
  assert.equal(dock.getStatus('svc').activeVersion, 1, 'original stable version keeps serving');
  assert.equal(dock.getStatus('svc').phase, 'serving');
  assert.equal(first.unit.terminateCalls, 1, 'no second terminate request');
  assert.equal(stable.unit.terminateCalls, 0);

  const req = dock.submitRequest('svc', 'still-old');
  stable.unit.complete('still-old', 1);
  await req;
  assert.deepEqual(stable.unit.handled, ['still-old']);
  assert.deepEqual(first.unit.handled, []);
});

test('stop with late notifications and a subsequent deploy', async () => {
  const dock = new LocalDock();
  const v1 = deployFake(dock, 'svc');
  v1.unit.lifecycle.notifyReady();
  const inflightReq = dock.submitRequest('svc', 'inflight');
  const v2 = deployFake(dock, 'svc'); // still preparing when stop hits
  v2.unit.autoCompleteTerminate = false;

  let stopped = false;
  const stopPromise = dock.stop('svc').then(() => {
    stopped = true;
  });

  // The request entry closes immediately.
  await assert.rejects(dock.submitRequest('svc', 'late'), /no serving version/);
  assert.equal(dock.getStatus('svc').phase, 'stopped');
  await assert.rejects(v2.handle.settled, /invalidated by stop/);

  // Stop waits for the in-flight request and for terminations.
  await flush();
  assert.equal(stopped, false);
  assert.equal(v2.unit.terminateCalls, 1, 'preparing unit terminated at once');
  assert.equal(v1.unit.terminateCalls, 0, 'serving unit waits for its request');

  // Late notifications from invalidated versions are ignored.
  v2.unit.lifecycle.notifyReady();
  v1.unit.lifecycle.notifyReady();
  await flush();
  assert.equal(dock.getStatus('svc').phase, 'stopped');

  // A deployment after the stop may serve again.
  const v3 = deployFake(dock, 'svc');
  v3.unit.lifecycle.notifyReady();
  await v3.handle.settled;
  assert.equal(dock.getStatus('svc').activeVersion, 3);

  // Finishing the old request lets the old unit terminate; stop completes
  // only after all affected units have fully terminated.
  v1.unit.complete('inflight', 'done');
  assert.equal(await inflightReq, 'done');
  await flush();
  assert.equal(v1.unit.terminateCalls, 1);
  assert.equal(stopped, false, 'stop still waits for v2 termination');
  v2.unit.finishTermination();
  await stopPromise;
  assert.equal(stopped, true);

  // The new version is untouched by the previous stop's late cleanup.
  assert.equal(v3.unit.terminateCalls, 0);
  assert.equal(dock.getStatus('svc').activeVersion, 3);
  v1.unit.lifecycle.notifyExited(new Error('late exit'));
  v2.unit.lifecycle.notifyExited(new Error('late exit'));
  await flush();
  assert.equal(dock.getStatus('svc').activeVersion, 3);
  assert.equal(v3.unit.terminateCalls, 0);

  const req = dock.submitRequest('svc', 'after-stop');
  v3.unit.complete('after-stop', 3);
  assert.equal(await req, 3);
});

test('unexpected exit of the serving unit fails its requests, no fallback', async () => {
  const dock = new LocalDock();
  const v1 = deployFake(dock, 'svc');
  v1.unit.lifecycle.notifyReady();
  const v2 = deployFake(dock, 'svc');
  v2.unit.lifecycle.notifyReady();
  await v2.handle.settled;
  await flush();
  assert.equal(v1.unit.terminateCalls, 1, 'replaced unit was retired');

  const doomed = dock.submitRequest('svc', 'doomed');
  const exitError = new Error('crashed');
  v2.unit.lifecycle.notifyExited(exitError);
  await assert.rejects(doomed, (error: unknown) => error === exitError);

  // Service becomes unavailable; it must not fall back to the retired v1.
  assert.equal(dock.getStatus('svc').phase, 'unavailable');
  assert.equal(dock.getStatus('svc').activeVersion, null);
  await assert.rejects(dock.submitRequest('svc', 'x'), /no serving version/);
  assert.equal(v1.unit.terminateCalls, 1);

  // Duplicate exit notification changes nothing.
  v2.unit.lifecycle.notifyExited(new Error('again'));
  await flush();
  assert.equal(dock.getStatus('svc').phase, 'unavailable');
});

test('exit of a non-serving unit does not affect the serving version', async () => {
  const dock = new LocalDock();
  const v1 = deployFake(dock, 'svc');
  v1.unit.lifecycle.notifyReady();
  const v2 = deployFake(dock, 'svc');
  v2.unit.lifecycle.notifyExited(new Error('prep failed'));
  await assert.rejects(v2.handle.settled, /exited before becoming ready/);
  assert.equal(dock.getStatus('svc').activeVersion, 1);
  const req = dock.submitRequest('svc', 'ok');
  v1.unit.complete('ok', 1);
  assert.equal(await req, 1);
});

test('duplicate and out-of-order lifecycle notifications are tolerated', async () => {
  const dock = new LocalDock();
  const v1 = deployFake(dock, 'svc');
  v1.unit.lifecycle.notifyReady();
  v1.unit.lifecycle.notifyReady(); // duplicate ready
  assert.equal(dock.getStatus('svc').activeVersion, 1);

  const v2 = deployFake(dock, 'svc');
  v2.unit.lifecycle.notifyReady();
  await v2.handle.settled;
  await flush();
  assert.equal(v1.unit.terminateCalls, 1);

  // Late exit from the terminated unit is ignored.
  v1.unit.lifecycle.notifyExited(new Error('late'));
  await flush();
  assert.equal(dock.getStatus('svc').activeVersion, 2);
  assert.equal(v1.unit.terminateCalls, 1);
  assert.equal(v2.unit.terminateCalls, 0);
});

test('stop retires every unit exactly once and waits for termination', async () => {
  const dock = new LocalDock();
  const v1 = deployFake(dock, 'svc');
  v1.unit.lifecycle.notifyReady();
  const v2 = deployFake(dock, 'svc');
  v2.unit.lifecycle.notifyReady();
  await v2.handle.settled;
  const hanging = dock.submitRequest('svc', 'hanging');
  v2.unit.autoCompleteTerminate = false;

  let stopped = false;
  const stopPromise = dock.stop('svc').then(() => {
    stopped = true;
  });
  await flush();
  assert.equal(v1.unit.terminateCalls, 1);
  assert.ok(v1.unit.terminateCompleted);
  assert.equal(v2.unit.terminateCalls, 0, 'waits for the in-flight request');
  assert.equal(stopped, false);

  v2.unit.complete('hanging', 'done');
  await hanging;
  await flush();
  assert.equal(v2.unit.terminateCalls, 1);
  assert.equal(stopped, false, 'termination of v2 still pending');
  v2.unit.finishTermination();
  await stopPromise;

  // Status must not report the terminated version as serving.
  const status = dock.getStatus('svc');
  assert.equal(status.phase, 'stopped');
  assert.equal(status.activeVersion, null);
  assert.equal(status.inflightRequests, 0);
});

test('status reflects lifecycle phases without exposing unready versions', async () => {
  const dock = new LocalDock();
  const v1 = deployFake(dock, 'svc');
  assert.equal(dock.getStatus('svc').phase, 'preparing');
  assert.equal(dock.getStatus('svc').activeVersion, null);

  v1.unit.lifecycle.notifyReady();
  const during = dock.submitRequest('svc', 'busy');
  const status = dock.getStatus('svc');
  assert.equal(status.phase, 'serving');
  assert.equal(status.activeVersion, 1);
  assert.equal(status.inflightRequests, 1);
  v1.unit.complete('busy', 1);
  await during;
  assert.equal(dock.getStatus('svc').inflightRequests, 0);
});

test('each deployment gets an independent unit even for identical config', async () => {
  const dock = new LocalDock();
  const a = deployFake(dock, 'svc', { same: true });
  const b = deployFake(dock, 'svc', { same: true });
  assert.notEqual(a.unit, b.unit);
  assert.notEqual(a.handle.version, b.handle.version);
  assert.deepEqual(a.unit.config, { same: true });
  assert.deepEqual(b.unit.config, { same: true });
});

test('factory throwing synchronously fails the deployment', async () => {
  const dock = new LocalDock();
  const handle = dock.deploy('svc', {}, () => {
    throw new Error('cannot build unit');
  });
  await assert.rejects(handle.settled, /failed during setup/);
  assert.equal(dock.getStatus('svc').phase, 'unavailable');
});
