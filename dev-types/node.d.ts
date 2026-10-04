// Minimal ambient Node.js typings for offline development.
// Covers only the APIs this project uses (node:crypto, node:test, node:assert, Buffer).

declare class Buffer {
  static from(data: string, encoding?: string): Buffer;
  static from(data: Uint8Array): Buffer;
  static concat(list: Buffer[]): Buffer;
  static alloc(size: number): Buffer;
  static byteLength(data: string, encoding?: string): number;
  readonly length: number;
  equals(other: Buffer): boolean;
  toString(encoding?: string): string;
  subarray(start?: number, end?: number): Buffer;
  [index: number]: number;
}

declare module "node:crypto" {
  class KeyObject {
    export(options?: { format?: string; type?: string }): string | Buffer;
    asymmetricKeyType?: string;
  }
  interface KeyPairResult {
    publicKey: KeyObject;
    privateKey: KeyObject;
  }
  function generateKeyPairSync(
    type: "rsa",
    options: { modulusLength: number }
  ): KeyPairResult;
  function createPublicKey(key: string | Buffer | KeyObject): KeyObject;
  function createHash(algorithm: string): {
    update(data: string | Buffer, encoding?: string): { update(d: string | Buffer, e?: string): unknown; digest(): Buffer };
    digest(): Buffer;
  };
  function createSign(algorithm: string): {
    update(data: string | Buffer, encoding?: string): { update(d: string | Buffer, e?: string): unknown; sign(k: KeyObject): Buffer };
    sign(key: KeyObject): Buffer;
  };
  function createVerify(algorithm: string): {
    update(data: string | Buffer, encoding?: string): { update(d: string | Buffer, e?: string): unknown; verify(k: KeyObject, s: Buffer): boolean };
    verify(key: KeyObject, signature: Buffer): boolean;
  };
  function timingSafeEqual(a: Buffer, b: Buffer): boolean;
  function randomBytes(size: number): Buffer;
}

declare module "node:test" {
  type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: TestFn): void;
}

declare module "node:assert" {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    strictEqual(actual: unknown, expected: unknown, message?: string): void;
    deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    throws(fn: () => void, expected?: unknown, message?: string): void;
    match(actual: string, regexp: RegExp, message?: string): void;
  }
  const assert: Assert & { strict: Assert };
  export = assert;
}
