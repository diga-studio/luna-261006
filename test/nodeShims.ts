// Minimal local shims so the project compiles without @types/node.
// On a fully provisioned machine `npm install` pulls @types/node, but the
// tests only rely on these two tiny surfaces.
declare function require(name: string): any;

interface TestFn {
  (name: string, fn: () => void): void;
}

interface Assert {
  equal(actual: unknown, expected: unknown, message?: string): void;
  deepEqual(actual: unknown, expected: unknown, message?: string): void;
  ok(value: unknown, message?: string): void;
  throws(fn: () => void, validator?: unknown, message?: string): void;
}

export const test: TestFn = require('node:test').test;
export const assert: Assert = require('node:assert/strict');
