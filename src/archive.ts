import * as fs from "node:fs";
import { ArchiveCorruptionError } from "./errors";
import type { AdvanceHooks, ArchivedRecord } from "./types";

const RECORD_MAGIC = 0x54454c45; // "TELE"
const HEADER_BYTES = 8; // magic(4) + bodyLen(4)
const CRC_BYTES = 4;
const FIXED_BODY_BYTES = 8 + 8 + 2 + 4; // receipt + sampleAt + deviceIdLen + payloadLen
const MAX_BODY_BYTES = 1 << 20;
const READ_CHUNK_BYTES = 64 * 1024;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function encodeRecord(record: ArchivedRecord): Buffer {
  const deviceId = Buffer.from(record.deviceId, "utf8");
  const bodyLen = FIXED_BODY_BYTES + deviceId.length + record.payload.length;
  const buf = Buffer.allocUnsafe(HEADER_BYTES + bodyLen + CRC_BYTES);
  buf.writeUInt32BE(RECORD_MAGIC, 0);
  buf.writeUInt32BE(bodyLen, 4);
  buf.writeBigUInt64BE(BigInt(record.receipt), 8);
  buf.writeBigUInt64BE(BigInt(record.sampleAt), 16);
  buf.writeUInt16BE(deviceId.length, 24);
  deviceId.copy(buf, 26);
  const payloadLenOffset = 26 + deviceId.length;
  buf.writeUInt32BE(record.payload.length, payloadLenOffset);
  Buffer.from(record.payload).copy(buf, payloadLenOffset + 4);
  const body = buf.subarray(HEADER_BYTES, HEADER_BYTES + bodyLen);
  buf.writeUInt32BE(crc32(body), HEADER_BYTES + bodyLen);
  return buf;
}

export class ArchiveFile {
  private readonly fd: number;
  private offset: number;

  constructor(filePath: string, committedSize: number) {
    this.fd = fs.openSync(filePath, fs.constants.O_RDWR | fs.constants.O_CREAT, 0o600);
    const actual = fs.fstatSync(this.fd).size;
    if (actual < committedSize) {
      fs.closeSync(this.fd);
      throw new ArchiveCorruptionError(
        `archive file is ${actual} bytes but state commits ${committedSize} bytes`,
      );
    }
    if (actual > committedSize) {
      fs.ftruncateSync(this.fd, committedSize);
    }
    this.offset = committedSize;
  }

  close(): void {
    fs.closeSync(this.fd);
  }

  get size(): number {
    return this.offset;
  }

  appendBatch(records: ArchivedRecord[], hooks?: AdvanceHooks): number {
    if (records.length === 0) {
      return this.offset;
    }
    const chunks = records.map(encodeRecord);
    let start = 0;
    if (hooks?.onPartialWrite !== undefined) {
      const first = chunks[0];
      const half = Math.max(1, Math.floor(first.length / 2));
      this.writeAt(first.subarray(0, half));
      fs.fsyncSync(this.fd);
      hooks.onPartialWrite();
      this.writeAt(first.subarray(half));
      start = 1;
    }
    for (let i = start; i < chunks.length; i += 1) {
      this.writeAt(chunks[i]);
    }
    fs.fsyncSync(this.fd);
    if (hooks?.afterFsyncBeforeCommit !== undefined) {
      hooks.afterFsyncBeforeCommit();
    }
    return this.offset;
  }

  readFrom(offset: number, limit: number, committedSize: number): { records: ArchivedRecord[]; nextOffset: number } {
    const records: ArchivedRecord[] = [];
    let pos = offset;
    let buf = Buffer.alloc(0);
    const fill = (need: number): boolean => {
      while (buf.length < need) {
        const remaining = committedSize - (pos + buf.length);
        if (remaining <= 0) {
          return false;
        }
        const want = Math.min(Math.max(READ_CHUNK_BYTES, need - buf.length), remaining);
        const chunk = Buffer.allocUnsafe(want);
        const got = fs.readSync(this.fd, chunk, 0, want, pos + buf.length);
        if (got <= 0) {
          return false;
        }
        buf = buf.length === 0 ? Buffer.from(chunk.subarray(0, got)) : Buffer.concat([buf, chunk.subarray(0, got)]);
      }
      return true;
    };
    while (records.length < limit && pos < committedSize) {
      if (!fill(HEADER_BYTES)) {
        throw new ArchiveCorruptionError(`truncated record header at offset ${pos}`);
      }
      const magic = buf.readUInt32BE(0);
      if (magic !== RECORD_MAGIC) {
        throw new ArchiveCorruptionError(`bad record magic at offset ${pos}`);
      }
      const bodyLen = buf.readUInt32BE(4);
      if (bodyLen < FIXED_BODY_BYTES || bodyLen > MAX_BODY_BYTES) {
        throw new ArchiveCorruptionError(`bad record length ${bodyLen} at offset ${pos}`);
      }
      const total = HEADER_BYTES + bodyLen + CRC_BYTES;
      if (!fill(total)) {
        throw new ArchiveCorruptionError(`truncated committed record at offset ${pos}`);
      }
      const body = buf.subarray(HEADER_BYTES, HEADER_BYTES + bodyLen);
      const expectedCrc = buf.readUInt32BE(HEADER_BYTES + bodyLen);
      if (crc32(body) !== expectedCrc) {
        throw new ArchiveCorruptionError(`crc mismatch at offset ${pos}`);
      }
      const receipt = Number(body.readBigUInt64BE(0));
      const sampleAt = Number(body.readBigUInt64BE(8));
      const deviceIdLen = body.readUInt16BE(16);
      const deviceId = body.subarray(18, 18 + deviceIdLen).toString("utf8");
      const payloadLenOffset = 18 + deviceIdLen;
      const payloadLen = body.readUInt32BE(payloadLenOffset);
      const payload = Buffer.from(body.subarray(payloadLenOffset + 4, payloadLenOffset + 4 + payloadLen));
      records.push({ receipt, deviceId, sampleAt, payload });
      pos += total;
      buf = buf.subarray(total);
    }
    return { records, nextOffset: pos };
  }

  private writeAt(buf: Buffer): void {
    let written = 0;
    while (written < buf.length) {
      written += fs.writeSync(this.fd, buf, written, buf.length - written, this.offset + written);
    }
    this.offset += buf.length;
  }
}
