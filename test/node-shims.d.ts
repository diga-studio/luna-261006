// 本工程不依赖 @types/node，这里只声明测试用到的最小 Node API。
declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  export function deepEqual(actual: unknown, expected: unknown): void;
  export function equal(actual: unknown, expected: unknown): void;
  export function ok(value: unknown): void;
}
