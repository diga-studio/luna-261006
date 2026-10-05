// 最小化的 Node 内置模块类型声明，使工程无需 @types/node 即可编译。
// 仅覆盖本工程用到的 API。

declare module "node:crypto" {
  export interface Hasher {
    update(data: string | Uint8Array, encoding?: string): Hasher;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: string): Hasher;
  export function createHmac(algorithm: string, key: string | Uint8Array): Hasher;
  export function randomBytes(size: number): Uint8Array & { toString(encoding: "hex"): string };
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}

declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): {
      run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
      get(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
    };
    close(): void;
  }
}

declare module "node:test" {
  export default function test(name: string, fn: () => void | Promise<void>): void;
  export function before(fn: () => void): void;
  export function after(fn: () => void): void;
}

declare module "node:assert/strict" {
  export function ok(value: unknown, message?: string): void;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function throws(fn: () => void, message?: string): void;
  const assert: {
    ok: typeof ok;
    equal: typeof equal;
    notEqual: typeof notEqual;
    deepEqual: typeof deepEqual;
    throws: typeof throws;
  };
  export default assert;
}

declare module "node:fs" {
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function existsSync(path: string): boolean;
  export function copyFileSync(src: string, dest: string): void;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
}
