// 干净机器上只有 Node.js，不安装 @types/node；
// 这里为测试用到的 node 内置模块提供最小类型声明。
declare module 'node:test' {
  export function test(name: string, fn: () => void): void;
}

declare module 'node:assert/strict' {
  export function deepStrictEqual(actual: unknown, expected: unknown): void;
  export function strictEqual(actual: unknown, expected: unknown): void;
  export function ok(value: unknown): void;
  export function throws(fn: () => void): void;
}
