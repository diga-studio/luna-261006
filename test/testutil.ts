/** Tiny wrapper so tests compile without @types/node declarations for node:test. */

interface TestFn {
  (name: string, fn: () => void | Promise<void>): void;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
export const test: TestFn = require("node:test").test;
