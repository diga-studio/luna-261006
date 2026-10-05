// Minimal ambient declarations so the project compiles without @types/node.
declare class TextDecoder {
  decode(input: Uint8Array): string;
}
declare class TextEncoder {
  encode(input: string): Uint8Array;
}

declare module 'node:test' {
  export interface TestContext {
    name: string;
  }
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
  const testExport: typeof test & {
    describe: typeof describe;
    it: typeof it;
    test: typeof test;
  };
  export default testExport;
}

declare module 'node:assert/strict' {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function match(actual: string, regexp: RegExp, message?: string): void;
  export function doesNotMatch(actual: string, regexp: RegExp, message?: string): void;
  export function throws(fn: () => unknown, message?: string): void;
  export function fail(message?: string): never;
  const assert: {
    equal: typeof equal;
    deepEqual: typeof deepEqual;
    notEqual: typeof notEqual;
    ok: typeof ok;
    match: typeof match;
    doesNotMatch: typeof doesNotMatch;
    throws: typeof throws;
    fail: typeof fail;
  };
  export default assert;
}
