import { createHash } from "node:crypto";
import { ByteWriter } from "./serialize.js";
import { signatureSubscript } from "./script.js";
import { parseTransaction, serializeTransactionLegacy } from "./transaction.js";
import {
  SIGHASH_ALL,
  SIGHASH_ANYONECANPAY,
  SIGHASH_NONE,
  SIGHASH_SINGLE,
  SignatureMode,
} from "./types.js";
import type { SighashContext, Transaction, TxInput, TxOutput } from "./types.js";

const ZERO_HASH = Buffer.alloc(32, 0);
/** Output value placeholder used by legacy SIGHASH_SINGLE blank outputs. */
const BLANK_OUTPUT_VALUE = 0xffffffffffffffffn;

function sha256d(data: Buffer): Buffer {
  const first = createHash("sha256").update(data).digest();
  return createHash("sha256").update(first).digest();
}

function checkContext(context: SighashContext, tx: Transaction): void {
  const valid = new Set([
    SIGHASH_ALL,
    SIGHASH_NONE,
    SIGHASH_SINGLE,
    SIGHASH_ALL | SIGHASH_ANYONECANPAY,
    SIGHASH_NONE | SIGHASH_ANYONECANPAY,
    SIGHASH_SINGLE | SIGHASH_ANYONECANPAY,
  ]);
  if (!valid.has(context.sigHashType)) {
    throw new Error(`unsupported sighash type: ${context.sigHashType}`);
  }
  if (
    !Number.isInteger(context.inputIndex) ||
    context.inputIndex < 0 ||
    context.inputIndex >= tx.inputs.length
  ) {
    throw new RangeError(`input index out of range: ${context.inputIndex}`);
  }
}

function legacyDigest(context: SighashContext, tx: Transaction): Buffer {
  const baseType = context.sigHashType & 0x1f;
  const anyoneCanPay = (context.sigHashType & SIGHASH_ANYONECANPAY) !== 0;

  if (baseType === SIGHASH_SINGLE && context.inputIndex >= tx.outputs.length) {
    // Legacy SIGHASH_SINGLE bug, preserved for consensus compatibility.
    return Buffer.concat([Buffer.from([1]), Buffer.alloc(31, 0)]);
  }

  const subscript = signatureSubscript(
    context.scriptCode,
    context.lastCodeSeparatorOffset,
    true,
  );

  let inputs: TxInput[] = tx.inputs.map((input, index) => ({
    prevTxId: input.prevTxId,
    prevOutIndex: input.prevOutIndex,
    scriptSig: index === context.inputIndex ? subscript : Buffer.alloc(0),
    sequence: input.sequence,
  }));

  let outputs: TxOutput[];
  if (baseType === SIGHASH_NONE) {
    outputs = [];
    inputs = inputs.map((input, index) =>
      index === context.inputIndex ? input : { ...input, sequence: 0 },
    );
  } else if (baseType === SIGHASH_SINGLE) {
    outputs = [];
    for (let i = 0; i <= context.inputIndex; i++) {
      outputs.push(
        i === context.inputIndex
          ? tx.outputs[i]
          : { value: BLANK_OUTPUT_VALUE, scriptPubKey: Buffer.alloc(0) },
      );
    }
    inputs = inputs.map((input, index) =>
      index === context.inputIndex ? input : { ...input, sequence: 0 },
    );
  } else {
    outputs = tx.outputs;
  }

  if (anyoneCanPay) {
    inputs = [inputs[context.inputIndex]];
  }

  const modified: Transaction = {
    version: tx.version,
    inputs,
    outputs,
    witnesses: [],
    locktime: tx.locktime,
  };

  const writer = new ByteWriter();
  writer.writeBytes(serializeTransactionLegacy(modified));
  writer.writeUInt32LE(context.sigHashType);
  return sha256d(writer.toBuffer());
}

function bip143Digest(context: SighashContext, tx: Transaction): Buffer {
  const baseType = context.sigHashType & 0x1f;
  const anyoneCanPay = (context.sigHashType & SIGHASH_ANYONECANPAY) !== 0;

  let hashPrevouts: Buffer = ZERO_HASH;
  if (!anyoneCanPay) {
    const writer = new ByteWriter();
    for (const input of tx.inputs) {
      writer.writeBytes(input.prevTxId);
      writer.writeUInt32LE(input.prevOutIndex);
    }
    hashPrevouts = sha256d(writer.toBuffer());
  }

  let hashSequence: Buffer = ZERO_HASH;
  if (!anyoneCanPay && baseType !== SIGHASH_SINGLE && baseType !== SIGHASH_NONE) {
    const writer = new ByteWriter();
    for (const input of tx.inputs) {
      writer.writeUInt32LE(input.sequence);
    }
    hashSequence = sha256d(writer.toBuffer());
  }

  let hashOutputs: Buffer = ZERO_HASH;
  if (baseType === SIGHASH_ALL) {
    const writer = new ByteWriter();
    for (const output of tx.outputs) {
      writer.writeUInt64LE(output.value);
      writer.writeVarBytes(output.scriptPubKey);
    }
    hashOutputs = sha256d(writer.toBuffer());
  } else if (baseType === SIGHASH_SINGLE && context.inputIndex < tx.outputs.length) {
    const output = tx.outputs[context.inputIndex];
    const writer = new ByteWriter();
    writer.writeUInt64LE(output.value);
    writer.writeVarBytes(output.scriptPubKey);
    hashOutputs = sha256d(writer.toBuffer());
  }

  const subscript = signatureSubscript(
    context.scriptCode,
    context.lastCodeSeparatorOffset,
    false,
  );
  const current = tx.inputs[context.inputIndex];

  const preimage = new ByteWriter();
  preimage.writeInt32LE(tx.version);
  preimage.writeBytes(hashPrevouts);
  preimage.writeBytes(hashSequence);
  preimage.writeBytes(current.prevTxId);
  preimage.writeUInt32LE(current.prevOutIndex);
  preimage.writeVarBytes(subscript);
  preimage.writeUInt64LE(context.prevOutValue);
  preimage.writeUInt32LE(current.sequence);
  preimage.writeBytes(hashOutputs);
  preimage.writeUInt32LE(tx.locktime);
  preimage.writeUInt32LE(context.sigHashType);
  return sha256d(preimage.toBuffer());
}

/**
 * Compute the 32-byte pre-signature digest for one input.
 * Does not mutate the caller's transaction or script buffers.
 */
export function signatureDigest(context: SighashContext): Buffer {
  const tx = parseTransaction(context.rawTransaction);
  checkContext(context, tx);
  if (context.mode === SignatureMode.Legacy) {
    return legacyDigest(context, tx);
  }
  return bip143Digest(context, tx);
}
