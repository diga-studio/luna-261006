declare module "node:test" {
  export function test(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  export function deepEqual(actual: unknown, expected: unknown): void;
  export function strictEqual(actual: unknown, expected: unknown): void;
  export function ok(value: unknown): void;
}
