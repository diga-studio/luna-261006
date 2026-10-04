import { createHash } from "node:crypto";
import type { Transaction } from "../src/index.js";

export function sha256d(data: Buffer): Buffer {
  const first = createHash("sha256").update(data).digest();
  return createHash("sha256").update(first).digest();
}

export function hex(bytes: string): Buffer {
  return Buffer.from(bytes, "hex");
}

/** Independent CompactSize encoder for test-side serialization. */
export function compactSize(value: number): Buffer {
  if (value < 0xfd) return Buffer.from([value]);
  if (value <= 0xffff) {
    const b = Buffer.alloc(3);
    b[0] = 0xfd;
    b.writeUInt16LE(value, 1);
    return b;
  }
  if (value <= 0xffffffff) {
    const b = Buffer.alloc(5);
    b[0] = 0xfe;
    b.writeUInt32LE(value, 1);
    return b;
  }
  const b = Buffer.alloc(9);
  b[0] = 0xff;
  b.writeBigUInt64LE(BigInt(value), 1);
  return b;
}

export function varBytes(data: Buffer): Buffer {
  return Buffer.concat([compactSize(data.length), data]);
}

export function u32le(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value >>> 0);
  return b;
}

export function i32le(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32LE(value);
  return b;
}

export function u64le(value: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(value);
  return b;
}

export interface TestTxSpec {
  version: number;
  inputs: Array<{
    prevTxId: Buffer;
    prevOutIndex: number;
    scriptSig?: Buffer;
    sequence: number;
  }>;
  outputs: Array<{ value: bigint; scriptPubKey: Buffer }>;
  witnesses?: Buffer[][];
  locktime: number;
}

/** Independent transaction serializer used only by tests. */
export function buildRawTx(spec: TestTxSpec): Buffer {
  const parts: Buffer[] = [];
  parts.push(i32le(spec.version));
  const withWitness =
    spec.witnesses !== undefined && spec.witnesses.some((w) => w.length > 0);
  if (withWitness) parts.push(Buffer.from([0x00, 0x01]));
  parts.push(compactSize(spec.inputs.length));
  for (const input of spec.inputs) {
    parts.push(input.prevTxId);
    parts.push(u32le(input.prevOutIndex));
    parts.push(varBytes(input.scriptSig ?? Buffer.alloc(0)));
    parts.push(u32le(input.sequence));
  }
  parts.push(compactSize(spec.outputs.length));
  for (const output of spec.outputs) {
    parts.push(u64le(output.value));
    parts.push(varBytes(output.scriptPubKey));
  }
  if (withWitness) {
    for (let i = 0; i < spec.inputs.length; i++) {
      const stack = spec.witnesses?.[i] ?? [];
      parts.push(compactSize(stack.length));
      for (const item of stack) parts.push(varBytes(item));
    }
  }
  parts.push(u32le(spec.locktime));
  return Buffer.concat(parts);
}

/** Independent legacy preimage builder (consensus rules, written for tests). */
export function legacyPreimage(
  tx: Transaction,
  inputIndex: number,
  subscript: Buffer,
  sigHashType: number,
): Buffer | null {
  const base = sigHashType & 0x1f;
  const acp = (sigHashType & 0x80) !== 0;
  if (base === 0x03 && inputIndex >= tx.outputs.length) return null;

  type In = { prevTxId: Buffer; prevOutIndex: number; script: Buffer; seq: number };
  let ins: In[] = tx.inputs.map((i, n) => ({
    prevTxId: i.prevTxId,
    prevOutIndex: i.prevOutIndex,
    script: n === inputIndex ? subscript : Buffer.alloc(0),
    seq: i.sequence,
  }));
  type Out = { value: bigint; script: Buffer };
  let outs: Out[];
  if (base === 0x02) {
    outs = [];
    ins = ins.map((i, n) => (n === inputIndex ? i : { ...i, seq: 0 }));
  } else if (base === 0x03) {
    outs = [];
    for (let k = 0; k <= inputIndex; k++) {
      outs.push(
        k === inputIndex
          ? { value: tx.outputs[k].value, script: tx.outputs[k].scriptPubKey }
          : { value: 0xffffffffffffffffn, script: Buffer.alloc(0) },
      );
    }
    ins = ins.map((i, n) => (n === inputIndex ? i : { ...i, seq: 0 }));
  } else {
    outs = tx.outputs.map((o) => ({ value: o.value, script: o.scriptPubKey }));
  }
  if (acp) ins = [ins[inputIndex]];

  const parts: Buffer[] = [i32le(tx.version), compactSize(ins.length)];
  for (const i of ins) {
    parts.push(i.prevTxId, u32le(i.prevOutIndex), varBytes(i.script), u32le(i.seq));
  }
  parts.push(compactSize(outs.length));
  for (const o of outs) parts.push(u64le(o.value), varBytes(o.script));
  parts.push(u32le(tx.locktime), u32le(sigHashType));
  return Buffer.concat(parts);
}

/** Independent BIP143 preimage builder (consensus rules, written for tests). */
export function bip143Preimage(
  tx: Transaction,
  inputIndex: number,
  subscript: Buffer,
  value: bigint,
  sigHashType: number,
): Buffer {
  const base = sigHashType & 0x1f;
  const acp = (sigHashType & 0x80) !== 0;
  const zero = Buffer.alloc(32, 0);

  let hashPrevouts: Buffer = zero;
  if (!acp) {
    hashPrevouts = sha256d(
      Buffer.concat(tx.inputs.flatMap((i) => [i.prevTxId, u32le(i.prevOutIndex)])),
    );
  }
  let hashSequence: Buffer = zero;
  if (!acp && base !== 0x03 && base !== 0x02) {
    hashSequence = sha256d(Buffer.concat(tx.inputs.map((i) => u32le(i.sequence))));
  }
  let hashOutputs: Buffer = zero;
  if (base === 0x01) {
    hashOutputs = sha256d(
      Buffer.concat(
        tx.outputs.flatMap((o) => [u64le(o.value), varBytes(o.scriptPubKey)]),
      ),
    );
  } else if (base === 0x03 && inputIndex < tx.outputs.length) {
    const o = tx.outputs[inputIndex];
    hashOutputs = sha256d(Buffer.concat([u64le(o.value), varBytes(o.scriptPubKey)]));
  }

  const current = tx.inputs[inputIndex];
  return Buffer.concat([
    i32le(tx.version),
    hashPrevouts,
    hashSequence,
    current.prevTxId,
    u32le(current.prevOutIndex),
    varBytes(subscript),
    u64le(value),
    u32le(current.sequence),
    hashOutputs,
    u32le(tx.locktime),
    u32le(sigHashType),
  ]);
}
