// Minimal ambient declarations so the project builds with only the
// `typescript` package installed (no @types/node required).

declare function setTimeout(callback: () => void, ms: number): unknown;
declare function clearTimeout(handle: unknown): void;
declare function setImmediate(callback: () => void): unknown;

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  export function ok(value: unknown, message?: string): asserts value;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function fail(message?: string): never;
  export function rejects(
    promise: Promise<unknown>,
    predicate?: (err: unknown) => boolean,
  ): Promise<void>;
}
