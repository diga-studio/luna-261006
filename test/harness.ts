/** 零依赖的极简测试框架，避免引入 @types/node 之外的测试工具。 */

declare const process: {
  stdout: { write(text: string): void };
  exitCode: number | undefined;
};

interface TestCase {
  readonly name: string;
  readonly fn: () => void;
}

const cases: TestCase[] = [];

export function test(name: string, fn: () => void): void {
  cases.push({ name, fn });
}

export function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(
      (message ? message + ": " : "") +
        "expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual)
    );
  }
}

export function assertTrue(value: boolean, message?: string): void {
  if (!value) {
    throw new Error(message ?? "expected condition to be true");
  }
}

export function assertFalse(value: boolean, message?: string): void {
  if (value) {
    throw new Error(message ?? "expected condition to be false");
  }
}

export function runTests(): void {
  let failed = 0;
  for (const c of cases) {
    try {
      c.fn();
      process.stdout.write("PASS " + c.name + "\n");
    } catch (err) {
      failed += 1;
      const detail = err instanceof Error ? err.message : String(err);
      process.stdout.write("FAIL " + c.name + "\n  " + detail + "\n");
    }
  }
  process.stdout.write(
    "\n" + String(cases.length - failed) + "/" + String(cases.length) + " passed\n"
  );
  if (failed > 0) {
    process.exitCode = 1;
  }
}
