// 本工程只用到 Node 内置测试运行器与断言的极小子集。
// 为避免依赖 @types/node，这里手工声明所需模块接口。
declare module 'node:test' {
  export interface TestContext {
    name: string;
  }
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
  export default test;
}

declare module 'node:assert/strict' {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function fail(message?: string): never;
}
