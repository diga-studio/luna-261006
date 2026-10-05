// Minimal ambient declarations for the Node.js built-ins used by the tests,
// so the project builds with only the `typescript` devDependency installed.
declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function test(
    name: string,
    options: { timeout?: number },
    fn: () => void | Promise<void>,
  ): void;
}

declare module "node:assert/strict" {
  interface Assert {
    (value: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    throws(fn: () => void, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}

declare const process: {
  readonly platform: string;
  resourceUsage(): { maxRSS: number };
  memoryUsage(): { rss: number; heapUsed: number };
};

declare const console: {
  log(...args: unknown[]): void;
};
