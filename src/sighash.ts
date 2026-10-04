import { createHash } from "crypto";
import { encodeCompactSize } from "./compactSize";
import { signatureSubscript } from "./script";
import { parseTransaction } from "./transaction";
import {
  DigestRequest,
  HashTypeBase,
  SIGHASH_ANYONECANPAY,
  Transaction,
  TxInput,
  TxOutput,
} from "./types";

function sha256d(data: Uint8Array): Uint8Array {
  const first = createHash("sha256").update(data).digest();
  return createHash("sha256").update(first).digest();
}

function uint32LE(value: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = value & 0xff;
  out[1] = (value >>> 8) & 0xff;
  out[2] = (value >>> 16) & 0xff;
  out[3] = (value >>> 24) & 0xff;
  return out;
}

function int32LE(value: number): Uint8Array {
  return uint32LE(value >>> 0);
}

function uint64LE(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    out[i] = Number((value >> BigInt(8 * i)) & 0xffn);
  }
  return out;
}

function varBytes(data: Uint8Array): Uint8Array {
  return concat([encodeCompactSize(data.length), data]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function serializeOutpoint(input: TxInput): Uint8Array {
  return concat([input.prevTxHash, uint32LE(input.prevOutIndex)]);
}

function serializeOutput(output: TxOutput): Uint8Array {
  return concat([uint64LE(output.value), varBytes(output.scriptPubKey)]);
}

const ZERO_HASH = new Uint8Array(32);

/** The legacy "SIGHASH_SINGLE bug" digest: uint256 value 1. */
const LEGACY_SINGLE_MISSING_OUTPUT = (() => {
  const out = new Uint8Array(32);
  out[0] = 1;
  return out;
})();

function validateHashType(hashType: number): void {
  const base = hashType & 0x1f;
  const rest = hashType & ~0x1f;
  const validBase =
    base === HashTypeBase.ALL ||
    base === HashTypeBase.NONE ||
    base === HashTypeBase.SINGLE;
  if (!validBase || (rest !== 0 && rest !== SIGHASH_ANYONECANPAY)) {
    throw new Error(`unsupported sighash type: 0x${hashType.toString(16)}`);
  }
}

function legacyDigest(
  tx: Transaction,
  inputIndex: number,
  subscript: Uint8Array,
  hashType: number
): Uint8Array {
  const base = hashType & 0x1f;
  const anyoneCanPay = (hashType & SIGHASH_ANYONECANPAY) !== 0;

  if (base === HashTypeBase.SINGLE && inputIndex >= tx.outputs.length) {
    return LEGACY_SINGLE_MISSING_OUTPUT.slice();
  }

  // Blank every scriptSig; the signed input gets the committed subscript.
  let inputs: TxInput[] = tx.inputs.map((input) => ({
    prevTxHash: input.prevTxHash,
    prevOutIndex: input.prevOutIndex,
    scriptSig: new Uint8Array(0),
    sequence: input.sequence,
  }));
  inputs[inputIndex] = { ...inputs[inputIndex]!, scriptSig: subscript };

  let outputs: TxOutput[] = tx.outputs.map((output) => ({
    value: output.value,
    scriptPubKey: output.scriptPubKey,
  }));

  if (base === HashTypeBase.NONE) {
    outputs = [];
    inputs = inputs.map((input, i) =>
      i === inputIndex ? input : { ...input, sequence: 0 }
    );
  } else if (base === HashTypeBase.SINGLE) {
    // Commit only to the output at the ORIGINAL input index; earlier
    // slots are null outputs (value -1, empty script).
    const resized: TxOutput[] = [];
    for (let i = 0; i <= inputIndex; i++) {
      resized.push(
        i < tx.outputs.length && i === inputIndex
          ? outputs[i]!
          : { value: 0xffffffffffffffffn, scriptPubKey: new Uint8Array(0) }
      );
    }
    outputs = resized;
    inputs = inputs.map((input, i) =>
      i === inputIndex ? input : { ...input, sequence: 0 }
    );
  }

  if (anyoneCanPay) {
    inputs = [inputs[inputIndex]!];
  }

  const parts: Uint8Array[] = [int32LE(tx.version)];
  parts.push(encodeCompactSize(inputs.length));
  for (const input of inputs) {
    parts.push(serializeOutpoint(input));
    parts.push(varBytes(input.scriptSig));
    parts.push(uint32LE(input.sequence));
  }
  parts.push(encodeCompactSize(outputs.length));
  for (const output of outputs) {
    parts.push(serializeOutput(output));
  }
  parts.push(uint32LE(tx.locktime));
  parts.push(uint32LE(hashType));

  return sha256d(concat(parts));
}

function bip143Digest(
  tx: Transaction,
  inputIndex: number,
  subscript: Uint8Array,
  prevOutValue: bigint,
  hashType: number
): Uint8Array {
  const base = hashType & 0x1f;
  const anyoneCanPay = (hashType & SIGHASH_ANYONECANPAY) !== 0;

  let hashPrevouts = ZERO_HASH;
  if (!anyoneCanPay) {
    hashPrevouts = sha256d(
      concat(tx.inputs.map((input) => serializeOutpoint(input)))
    );
  }

  let hashSequence = ZERO_HASH;
  if (
    !anyoneCanPay &&
    base !== HashTypeBase.SINGLE &&
    base !== HashTypeBase.NONE
  ) {
    hashSequence = sha256d(
      concat(tx.inputs.map((input) => uint32LE(input.sequence)))
    );
  }

  let hashOutputs = ZERO_HASH;
  if (base === HashTypeBase.ALL) {
    hashOutputs = sha256d(
      concat(tx.outputs.map((output) => serializeOutput(output)))
    );
  } else if (
    base === HashTypeBase.SINGLE &&
    inputIndex < tx.outputs.length
  ) {
    hashOutputs = sha256d(serializeOutput(tx.outputs[inputIndex]!));
  }

  const input = tx.inputs[inputIndex]!;
  const preimage = concat([
    int32LE(tx.version),
    hashPrevouts,
    hashSequence,
    serializeOutpoint(input),
    varBytes(subscript),
    uint64LE(prevOutValue),
    uint32LE(input.sequence),
    hashOutputs,
    uint32LE(tx.locktime),
    uint32LE(hashType),
  ]);
  return sha256d(preimage);
}

/**
 * Compute the 32-byte double-SHA256 digest a signature commits to,
 * for one input of a transaction, in legacy or BIP143 mode.
 *
 * The caller's transaction bytes and script are never mutated.
 */
export function computeSignatureDigest(request: DigestRequest): Uint8Array {
  const {
    serializedTx,
    inputIndex,
    mode,
    scriptCode,
    prevOutValue,
    hashType,
    lastCodeSeparatorOffset,
  } = request;

  validateHashType(hashType);
  if (
    mode === "bip143" &&
    (prevOutValue < 0n || prevOutValue > 0xffffffffffffffffn)
  ) {
    throw new Error("prevOutValue out of uint64 range");
  }
  const tx = parseTransaction(serializedTx);
  if (inputIndex < 0 || inputIndex >= tx.inputs.length) {
    throw new Error(`input index ${inputIndex} out of range`);
  }

  const subscript = signatureSubscript(
    scriptCode,
    lastCodeSeparatorOffset,
    mode
  );

  if (mode === "legacy") {
    return legacyDigest(tx, inputIndex, subscript, hashType);
  }
  return bip143Digest(tx, inputIndex, subscript, prevOutValue, hashType);
}
