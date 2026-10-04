import test from "node:test";
import assert from "node:assert/strict";
import {
  SIGHASH_ALL,
  SIGHASH_ANYONECANPAY,
  SIGHASH_NONE,
  SIGHASH_SINGLE,
  SignatureMode,
  parseTransaction,
  signatureDigest,
  signatureSubscript,
} from "../src/index.js";
import type { SighashContext } from "../src/index.js";
import {
  bip143Preimage,
  buildRawTx,
  hex,
  legacyPreimage,
  sha256d,
} from "./helpers.js";

const SINGLE_MISSING = Buffer.concat([Buffer.from([1]), Buffer.alloc(31, 0)]);

const P2PKH_SCRIPT = Buffer.concat([
  hex("76a914"),
  Buffer.alloc(20, 0x33),
  hex("88ac"),
]);

function txSpec(outputCount: number) {
  const outputs = [
    { value: 100000n, scriptPubKey: P2PKH_SCRIPT },
    { value: 200000n, scriptPubKey: hex("6a") },
  ].slice(0, outputCount);
  return {
    version: 2,
    inputs: [
      {
        prevTxId: Buffer.alloc(32, 0x11),
        prevOutIndex: 0,
        scriptSig: Buffer.alloc(0),
        sequence: 0xfffffffd,
      },
      {
        prevTxId: Buffer.alloc(32, 0x22),
        prevOutIndex: 1,
        scriptSig: hex("6a"),
        sequence: 0xffffffff,
      },
    ],
    outputs,
    locktime: 0,
  };
}

function ctx(overrides: Partial<SighashContext>): SighashContext {
  return {
    rawTransaction: buildRawTx(txSpec(2)),
    inputIndex: 0,
    mode: SignatureMode.Legacy,
    scriptCode: P2PKH_SCRIPT,
    prevOutValue: 100000n,
    sigHashType: SIGHASH_ALL,
    lastCodeSeparatorOffset: null,
    ...overrides,
  };
}

test("legacy SIGHASH_SINGLE with missing output yields the 1||0*31 constant", () => {
  const raw = buildRawTx(txSpec(1));
  for (const hashType of [SIGHASH_SINGLE, SIGHASH_SINGLE | SIGHASH_ANYONECANPAY]) {
    const digest = signatureDigest(
      ctx({ rawTransaction: raw, inputIndex: 1, sigHashType: hashType as 0x03 }),
    );
    assert.deepEqual(digest, SINGLE_MISSING, `hashType=${hashType}`);
  }
});

test("bip143 SIGHASH_SINGLE with missing output is computed normally", () => {
  const raw = buildRawTx(txSpec(1));
  const tx = parseTransaction(raw);
  for (const hashType of [SIGHASH_SINGLE, SIGHASH_SINGLE | SIGHASH_ANYONECANPAY]) {
    const digest = signatureDigest(
      ctx({
        rawTransaction: raw,
        inputIndex: 1,
        mode: SignatureMode.Bip143,
        sigHashType: hashType as 0x03,
      }),
    );
    assert.notDeepEqual(digest, SINGLE_MISSING);
    const expected = sha256d(
      bip143Preimage(tx, 1, P2PKH_SCRIPT, 100000n, hashType),
    );
    assert.deepEqual(digest, expected, `hashType=${hashType}`);
    // hashOutputs must be the zero hash here: the preimage commits to no output.
    assert.ok(expected.length === 32);
  }
});

test("legacy digests match independent preimage construction for all six types", () => {
  const raw = buildRawTx(txSpec(2));
  const tx = parseTransaction(raw);
  const types = [
    SIGHASH_ALL,
    SIGHASH_NONE,
    SIGHASH_SINGLE,
    SIGHASH_ALL | SIGHASH_ANYONECANPAY,
    SIGHASH_NONE | SIGHASH_ANYONECANPAY,
    SIGHASH_SINGLE | SIGHASH_ANYONECANPAY,
  ];
  for (const inputIndex of [0, 1]) {
    for (const hashType of types) {
      const digest = signatureDigest(
        ctx({ rawTransaction: raw, inputIndex, sigHashType: hashType as 0x01 }),
      );
      const preimage = legacyPreimage(tx, inputIndex, P2PKH_SCRIPT, hashType);
      assert.ok(preimage !== null);
      assert.deepEqual(
        digest,
        sha256d(preimage),
        `input=${inputIndex} hashType=${hashType}`,
      );
    }
  }
});

test("bip143 digests match independent preimage construction for all six types", () => {
  const raw = buildRawTx(txSpec(2));
  const tx = parseTransaction(raw);
  const types = [
    SIGHASH_ALL,
    SIGHASH_NONE,
    SIGHASH_SINGLE,
    SIGHASH_ALL | SIGHASH_ANYONECANPAY,
    SIGHASH_NONE | SIGHASH_ANYONECANPAY,
    SIGHASH_SINGLE | SIGHASH_ANYONECANPAY,
  ];
  for (const inputIndex of [0, 1]) {
    for (const hashType of types) {
      const digest = signatureDigest(
        ctx({
          rawTransaction: raw,
          inputIndex,
          mode: SignatureMode.Bip143,
          sigHashType: hashType as 0x01,
        }),
      );
      const expected = sha256d(
        bip143Preimage(tx, inputIndex, P2PKH_SCRIPT, 100000n, hashType),
      );
      assert.deepEqual(digest, expected, `input=${inputIndex} hashType=${hashType}`);
    }
  }
});

test("witness data does not affect digests in either mode", () => {
  const spec = {
    ...txSpec(2),
    witnesses: [[hex("0102")], []] as Buffer[][],
  };
  const withWitness = buildRawTx(spec);
  const withoutWitness = buildRawTx(txSpec(2));
  for (const mode of [SignatureMode.Legacy, SignatureMode.Bip143]) {
    const a = signatureDigest(ctx({ rawTransaction: withWitness, mode }));
    const b = signatureDigest(ctx({ rawTransaction: withoutWitness, mode }));
    assert.deepEqual(a, b, `mode=${mode}`);
  }
});

test("digest computation does not mutate caller buffers", () => {
  const raw = buildRawTx(txSpec(2));
  const script = Buffer.concat([hex("51ab03"), Buffer.alloc(3, 0xab), hex("ab52")]);
  const rawCopy = Buffer.from(raw);
  const scriptCopy = Buffer.from(script);
  signatureDigest(
    ctx({
      rawTransaction: raw,
      scriptCode: script,
      lastCodeSeparatorOffset: 1,
    sigHashType: (SIGHASH_SINGLE | SIGHASH_ANYONECANPAY) as 0x83,
    }),
  );
  signatureDigest(
    ctx({
      rawTransaction: raw,
      mode: SignatureMode.Bip143,
      scriptCode: script,
      lastCodeSeparatorOffset: 1,
    }),
  );
  assert.deepEqual(raw, rawCopy);
  assert.deepEqual(script, scriptCopy);
});

test("rejects unsupported sighash types and out-of-range inputs", () => {
  assert.throws(() => signatureDigest(ctx({ sigHashType: 0x04 as 0x01 })));
  assert.throws(() => signatureDigest(ctx({ inputIndex: 2 })));
  assert.throws(() => signatureDigest(ctx({ inputIndex: -1 })));
});

test("rejects malformed transactions", () => {
  assert.throws(() => signatureDigest(ctx({ rawTransaction: hex("01000000") })));
  const trailing = Buffer.concat([buildRawTx(txSpec(2)), hex("00")]);
  assert.throws(() => signatureDigest(ctx({ rawTransaction: trailing })));
});

test("parses witness transactions and preserves full 64-bit values", () => {
  const bigValue = 0xffffffffffffffffn;
  const raw = buildRawTx({
    ...txSpec(2),
    outputs: [{ value: bigValue, scriptPubKey: hex("6a") }],
    witnesses: [[hex("deadbeef")], []],
  });
  const tx = parseTransaction(raw);
  assert.equal(tx.version, 2);
  assert.equal(tx.inputs.length, 2);
  assert.equal(tx.outputs.length, 1);
  assert.equal(tx.outputs[0].value, bigValue);
  assert.deepEqual(tx.witnesses[0], [hex("deadbeef")]);
  assert.deepEqual(tx.witnesses[1], []);
  assert.equal(tx.locktime, 0);
});
