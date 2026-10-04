import * as fs from "node:fs";
import { crc32 } from "./crc32.ts";
import type { ArchivedRecord } from "./types.ts";

const MAGIC = 0x54424c47; // "TBLG"
const HEADER_BYTES = 12; // magic u32 + bodyLen u32 + crc u32
const MAX_BODY_BYTES = 8 + 8 + 2 + 65535 + 4 + 4096;

export interface ReplayResult {
  goodOffset: number;
  records: ArchivedRecord[];
}

function serializeRecord(record: ArchivedRecord): Buffer {
  const deviceId = Buffer.from(record.deviceId, "utf8");
  const body = Buffer.alloc(8 + 8 + 2 + deviceId.length + 4 + record.payload.length);
  let at = 0;
  body.writeBigUInt64LE(BigInt(record.receipt), at);
  at += 8;
  body.writeDoubleLE(record.sampleAt, at);
  at += 8;
  body.writeUInt16LE(deviceId.length, at);
  at += 2;
  deviceId.copy(body, at);
  at += deviceId.length;
  body.writeUInt32LE(record.payload.length, at);
  at += 4;
  Buffer.from(record.payload.buffer, record.payload.byteOffset, record.payload.byteLength).copy(body, at);
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32LE(MAGIC, 0);
  header.writeUInt32LE(body.length, 4);
  header.writeUInt32LE(crc32(body), 8);
  return Buffer.concat([header, body]);
}

function parseRecordAt(
  fd: number,
  offset: number,
  fileSize: number,
): { record: ArchivedRecord; nextOffset: number } | null {
  if (offset + HEADER_BYTES > fileSize) return null;
  const header = Buffer.alloc(HEADER_BYTES);
  fs.readSync(fd, header, 0, HEADER_BYTES, offset);
  if (header.readUInt32LE(0) !== MAGIC) return null;
  const bodyLen = header.readUInt32LE(4);
  if (bodyLen > MAX_BODY_BYTES) return null;
  if (offset + HEADER_BYTES + bodyLen > fileSize) return null;
  const body = Buffer.alloc(bodyLen);
  fs.readSync(fd, body, 0, bodyLen, offset + HEADER_BYTES);
  if (crc32(body) !== header.readUInt32LE(8)) return null;
  let at = 0;
  const receipt = Number(body.readBigUInt64LE(at));
  at += 8;
  const sampleAt = body.readDoubleLE(at);
  at += 8;
  const deviceIdLen = body.readUInt16LE(at);
  at += 2;
  if (at + deviceIdLen + 4 > bodyLen) return null;
  const deviceId = body.toString("utf8", at, at + deviceIdLen);
  at += deviceIdLen;
  const payloadLen = body.readUInt32LE(at);
  at += 4;
  if (at + payloadLen !== bodyLen) return null;
  const payload = body.subarray(at, at + payloadLen);
  return {
    record: { receipt, deviceId, sampleAt, payload: Buffer.from(payload) },
    nextOffset: offset + HEADER_BYTES + bodyLen,
  };
}

export function encodeCursor(offset: number): string {
  return `o${offset}`;
}

export function decodeCursor(cursor: string | null): number {
  if (cursor === null) return 0;
  if (!/^o\d+$/.test(cursor)) throw new Error(`invalid cursor: ${cursor}`);
  return Number(cursor.slice(1));
}

export class Archive {
  private fd: number;
  private writeOffset: number;
  private committed = 0;

  constructor(path: string) {
    this.fd = fs.openSync(path, "a+");
    this.writeOffset = fs.fstatSync(this.fd).size;
  }

  get committedOffset(): number {
    return this.committed;
  }

  recover(committedOffset: number): ReplayResult {
    const fileSize = fs.fstatSync(this.fd).size;
    if (fileSize < committedOffset) {
      throw new Error(
        `archive file shorter than committed offset: size=${fileSize} committed=${committedOffset}`,
      );
    }
    const records: ArchivedRecord[] = [];
    let offset = committedOffset;
    let goodOffset = committedOffset;
    while (offset < fileSize) {
      const parsed = parseRecordAt(this.fd, offset, fileSize);
      if (parsed === null) break;
      records.push(parsed.record);
      offset = parsed.nextOffset;
      goodOffset = parsed.nextOffset;
    }
    if (goodOffset < fileSize) {
      fs.ftruncateSync(this.fd, goodOffset);
      fs.fsyncSync(this.fd);
    }
    this.writeOffset = goodOffset;
    this.committed = goodOffset;
    return { goodOffset, records };
  }

  appendBatch(
    records: ArchivedRecord[],
    hooks?: {
      beforeRecordWrite?: (i: number, r: ArchivedRecord) => void;
      afterRecordWrite?: (i: number, r: ArchivedRecord) => void;
    },
  ): number {
    for (let i = 0; i < records.length; i++) {
      hooks?.beforeRecordWrite?.(i, records[i]);
      const bytes = serializeRecord(records[i]);
      fs.writeSync(this.fd, bytes, 0, bytes.length, this.writeOffset);
      this.writeOffset += bytes.length;
      hooks?.afterRecordWrite?.(i, records[i]);
    }
    return this.writeOffset;
  }

  fsync(): void {
    fs.fsyncSync(this.fd);
  }

  markCommitted(offset: number): void {
    this.committed = offset;
  }

  readFrom(
    cursor: string | null,
    limit: number,
  ): { records: ArchivedRecord[]; nextCursor: string | null } {
    let offset = decodeCursor(cursor);
    const records: ArchivedRecord[] = [];
    while (records.length < limit && offset < this.committed) {
      const parsed = parseRecordAt(this.fd, offset, this.committed);
      if (parsed === null) {
        throw new Error(`committed archive region is corrupt at offset ${offset}`);
      }
      records.push(parsed.record);
      offset = parsed.nextOffset;
    }
    const nextCursor = offset < this.committed ? encodeCursor(offset) : null;
    return { records, nextCursor };
  }

  close(): void {
    fs.closeSync(this.fd);
  }
}
