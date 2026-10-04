// 本工程不依赖 @types/node：测试只用到 node:test 与 node:assert 的极小子集，
// 在此自行声明，保证干净机器上 npm install（仅 typescript）后即可编译运行。
declare module 'node:test' {
  type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
}

declare module 'node:assert/strict' {
  const assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    rejects(fn: () => Promise<unknown>, message?: string): Promise<void>;
  };
  export default assert;
}
