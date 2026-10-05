declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}
declare module 'node:assert' {
  export function strictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function throws(fn: () => void, pattern?: RegExp | ((err: unknown) => boolean)): void;
}
declare module 'node:fs' {
  export function unlinkSync(path: string): void;
  export function existsSync(path: string): boolean;
  export function statSync(path: string): { size: number };
  export function rmSync(path: string, opts?: { force?: boolean; recursive?: boolean }): void;
  export function writeFileSync(path: string, data: string): void;
  export function readFileSync(path: string, encoding: string): string;
}
declare module 'node:child_process' {
  export function spawnSync(
    cmd: string,
    args: string[],
    opts?: { encoding?: string; maxBuffer?: number }
  ): { status: number | null; stdout: string; stderr: string; error?: Error };
}
