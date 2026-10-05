// 最小化的 Node 内置类型声明，使测试在仅有 typescript 依赖时即可编译。
declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  export function ok(value: unknown, message?: string): asserts value;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function throws(fn: () => unknown, message?: string): void;
}

declare const process: {
  memoryUsage(): { rss: number };
};

declare const global: {
  gc?: () => void;
};
