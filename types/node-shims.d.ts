// Minimal declarations for the Node.js built-ins used by the tests, so the
// project compiles without downloading @types/node.
declare module "node:test" {
  type TestFn = (t: unknown) => void | Promise<void>;
  interface Test {
    (name: string, fn: TestFn): void;
  }
  const test: Test;
  export default test;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function throws(fn: () => void, message?: string): void;
  const assert: {
    equal: typeof equal;
    deepEqual: typeof deepEqual;
    ok: typeof ok;
    throws: typeof throws;
  };
  export default assert;
}

declare var process: {
  memoryUsage(): { rss: number; heapTotal: number; heapUsed: number; external: number };
  hrtime: { bigint(): bigint };
  env: Record<string, string | undefined>;
};

declare var console: {
  log(...args: unknown[]): void;
};
