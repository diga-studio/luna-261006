// 最小化的 Node 内置模块声明，避免依赖 @types/node（保持 npm install 零网络风险）。
declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function throws(fn: () => void, expected?: RegExp | (new (...args: never[]) => Error), message?: string): void;
}

declare const console: {
  log(...args: unknown[]): void;
};
