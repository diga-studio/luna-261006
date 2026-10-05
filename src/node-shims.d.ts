// 最小 Node 内置模块声明，使编译无需 @types/node（npm install 只需 typescript）。
declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
}

declare function setImmediate(callback: () => void): void;
