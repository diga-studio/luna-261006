// Minimal ambient declarations for the Node built-ins used by the tests.
// Keeps the project free of a @types/node dependency so `npm install`
// only needs the TypeScript compiler.
declare module "node:test" {
  export type TestFn = () => void | Promise<void>;
  export interface Test {
    (name: string, fn: TestFn): void;
    (name: string, opts: unknown, fn: TestFn): void;
  }
  const test: Test;
  export default test;
}

declare module "node:assert/strict" {
  export interface Assert {
    (value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    throws(fn: () => unknown, message?: string): void;
    rejects(
      promise: Promise<unknown> | (() => Promise<unknown>),
      message?: string,
    ): Promise<void>;
    fail(message?: string): never;
  }
  const assert: Assert;
  export default assert;
}
