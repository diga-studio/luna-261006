// Minimal type shims so the project compiles with only the `typescript`
// package installed (no @types/node required).
declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
  export default test;
}
declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function fail(message?: string): never;
}
declare const process: {
  memoryUsage(): { rss: number; heapUsed: number; heapTotal: number };
};
declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
