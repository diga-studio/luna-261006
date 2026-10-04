import { decodeCompactSize } from "./compactSize";
import { Transaction, TxInput, TxOutput } from "./types";

class Reader {
  private pos = 0;
  constructor(private readonly buf: Uint8Array) {}

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  readBytes(n: number): Uint8Array {
    if (n < 0 || this.pos + n > this.buf.length) {
      throw new Error("transaction parse error: unexpected end of data");
    }
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  readUint32(): number {
    const b = this.readBytes(4);
    return (
      (b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)) >>> 0
    );
  }

  readInt32(): number {
    return this.readUint32() | 0;
  }

  readUint64(): bigint {
    const b = this.readBytes(8);
    let v = 0n;
    for (let i = 0; i < 8; i++) {
      v |= BigInt(b[i]!) << BigInt(8 * i);
    }
    return v;
  }

  readCompactSize(): bigint {
    const { value, size } = decodeCompactSize(this.buf, this.pos);
    this.pos += size;
    return value;
  }

  readVarBytes(): Uint8Array {
    const len = this.readCompactSize();
    if (len > BigInt(this.remaining)) {
      throw new Error("transaction parse error: vector length exceeds data");
    }
    return this.readBytes(Number(len));
  }
}

/** Parse a serialized transaction (legacy or witness format). */
export function parseTransaction(bytes: Uint8Array): Transaction {
  const r = new Reader(bytes);
  const version = r.readInt32();

  let hasWitness = false;
  let inputCount = r.readCompactSize();
  if (inputCount === 0n) {
    // Possible segwit marker (0x00) followed by flag (0x01).
    const flag = r.readBytes(1)[0]!;
    if (flag !== 0x01) {
      throw new Error("transaction parse error: invalid witness flag");
    }
    hasWitness = true;
    inputCount = r.readCompactSize();
  }
  if (inputCount > BigInt(r.remaining)) {
    throw new Error("transaction parse error: input count exceeds data");
  }

  const inputs: TxInput[] = [];
  for (let i = 0; i < inputCount; i++) {
    const prevTxHash = r.readBytes(32);
    const prevOutIndex = r.readUint32();
    const scriptSig = r.readVarBytes();
    const sequence = r.readUint32();
    inputs.push({ prevTxHash, prevOutIndex, scriptSig, sequence });
  }

  const outputCount = r.readCompactSize();
  if (outputCount > BigInt(r.remaining)) {
    throw new Error("transaction parse error: output count exceeds data");
  }
  const outputs: TxOutput[] = [];
  for (let i = 0; i < outputCount; i++) {
    const value = r.readUint64();
    const scriptPubKey = r.readVarBytes();
    outputs.push({ value, scriptPubKey });
  }

  const witnesses: Uint8Array[][] = inputs.map(() => []);
  if (hasWitness) {
    for (let i = 0; i < inputs.length; i++) {
      const itemCount = r.readCompactSize();
      if (itemCount > BigInt(r.remaining)) {
        throw new Error("transaction parse error: witness count exceeds data");
      }
      const stack: Uint8Array[] = [];
      for (let j = 0; j < itemCount; j++) {
        stack.push(r.readVarBytes());
      }
      witnesses[i] = stack;
    }
  }

  const locktime = r.readUint32();
  if (r.remaining !== 0) {
    throw new Error("transaction parse error: trailing bytes");
  }

  return { version, inputs, outputs, witnesses, locktime, hasWitness };
}
