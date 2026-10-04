import test from "node:test";
import assert from "node:assert/strict";
import {
  SIGHASH_ALL,
  SignatureMode,
  parseTransaction,
  signatureDigest,
  signatureSubscript,
} from "../src/index.js";
import type { SighashContext } from "../src/index.js";
import { bip143Preimage, buildRawTx, hex, legacyPreimage, sha256d } from "./helpers.js";

// OP_1 OP_CODESEPARATOR PUSH3[ab ab ab] OP_CODESEPARATOR OP_2
// The pushed payload contains bytes equal to OP_CODESEPARATOR (0xab);
// they are data, not opcodes, and must always be preserved.
const SCRIPT = Buffer.concat([
  hex("51"), // offset 0: OP_1
  hex("ab"), // offset 1: OP_CODESEPARATOR (last executed in tests below)
  hex("03"), // offset 2: push 3 bytes
  Buffer.alloc(3, 0xab), // offsets 3-5: payload 0xab 0xab 0xab
  hex("ab"), // offset 6: OP_CODESEPARATOR (not yet executed)
  hex("52"), // offset 7: OP_2
]);

test("subscript starts after the last executed separator", () => {
  // Legacy: remaining OP_CODESEPARATOR opcodes are removed, payload kept.
  assert.deepEqual(
    signatureSubscript(SCRIPT, 1, true),
    Buffer.concat([hex("03"), Buffer.alloc(3, 0xab), hex("52")]),
  );
  // BIP143: the remaining separator opcode is preserved.
  assert.deepEqual(
    signatureSubscript(SCRIPT, 1, false),
    Buffer.concat([hex("03"), Buffer.alloc(3, 0xab), hex("ab"), hex("52")]),
  );
});

test("subscript without any executed separator covers the whole script", () => {
  assert.deepEqual(
    signatureSubscript(SCRIPT, null, true),
    Buffer.concat([hex("51"), hex("03"), Buffer.alloc(3, 0xab), hex("52")]),
  );
  assert.deepEqual(
    signatureSubscript(SCRIPT, null, false),
    SCRIPT,
  );
});

test("separator as the last executed opcode yields an empty tail script", () => {
  assert.deepEqual(signatureSubscript(SCRIPT, 6, true), hex("52"));
  assert.deepEqual(signatureSubscript(SCRIPT, 6, false), hex("52"));
});

test("payload bytes equal to 0xab are never treated as opcodes", () => {
  // Script consisting only of a push of 0xab bytes: nothing is stripped.
  const pushOnly = Buffer.concat([hex("03"), Buffer.alloc(3, 0xab)]);
  assert.deepEqual(signatureSubscript(pushOnly, null, true), pushOnly);
});

test("invalid separator offset is rejected", () => {
  assert.throws(() => signatureSubscript(SCRIPT, 0, true)); // points at OP_1
  assert.throws(() => signatureSubscript(SCRIPT, 3, true)); // points at payload
  assert.throws(() => signatureSubscript(SCRIPT, 99, true));
});

function ctxFor(script: Buffer, offset: number | null, mode: SignatureMode): SighashContext {
  const raw = buildRawTx({
    version: 2,
    inputs: [
      {
        prevTxId: Buffer.alloc(32, 0x11),
        prevOutIndex: 0,
        sequence: 0xfffffffd,
      },
    ],
    outputs: [{ value: 50000n, scriptPubKey: hex("6a") }],
    locktime: 0,
  });
  return {
    rawTransaction: raw,
    inputIndex: 0,
    mode,
    scriptCode: script,
    prevOutValue: 50000n,
    sigHashType: SIGHASH_ALL,
    lastCodeSeparatorOffset: offset,
  };
}

test("legacy digest commits to the stripped subscript only", () => {
  const tx = parseTransaction(ctxFor(SCRIPT, 1, SignatureMode.Legacy).rawTransaction);
  const digest = signatureDigest(ctxFor(SCRIPT, 1, SignatureMode.Legacy));
  const stripped = Buffer.concat([hex("03"), Buffer.alloc(3, 0xab), hex("52")]);
  const expected = sha256d(legacyPreimage(tx, 0, stripped, SIGHASH_ALL)!);
  assert.deepEqual(digest, expected);
  // Same commitment as signing the tail script directly with no separator.
  const tailOnly = Buffer.concat([hex("03"), Buffer.alloc(3, 0xab), hex("52")]);
  const equivalent = signatureDigest(ctxFor(tailOnly, null, SignatureMode.Legacy));
  assert.deepEqual(digest, equivalent);
  // Committing to the whole script (no separator executed) differs.
  const whole = signatureDigest(ctxFor(SCRIPT, null, SignatureMode.Legacy));
  assert.notDeepEqual(digest, whole);
});

test("bip143 digest keeps the remaining separator opcode", () => {
  const tx = parseTransaction(ctxFor(SCRIPT, 1, SignatureMode.Bip143).rawTransaction);
  const digest = signatureDigest(ctxFor(SCRIPT, 1, SignatureMode.Bip143));
  const kept = Buffer.concat([hex("03"), Buffer.alloc(3, 0xab), hex("ab"), hex("52")]);
  const expected = sha256d(bip143Preimage(tx, 0, kept, 50000n, SIGHASH_ALL));
  assert.deepEqual(digest, expected);
  // Differs from the legacy commitment for the same script and offset.
  const legacy = signatureDigest(ctxFor(SCRIPT, 1, SignatureMode.Legacy));
  assert.notDeepEqual(digest, legacy);
});
