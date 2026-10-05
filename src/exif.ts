import { JpegPrivacyError } from "./errors.ts";
import type { Rational } from "./types.ts";

export type TiffValue =
  | { type: 1 | 6 | 7; bytes: Uint8Array }
  | { type: 2; bytes: Uint8Array }
  | { type: 3 | 4 | 8 | 9; ints: number[] }
  | { type: 5 | 10; rationals: Rational[] }
  | { type: 11 | 12; floats: number[] };

export interface TiffField {
  tag: number;
  value: TiffValue;
}

export type ByteOrder = "II" | "MM";

export interface ParsedExif {
  byteOrder: ByteOrder;
  ifd0: TiffField[];
  exifIfd: TiffField[];
}

export interface MergedExif {
  byteOrder: ByteOrder;
  ifd0: TiffField[];
  exifIfd: TiffField[];
}

const TIFF_TYPE_SIZES: Readonly<Record<number, number>> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  6: 1, // SBYTE
  7: 1, // UNDEFINED
  8: 2, // SSHORT
  9: 4, // SLONG
  10: 8, // SRATIONAL
  11: 4, // FLOAT
  12: 8, // DOUBLE
};

const TAG_EXIF_IFD_POINTER = 0x8769;

const IFD0_WHITELIST: Readonly<Record<number, string>> = {
  0x010f: "Make",
  0x0110: "Model",
  0x0112: "Orientation",
};

const EXIF_IFD_WHITELIST: Readonly<Record<number, string>> = {
  0x829a: "ExposureTime",
  0x829d: "FNumber",
  0x8827: "ISOSpeedRatings",
  0x920a: "FocalLength",
};

export const WHITELIST_FIELD_NAMES: Readonly<Record<string, string>> = {
  "IFD0:271": "Make",
  "IFD0:272": "Model",
  "IFD0:274": "Orientation",
  "ExifIFD:33434": "ExposureTime",
  "ExifIFD:33437": "FNumber",
  "ExifIFD:34855": "ISOSpeedRatings",
  "ExifIFD:37386": "FocalLength",
};

function invalidExif(message: string): never {
  throw new JpegPrivacyError("INVALID_EXIF", message);
}

class TiffReader {
  private readonly view: DataView;
  private readonly little: boolean;
  readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    if (bytes.length < 8) {
      invalidExif("TIFF header too short");
    }
    const bo = (bytes[0]! << 8) | bytes[1]!;
    if (bo === 0x4949) {
      this.little = true;
    } else if (bo === 0x4d4d) {
      this.little = false;
    } else {
      invalidExif("unknown TIFF byte order");
    }
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (this.u16(2) !== 42) {
      invalidExif("bad TIFF magic number");
    }
  }

  u16(offset: number): number {
    if (offset < 0 || offset + 2 > this.bytes.length) {
      invalidExif(`read out of bounds at TIFF offset ${offset}`);
    }
    return this.view.getUint16(offset, this.little);
  }

  u32(offset: number): number {
    if (offset < 0 || offset + 4 > this.bytes.length) {
      invalidExif(`read out of bounds at TIFF offset ${offset}`);
    }
    return this.view.getUint32(offset, this.little);
  }

  byteOrder(): ByteOrder {
    return this.little ? "II" : "MM";
  }

  firstIfdOffset(): number {
    const offset = this.u32(4);
    if (offset < 8) {
      invalidExif("IFD0 offset overlaps TIFF header");
    }
    return offset;
  }
}

function decodeValue(
  reader: TiffReader,
  type: number,
  count: number,
  raw: Uint8Array,
): TiffValue {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const little = reader.byteOrder() === "II";
  switch (type) {
    case 1:
    case 6:
    case 7:
      return { type, bytes: raw.slice() };
    case 2:
      return { type: 2, bytes: raw.slice() };
    case 3:
    case 8: {
      const ints: number[] = [];
      for (let i = 0; i < count; i += 1) {
        ints.push(type === 3 ? view.getUint16(i * 2, little) : view.getInt16(i * 2, little));
      }
      return { type, ints };
    }
    case 4:
    case 9: {
      const ints: number[] = [];
      for (let i = 0; i < count; i += 1) {
        ints.push(type === 4 ? view.getUint32(i * 4, little) : view.getInt32(i * 4, little));
      }
      return { type, ints };
    }
    case 5:
    case 10: {
      const rationals: Rational[] = [];
      for (let i = 0; i < count; i += 1) {
        const numerator = type === 5 ? view.getUint32(i * 8, little) : view.getInt32(i * 8, little);
        const denominator =
          type === 5 ? view.getUint32(i * 8 + 4, little) : view.getInt32(i * 8 + 4, little);
        rationals.push({ numerator, denominator });
      }
      return { type, rationals };
    }
    case 11:
    case 12: {
      const floats: number[] = [];
      const step = type === 11 ? 4 : 8;
      for (let i = 0; i < count; i += 1) {
        floats.push(type === 11 ? view.getFloat32(i * step, little) : view.getFloat64(i * step, little));
      }
      return { type, floats };
    }
    default:
      invalidExif(`unsupported TIFF field type ${type}`);
  }
}

interface RawEntry {
  tag: number;
  type: number;
  count: number;
  inlineOrOffset: number;
  valueFieldOffset: number;
}

function readIfdEntries(reader: TiffReader, ifdOffset: number): RawEntry[] {
  const entryCount = reader.u16(ifdOffset);
  const entriesStart = ifdOffset + 2;
  const entriesEnd = entriesStart + entryCount * 12;
  if (entriesEnd > reader.bytes.length) {
    invalidExif("IFD entries extend past end of EXIF data");
  }
  const entries: RawEntry[] = [];
  for (let i = 0; i < entryCount; i += 1) {
    const base = entriesStart + i * 12;
    entries.push({
      tag: reader.u16(base),
      type: reader.u16(base + 2),
      count: reader.u32(base + 4),
      inlineOrOffset: reader.u32(base + 8),
      valueFieldOffset: base + 8,
    });
  }
  return entries;
}

function readFieldValue(reader: TiffReader, entry: RawEntry): TiffField {
  const typeSize = TIFF_TYPE_SIZES[entry.type];
  if (typeSize === undefined) {
    invalidExif(`kept field 0x${entry.tag.toString(16)} has unknown type ${entry.type}`);
  }
  if (entry.count > 0x7fffffff / typeSize) {
    invalidExif(`kept field 0x${entry.tag.toString(16)} count overflow`);
  }
  const byteLength = entry.count * typeSize;
  let raw: Uint8Array;
  if (byteLength <= 4) {
    // Inline values are stored left-justified in the 4-byte value field,
    // regardless of byte order.
    const valueOffset = entry.valueFieldOffset;
    raw = reader.bytes.subarray(valueOffset, valueOffset + byteLength);
  } else {
    const offset = entry.inlineOrOffset;
    if (offset < 0 || offset + byteLength > reader.bytes.length) {
      invalidExif(`kept field 0x${entry.tag.toString(16)} value out of bounds`);
    }
    raw = reader.bytes.subarray(offset, offset + byteLength);
  }
  return { tag: entry.tag, value: decodeValue(reader, entry.type, entry.count, raw) };
}

export function parseExif(tiff: Uint8Array): ParsedExif {
  const reader = new TiffReader(tiff);
  const ifd0Offset = reader.firstIfdOffset();
  const ifd0Entries = readIfdEntries(reader, ifd0Offset);

  const ifd0: TiffField[] = [];
  let exifIfdOffset: number | undefined;
  for (const entry of ifd0Entries) {
    if (entry.tag === TAG_EXIF_IFD_POINTER) {
      if (entry.type !== 4 || entry.count !== 1) {
        invalidExif("malformed ExifIFD pointer");
      }
      exifIfdOffset = entry.inlineOrOffset;
      continue;
    }
    if (IFD0_WHITELIST[entry.tag] !== undefined) {
      ifd0.push(readFieldValue(reader, entry));
    }
  }

  const exifIfd: TiffField[] = [];
  if (exifIfdOffset !== undefined) {
    const exifEntries = readIfdEntries(reader, exifIfdOffset);
    for (const entry of exifEntries) {
      if (EXIF_IFD_WHITELIST[entry.tag] !== undefined) {
        exifIfd.push(readFieldValue(reader, entry));
      }
    }
  }

  return { byteOrder: reader.byteOrder(), ifd0, exifIfd };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function valuesEqual(a: TiffValue, b: TiffValue): boolean {
  if (a.type !== b.type) {
    return false;
  }
  switch (a.type) {
    case 1:
    case 2:
    case 6:
    case 7:
      return bytesEqual(a.bytes, (b as { bytes: Uint8Array }).bytes);
    case 3:
    case 4:
    case 8:
    case 9: {
      const bi = (b as { ints: number[] }).ints;
      return a.ints.length === bi.length && a.ints.every((v, i) => v === bi[i]);
    }
    case 5:
    case 10: {
      const br = (b as { rationals: Rational[] }).rationals;
      return (
        a.rationals.length === br.length &&
        a.rationals.every(
          (r, i) => r.numerator === br[i]!.numerator && r.denominator === br[i]!.denominator,
        )
      );
    }
    case 11:
    case 12: {
      const bf = (b as { floats: number[] }).floats;
      return a.floats.length === bf.length && a.floats.every((v, i) => v === bf[i]);
    }
  }
}

export function fieldCount(field: TiffField): number {
  const value = field.value;
  switch (value.type) {
    case 1:
    case 2:
    case 6:
    case 7:
      return value.bytes.length;
    case 3:
    case 4:
    case 8:
    case 9:
      return value.ints.length;
    case 5:
    case 10:
      return value.rationals.length;
    case 11:
    case 12:
      return value.floats.length;
  }
}

function mergeFieldList(
  target: Map<number, TiffField>,
  fields: TiffField[],
  ifdName: string,
): void {
  for (const field of fields) {
    const existing = target.get(field.tag);
    if (existing === undefined) {
      target.set(field.tag, field);
    } else if (!valuesEqual(existing.value, field.value)) {
      const name = WHITELIST_FIELD_NAMES[`${ifdName}:${field.tag}`] ?? `0x${field.tag.toString(16)}`;
      throw new JpegPrivacyError(
        "CONFLICTING_EXIF",
        `conflicting values for kept field ${name} across EXIF segments`,
      );
    }
  }
}

export function mergeExifFields(segments: ParsedExif[]): MergedExif {
  const first = segments[0];
  if (first === undefined) {
    throw new JpegPrivacyError("INVALID_EXIF", "no EXIF segments to merge");
  }
  const ifd0 = new Map<number, TiffField>();
  const exifIfd = new Map<number, TiffField>();
  for (const segment of segments) {
    mergeFieldList(ifd0, segment.ifd0, "IFD0");
    mergeFieldList(exifIfd, segment.exifIfd, "ExifIFD");
  }
  const byTag = (a: TiffField, b: TiffField) => a.tag - b.tag;
  return {
    byteOrder: first.byteOrder,
    ifd0: [...ifd0.values()].sort(byTag),
    exifIfd: [...exifIfd.values()].sort(byTag),
  };
}

class TiffWriter {
  private readonly bytes: number[] = [];
  private readonly little: boolean;

  constructor(byteOrder: ByteOrder) {
    this.little = byteOrder === "II";
    this.pushRaw([byteOrder.charCodeAt(0), byteOrder.charCodeAt(1)]);
    this.u16(42);
    this.u32(8);
  }

  private pushRaw(values: ArrayLike<number>): void {
    for (let i = 0; i < values.length; i += 1) {
      this.bytes.push(values[i]! & 0xff);
    }
  }

  u16(value: number): void {
    if (this.little) {
      this.bytes.push(value & 0xff, (value >> 8) & 0xff);
    } else {
      this.bytes.push((value >> 8) & 0xff, value & 0xff);
    }
  }

  u32(value: number): void {
    if (this.little) {
      this.bytes.push(
        value & 0xff,
        (value >> 8) & 0xff,
        (value >> 16) & 0xff,
        (value >>> 24) & 0xff,
      );
    } else {
      this.bytes.push(
        (value >>> 24) & 0xff,
        (value >> 16) & 0xff,
        (value >> 8) & 0xff,
        value & 0xff,
      );
    }
  }

  align2(): void {
    if (this.bytes.length % 2 !== 0) {
      this.bytes.push(0);
    }
  }

  pushValue(raw: Uint8Array): void {
    for (let i = 0; i < raw.length; i += 1) {
      this.bytes.push(raw[i]!);
    }
  }

  offset(): number {
    return this.bytes.length;
  }

  patchU32(at: number, value: number): void {
    if (this.little) {
      this.bytes[at] = value & 0xff;
      this.bytes[at + 1] = (value >> 8) & 0xff;
      this.bytes[at + 2] = (value >> 16) & 0xff;
      this.bytes[at + 3] = (value >>> 24) & 0xff;
    } else {
      this.bytes[at] = (value >>> 24) & 0xff;
      this.bytes[at + 1] = (value >> 16) & 0xff;
      this.bytes[at + 2] = (value >> 8) & 0xff;
      this.bytes[at + 3] = value & 0xff;
    }
  }

  encodeValue(value: TiffValue): Uint8Array {
    const out: number[] = [];
    const push16 = (v: number) => {
      if (this.little) {
        out.push(v & 0xff, (v >> 8) & 0xff);
      } else {
        out.push((v >> 8) & 0xff, v & 0xff);
      }
    };
    const push32 = (v: number) => {
      if (this.little) {
        out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
      } else {
        out.push((v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
      }
    };
    switch (value.type) {
      case 1:
      case 2:
      case 6:
      case 7:
        return value.bytes.slice();
      case 3:
      case 8:
        for (const v of value.ints) {
          push16(v & 0xffff);
        }
        break;
      case 4:
      case 9:
        for (const v of value.ints) {
          push32(v >>> 0);
        }
        break;
      case 5:
      case 10:
        for (const r of value.rationals) {
          push32(r.numerator >>> 0);
          push32(r.denominator >>> 0);
        }
        break;
      case 11:
      case 12: {
        const step = value.type === 11 ? 4 : 8;
        const buf = new DataView(new ArrayBuffer(value.floats.length * step));
        value.floats.forEach((f, i) => {
          if (value.type === 11) {
            buf.setFloat32(i * step, f, this.little);
          } else {
            buf.setFloat64(i * step, f, this.little);
          }
        });
        return new Uint8Array(buf.buffer);
      }
    }
    return new Uint8Array(out);
  }

  entry(tag: number, type: number, count: number, valueOrOffset: number): void {
    this.u16(tag);
    this.u16(type);
    this.u32(count);
    this.u32(valueOrOffset);
  }

  entryInline(tag: number, type: number, count: number, raw: Uint8Array): void {
    this.u16(tag);
    this.u16(type);
    this.u32(count);
    this.pushRaw(raw);
    for (let i = raw.length; i < 4; i += 1) {
      this.bytes.push(0);
    }
  }

  finish(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

interface PendingValue {
  raw: Uint8Array;
  offset: number;
}

/**
 * Rebuilds a TIFF payload from scratch containing only the whitelisted
 * fields. The layout is a pure function of the kept fields and the byte
 * order, so re-exporting an already sanitized file is byte-identical and no
 * bytes from the original (GPS IFD, MakerNote, thumbnail, padding) can
 * survive.
 */
export function buildExif(merged: MergedExif): Uint8Array {
  const writer = new TiffWriter(merged.byteOrder);
  const pending: PendingValue[] = [];

  const ifd0Entries = [...merged.ifd0];
  const hasExifIfd = merged.exifIfd.length > 0;
  const ifd0Count = ifd0Entries.length + (hasExifIfd ? 1 : 0);

  // IFD0 starts at offset 8 (right after the TIFF header).
  writer.u16(ifd0Count);

  const emitField = (field: TiffField): void => {
    const raw = writer.encodeValue(field.value);
    const count = fieldCount(field);
    if (raw.length <= 4) {
      writer.entryInline(field.tag, field.value.type, count, raw);
    } else {
      pending.push({ raw, offset: 0 });
      writer.entry(field.tag, field.value.type, count, 0);
    }
  };

  for (const field of ifd0Entries) {
    emitField(field);
  }
  let exifPointerPatchAt = 0;
  if (hasExifIfd) {
    exifPointerPatchAt = writer.offset() + 8;
    writer.entry(TAG_EXIF_IFD_POINTER, 4, 1, 0);
  }
  writer.u32(0); // No IFD1: the thumbnail directory is removed entirely.

  writer.align2();
  let exifIfdEntriesStart = 0;
  if (hasExifIfd) {
    writer.patchU32(exifPointerPatchAt, writer.offset());
    writer.u16(merged.exifIfd.length);
    exifIfdEntriesStart = writer.offset();
    for (const field of merged.exifIfd) {
      emitField(field);
    }
    writer.u32(0);
  }

  // Value area: append values in entry order, then patch their offsets.
  for (const item of pending) {
    writer.align2();
    item.offset = writer.offset();
    writer.pushValue(item.raw);
  }
  let pendingIndex = 0;
  const patchEntries = (fields: TiffField[], entriesStart: number): void => {
    let cursor = entriesStart;
    for (const field of fields) {
      const raw = writer.encodeValue(field.value);
      if (raw.length > 4) {
        writer.patchU32(cursor + 8, pending[pendingIndex]!.offset);
        pendingIndex += 1;
      }
      cursor += 12;
    }
  };
  const ifd0EntriesStart = 8 + 2;
  patchEntries(ifd0Entries, ifd0EntriesStart);
  if (hasExifIfd) {
    patchEntries(merged.exifIfd, exifIfdEntriesStart);
  }
  return writer.finish();
}
