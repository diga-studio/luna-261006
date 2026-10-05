// Minimal type shims for node:test / node:assert so the project builds
// without @types/node. Sufficient for this repository's tests.
declare module "node:test" {
  type TestFn = () => void | Promise<void>;
  interface Test {
    (name: string, fn: TestFn): void;
    skip(name: string, fn: TestFn): void;
  }
  const test: Test;
  export default test;
  export { test };
}
declare module "node:assert/strict" {
  export function ok(value: unknown, message?: string): asserts value;
  export function strictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function notStrictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function throws(fn: () => unknown, message?: string): void;
  const assert: {
    ok: typeof ok;
    strictEqual: typeof strictEqual;
    notStrictEqual: typeof notStrictEqual;
    deepStrictEqual: typeof deepStrictEqual;
    throws: typeof throws;
  };
  export default assert;
}
