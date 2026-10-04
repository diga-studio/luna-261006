import { ByteWriter } from "./serialize.js";
import type { Transaction, TxInput, TxOutput } from "./types.js";

class Reader {
  offset = 0;
  constructor(private readonly buf: Buffer) {}

  private need(size: number): void {
    if (this.offset + size > this.buf.length) {
      throw new Error("malformed transaction: unexpected end of data");
    }
  }

  readBytes(size: number): Buffer {
    this.need(size);
    const out = Buffer.from(this.buf.subarray(this.offset, this.offset + size));
    this.offset += size;
    return out;
  }

  readUInt8(): number {
    this.need(1);
    const value = this.buf.readUInt8(this.offset);
    this.offset += 1;
    return value;
  }

  readInt32LE(): number {
    this.need(4);
    const value = this.buf.readInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  readUInt32LE(): number {
    this.need(4);
    const value = this.buf.readUInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  readUInt64LE(): bigint {
    this.need(8);
    const value = this.buf.readBigUInt64LE(this.offset);
    this.offset += 8;
    return value;
  }

  readCompactSize(): number {
    const first = this.readUInt8();
    if (first < 0xfd) return first;
    if (first === 0xfd) {
      this.need(2);
      const value = this.buf.readUInt16LE(this.offset);
      this.offset += 2;
      return value;
    }
    if (first === 0xfe) {
      return this.readUInt32LE();
    }
    const wide = this.readUInt64LE();
    if (wide > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("malformed transaction: CompactSize too large");
    }
    return Number(wide);
  }

  readVarBytes(): Buffer {
    return this.readBytes(this.readCompactSize());
  }

  get done(): boolean {
    return this.offset === this.buf.length;
  }
}

/** Parse a serialized transaction (legacy or witness format). */
export function parseTransaction(raw: Buffer): Transaction {
  const reader = new Reader(raw);
  const version = reader.readInt32LE();

  let hasWitness = false;
  let inputCount = reader.readCompactSize();
  if (inputCount === 0) {
    // Witness marker (0x00) followed by flag (0x01).
    const flag = reader.readUInt8();
    if (flag !== 1) {
      throw new Error("malformed transaction: invalid witness flag");
    }
    hasWitness = true;
    inputCount = reader.readCompactSize();
  }

  const inputs: TxInput[] = [];
  for (let i = 0; i < inputCount; i++) {
    inputs.push({
      prevTxId: reader.readBytes(32),
      prevOutIndex: reader.readUInt32LE(),
      scriptSig: reader.readVarBytes(),
      sequence: reader.readUInt32LE(),
    });
  }

  const outputCount = reader.readCompactSize();
  const outputs: TxOutput[] = [];
  for (let i = 0; i < outputCount; i++) {
    outputs.push({
      value: reader.readUInt64LE(),
      scriptPubKey: reader.readVarBytes(),
    });
  }

  const witnesses: Buffer[][] = [];
  if (hasWitness) {
    for (let i = 0; i < inputCount; i++) {
      const itemCount = reader.readCompactSize();
      const stack: Buffer[] = [];
      for (let j = 0; j < itemCount; j++) {
        stack.push(reader.readVarBytes());
      }
      witnesses.push(stack);
    }
  }

  const locktime = reader.readUInt32LE();
  if (!reader.done) {
    throw new Error("malformed transaction: trailing bytes");
  }
  return { version, inputs, outputs, witnesses, locktime };
}

/**
 * Serialize a transaction in legacy (non-witness) format.
 * Used for legacy sighash preimages; witness data never participates.
 */
export function serializeTransactionLegacy(tx: Transaction): Buffer {
  const writer = new ByteWriter();
  writer.writeInt32LE(tx.version);
  writer.writeCompactSize(tx.inputs.length);
  for (const input of tx.inputs) {
    writer.writeBytes(input.prevTxId);
    writer.writeUInt32LE(input.prevOutIndex);
    writer.writeVarBytes(input.scriptSig);
    writer.writeUInt32LE(input.sequence);
  }
  writer.writeCompactSize(tx.outputs.length);
  for (const output of tx.outputs) {
    writer.writeUInt64LE(output.value);
    writer.writeVarBytes(output.scriptPubKey);
  }
  writer.writeUInt32LE(tx.locktime);
  return writer.toBuffer();
}
