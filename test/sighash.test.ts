import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeSignatureDigest,
  parseTransaction,
  signatureSubscript,
  encodeCompactSize,
  decodeCompactSize,
  DigestRequest,
  HashType,
} from "../src/index";
import { TX_HEX, CODESEP_SCRIPT_HEX, PLAIN_SCRIPT_HEX, VECTORS } from "./vectors";

function hex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

const LEGACY_SINGLE_MISSING =
  "01" + "00".repeat(31);

test("reference vectors (legacy + bip143)", () => {
  for (const v of VECTORS) {
    const digest = computeSignatureDigest({
      serializedTx: hex(TX_HEX[v.tx]),
      inputIndex: v.inputIndex,
      mode: v.mode,
      scriptCode: hex(v.script),
      prevOutValue: v.prevOutValue,
      hashType: v.hashType as HashType,
      lastCodeSeparatorOffset: v.lastCodeSeparatorOffset,
    });
    assert.equal(toHex(digest), v.expected, v.name);
  }
});

test("legacy SINGLE with missing output yields uint256 1", () => {
  for (const hashType of [0x03, 0x83] as HashType[]) {
    const digest = computeSignatureDigest({
      serializedTx: hex(TX_HEX.TX_C),
      inputIndex: 1,
      mode: "legacy",
      scriptCode: hex(PLAIN_SCRIPT_HEX),
      prevOutValue: 0n,
      hashType,
      lastCodeSeparatorOffset: null,
    });
    assert.equal(toHex(digest), LEGACY_SINGLE_MISSING);
  }
});

test("bip143 SINGLE with missing output still hashes normally", () => {
  for (const v of VECTORS) {
    if (!v.name.startsWith("bip143Single") || !v.name.includes("Missing")) {
      continue;
    }
    const digest = computeSignatureDigest({
      serializedTx: hex(TX_HEX[v.tx]),
      inputIndex: v.inputIndex,
      mode: v.mode,
      scriptCode: hex(v.script),
      prevOutValue: v.prevOutValue,
      hashType: v.hashType as HashType,
      lastCodeSeparatorOffset: v.lastCodeSeparatorOffset,
    });
    assert.notEqual(toHex(digest), LEGACY_SINGLE_MISSING, v.name);
    assert.equal(toHex(digest), v.expected, v.name);
  }
});

test("witness data and existing scriptSig do not affect the digest", () => {
  const base: Omit<DigestRequest, "serializedTx"> = {
    inputIndex: 0,
    mode: "bip143",
    scriptCode: hex(PLAIN_SCRIPT_HEX),
    prevOutValue: 0xffffffffffffffffn,
    hashType: 0x01,
    lastCodeSeparatorOffset: null,
  };
  const withWitness = computeSignatureDigest({
    ...base,
    serializedTx: hex(TX_HEX.TX_W),
  });
  const stripped = computeSignatureDigest({
    ...base,
    serializedTx: hex(TX_HEX.TX_W_STRIPPED),
  });
  assert.equal(toHex(withWitness), toHex(stripped));
});

test("signatureSubscript: separators, pushdata 0xab, offsets", () => {
  const script = hex(CODESEP_SCRIPT_HEX); // ab 02 ab ab 51 ab 52

  // legacy from offset 0: start after first separator, strip later ones,
  // keep the pushed 0xab 0xab data bytes.
  assert.equal(
    toHex(signatureSubscript(script, 0, "legacy")),
    "02abab5152"
  );
  // bip143 from offset 0: keep the later separator opcode.
  assert.equal(
    toHex(signatureSubscript(script, 0, "bip143")),
    "02abab51ab52"
  );
  // execution already passed the separator at offset 5.
  assert.equal(toHex(signatureSubscript(script, 5, "legacy")), "52");
  assert.equal(toHex(signatureSubscript(script, 5, "bip143")), "52");
  // no separator executed: legacy strips all, bip143 keeps everything.
  assert.equal(
    toHex(signatureSubscript(script, null, "legacy")),
    "02abab5152"
  );
  assert.equal(
    toHex(signatureSubscript(script, null, "bip143")),
    CODESEP_SCRIPT_HEX
  );
  // offset must point at a real OP_CODESEPARATOR opcode, not pushdata.
  assert.throws(() => signatureSubscript(script, 2, "legacy"));
  assert.throws(() => signatureSubscript(script, 3, "bip143"));
  assert.throws(() => signatureSubscript(script, 99, "legacy"));
});

test("does not mutate caller transaction bytes or script", () => {
  const txBytes = hex(TX_HEX.TX_W);
  const script = hex(CODESEP_SCRIPT_HEX);
  const txSnapshot = toHex(txBytes);
  const scriptSnapshot = toHex(script);
  computeSignatureDigest({
    serializedTx: txBytes,
    inputIndex: 0,
    mode: "legacy",
    scriptCode: script,
    prevOutValue: 1n,
    hashType: 0x01,
    lastCodeSeparatorOffset: 0,
  });
  assert.equal(toHex(txBytes), txSnapshot);
  assert.equal(toHex(script), scriptSnapshot);
});

test("rejects invalid inputs", () => {
  const base: DigestRequest = {
    serializedTx: hex(TX_HEX.TX_A),
    inputIndex: 0,
    mode: "legacy",
    scriptCode: hex(PLAIN_SCRIPT_HEX),
    prevOutValue: 0n,
    hashType: 0x01,
    lastCodeSeparatorOffset: null,
  };
  assert.throws(() =>
    computeSignatureDigest({ ...base, hashType: 0x04 as HashType })
  );
  assert.throws(() =>
    computeSignatureDigest({ ...base, hashType: 0x40 as HashType })
  );
  assert.throws(() => computeSignatureDigest({ ...base, inputIndex: 2 }));
  assert.throws(() =>
    computeSignatureDigest({ ...base, serializedTx: hex("01000000") })
  );
});

test("parseTransaction round-trips witness data", () => {
  const tx = parseTransaction(hex(TX_HEX.TX_W));
  assert.equal(tx.hasWitness, true);
  assert.equal(tx.inputs.length, 1);
  assert.deepEqual(
    tx.witnesses[0]!.map(toHex),
    ["deadbeef", "0102"]
  );
  assert.equal(tx.outputs[0]!.value, 123456789n);
  assert.equal(tx.locktime, 500000);
});

test("compactSize encode/decode round-trip", () => {
  const cases: Array<[bigint, string]> = [
    [0n, "00"],
    [252n, "fc"],
    [253n, "fdfd00"],
    [65535n, "fdffff"],
    [65536n, "fe00000100"],
    [0xffffffffn, "feffffffff"],
    [0x100000000n, "ff0000000001000000"],
    [0xffffffffffffffffn, "ffffffffffffffffff"],
  ];
  for (const [value, expectedHex] of cases) {
    const encoded = encodeCompactSize(value);
    assert.equal(toHex(encoded), expectedHex);
    const decoded = decodeCompactSize(encoded, 0);
    assert.equal(decoded.value, value);
    assert.equal(decoded.size, encoded.length);
  }
  assert.throws(() => decodeCompactSize(new Uint8Array(0), 0));
  assert.throws(() => decodeCompactSize(hex("fd01"), 0));
});
