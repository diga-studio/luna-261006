/** Minimal growable byte writer for Bitcoin serialization. */
export class ByteWriter {
  private chunks: Buffer[] = [];
  private length = 0;

  writeBytes(bytes: Buffer | Uint8Array): this {
    this.chunks.push(Buffer.from(bytes));
    this.length += bytes.length;
    return this;
  }

  writeUInt8(value: number): this {
    const buf = Buffer.allocUnsafe(1);
    buf.writeUInt8(value);
    return this.writeBytes(buf);
  }

  writeUInt32LE(value: number): this {
    const buf = Buffer.allocUnsafe(4);
    buf.writeUInt32LE(value >>> 0);
    return this.writeBytes(buf);
  }

  writeInt32LE(value: number): this {
    const buf = Buffer.allocUnsafe(4);
    buf.writeInt32LE(value);
    return this.writeBytes(buf);
  }

  /** Write a 64-bit unsigned integer, full width preserved via bigint. */
  writeUInt64LE(value: bigint): this {
    const buf = Buffer.allocUnsafe(8);
    buf.writeBigUInt64LE(value);
    return this.writeBytes(buf);
  }

  /** Encode a length/count using Bitcoin CompactSize. */
  writeCompactSize(value: number): this {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`invalid CompactSize value: ${value}`);
    }
    if (value < 0xfd) {
      return this.writeUInt8(value);
    }
    if (value <= 0xffff) {
      this.writeUInt8(0xfd);
      const buf = Buffer.allocUnsafe(2);
      buf.writeUInt16LE(value);
      return this.writeBytes(buf);
    }
    if (value <= 0xffffffff) {
      this.writeUInt8(0xfe);
      return this.writeUInt32LE(value);
    }
    this.writeUInt8(0xff);
    return this.writeUInt64LE(BigInt(value));
  }

  /** Write a CompactSize length prefix followed by the bytes. */
  writeVarBytes(bytes: Buffer | Uint8Array): this {
    this.writeCompactSize(bytes.length);
    return this.writeBytes(bytes);
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks, this.length);
  }
}
