import type { WorkUnit, WorkUnitContext, WorkUnitFactory } from "../src/index";

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(error?: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await tick();
  }
}

export interface FakeRequest {
  readonly request: unknown;
  readonly deferred: Deferred<unknown>;
}

export class FakeUnit implements WorkUnit {
  terminateCalls = 0;
  readonly requests: FakeRequest[] = [];
  terminateImpl: () => Promise<void> = () => Promise.resolve();

  constructor(readonly context: WorkUnitContext) {}

  handleRequest(request: unknown): Promise<unknown> {
    const entry: FakeRequest = { request, deferred: deferred<unknown>() };
    this.requests.push(entry);
    return entry.deferred.promise;
  }

  terminate(): Promise<void> {
    this.terminateCalls += 1;
    return this.terminateImpl();
  }
}

export class FakeFactory {
  readonly units: FakeUnit[] = [];

  readonly factory: WorkUnitFactory = (context: WorkUnitContext) => {
    const unit = new FakeUnit(context);
    this.units.push(unit);
    return unit;
  };

  get last(): FakeUnit {
    const unit = this.units[this.units.length - 1];
    if (!unit) {
      throw new Error("no unit created yet");
    }
    return unit;
  }
}
