// 最小化的 Node 内置模块类型声明，避免测试依赖 @types/node。
declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function throws(
    fn: () => void,
    expected?: string | (new (...args: never[]) => Error),
  ): void;
}

declare const process: {
  memoryUsage(): { rss: number };
};
