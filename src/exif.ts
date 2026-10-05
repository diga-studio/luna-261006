import { JpegPrivacyError } from "./errors.js";
import type { ExifValue, PreviewField } from "./types.js";

/** 白名单 tag → 字段名。 */
export const WHITELIST: ReadonlyMap<number, string> = new Map([
  [0x010f, "Make"],
  [0x0110, "Model"],
  [0x0112, "Orientation"],
  [0x829a, "ExposureTime"],
  [0x829d, "FNumber"],
  [0x8827, "ISOSpeedRatings"],
  [0x920a, "FocalLength"],
]);

const EXIF_IFD_POINTER = 0x8769;

const TYPE_SIZE: Readonly<Record<number, number>> = {
  1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8,
};

/** 提取出的字段：预览信息 + 源文件中的原始值字节与字节序。 */
export interface ExtractedField extends PreviewField {
  /** 值的原始字节（按源 TIFF 字节序编码）。 */
  rawValue: Uint8Array;
  /** 源 TIFF 是否小端。 */
  littleEndian: boolean;
}

function fail(code: string, message: string): never {
  throw new JpegPrivacyError(code, message);
}

interface IfdEntry {
  tag: number;
  type: number;
  count: number;
  /** 值/偏移这 4 字节在 TIFF 中的位置。 */
  valuePos: number;
}

class TiffReader {
  readonly view: DataView;
  readonly littleEndian: boolean;
  constructor(readonly tiff: Uint8Array) {
    if (tiff.length < 8) fail("bad_exif", "TIFF 头过短");
    const b0 = tiff[0]!;
    const b1 = tiff[1]!;
    if (b0 === 0x49 && b1 === 0x49) this.littleEndian = true;
    else if (b0 === 0x4d && b1 === 0x4d) this.littleEndian = false;
    else fail("bad_exif", "未知的 TIFF 字节序标记");
    this.view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
    const magic = this.u16(2);
    if (magic !== 42) fail("bad_exif", `不支持的 TIFF 魔数 ${magic}`);
    const ifd0 = this.u32(4);
    if (ifd0 < 8 || ifd0 + 2 > tiff.length) fail("bad_exif", "IFD0 偏移越界");
    this.ifd0Offset = ifd0;
  }
  readonly ifd0Offset: number;
  u16(at: number): number {
    return this.view.getUint16(at, this.littleEndian);
  }
  u32(at: number): number {
    return this.view.getUint32(at, this.littleEndian);
  }
  i32(at: number): number {
    return this.view.getInt32(at, this.littleEndian);
  }
  /** 读取目录；目录越界时抛错。 */
  readIfd(offset: number): IfdEntry[] {
    if (offset < 0 || offset + 2 > this.tiff.length) fail("bad_exif", "目录偏移越界");
    const count = this.u16(offset);
    const entriesEnd = offset + 2 + count * 12;
    if (entriesEnd + 4 > this.tiff.length) fail("bad_exif", "目录条目越界");
    const entries: IfdEntry[] = [];
    for (let i = 0; i < count; i++) {
      const at = offset + 2 + i * 12;
      entries.push({
        tag: this.u16(at),
        type: this.u16(at + 2),
        count: this.u32(at + 4),
        valuePos: at + 8,
      });
    }
    return entries;
  }
  /** 读取条目的原始值字节；类型未知或值越界时抛错。 */
  entryRawValue(entry: IfdEntry): Uint8Array {
    const size = TYPE_SIZE[entry.type];
    if (size === undefined) fail("bad_exif", `保留字段出现未知类型 ${entry.type}`);
    const total = size * entry.count;
    if (total <= 4) {
      return this.tiff.subarray(entry.valuePos, entry.valuePos + total);
    }
    const offset = this.u32(entry.valuePos);
    if (offset < 0 || offset + total > this.tiff.length) {
      fail("bad_exif", "保留字段的值偏移越界");
    }
    return this.tiff.subarray(offset, offset + total);
  }
}

function decodeAscii(raw: Uint8Array): string {
  let end = raw.length;
  while (end > 0 && raw[end - 1] === 0) end--; // 去掉尾部 NUL 仅用于展示
  let text = "";
  for (let i = 0; i < end; i++) text += String.fromCharCode(raw[i]!);
  return text;
}

function decodeValue(reader: TiffReader, type: number, count: number, raw: Uint8Array): ExifValue {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const le = reader.littleEndian;
  switch (type) {
    case 2:
      return { kind: "ascii", text: decodeAscii(raw) };
    case 1:
    case 7: {
      const values: number[] = [];
      for (let i = 0; i < count; i++) values.push(view.getUint8(i));
      return { kind: "uint", values };
    }
    case 3: {
      const values: number[] = [];
      for (let i = 0; i < count; i++) values.push(view.getUint16(i * 2, le));
      return { kind: "uint", values };
    }
    case 4: {
      const values: number[] = [];
      for (let i = 0; i < count; i++) values.push(view.getUint32(i * 4, le));
      return { kind: "uint", values };
    }
    case 6: {
      const values: number[] = [];
      for (let i = 0; i < count; i++) values.push(view.getInt8(i));
      return { kind: "int", values };
    }
    case 8: {
      const values: number[] = [];
      for (let i = 0; i < count; i++) values.push(view.getInt16(i * 2, le));
      return { kind: "int", values };
    }
    case 9: {
      const values: number[] = [];
      for (let i = 0; i < count; i++) values.push(view.getInt32(i * 4, le));
      return { kind: "int", values };
    }
    case 5: {
      const values: Array<[number, number]> = [];
      for (let i = 0; i < count; i++) {
        values.push([view.getUint32(i * 8, le), view.getUint32(i * 8 + 4, le)]);
      }
      return { kind: "rational", values };
    }
    case 10: {
      const values: Array<[number, number]> = [];
      for (let i = 0; i < count; i++) {
        values.push([view.getInt32(i * 8, le), view.getInt32(i * 8 + 4, le)]);
      }
      return { kind: "rational", values };
    }
    case 11: {
      const values: number[] = [];
      for (let i = 0; i < count; i++) values.push(view.getFloat32(i * 4, le));
      return { kind: "float", values };
    }
    case 12: {
      const values: number[] = [];
      for (let i = 0; i < count; i++) values.push(view.getFloat64(i * 8, le));
      return { kind: "float", values };
    }
    default:
      return fail("bad_exif", `保留字段出现未知类型 ${type}`);
  }
}

function extractFromIfd(reader: TiffReader, entries: IfdEntry[], out: ExtractedField[]): void {
  for (const entry of entries) {
    const name = WHITELIST.get(entry.tag);
    if (name === undefined) continue;
    const rawValue = reader.entryRawValue(entry);
    out.push({
      name,
      tag: entry.tag,
      type: entry.type,
      count: entry.count,
      value: decodeValue(reader, entry.type, entry.count, rawValue),
      rawValue,
      littleEndian: reader.littleEndian,
    });
  }
}

/**
 * 从一个 APP1 EXIF 段负载（含 "Exif\0\0" 头）提取白名单字段。
 * 只解析 IFD0 与 ExifIFD；GPS、IFD1、MakerNote 等整体删除的区域不解析。
 * 读取白名单字段所需的目录、指针、类型或值损坏时抛 JpegPrivacyError。
 */
export function extractWhitelistFields(payload: Uint8Array): ExtractedField[] {
  if (
    payload.length < 8 ||
    payload[0] !== 0x45 || // E
    payload[1] !== 0x78 || // x
    payload[2] !== 0x69 || // i
    payload[3] !== 0x66 || // f
    payload[4] !== 0 ||
    payload[5] !== 0
  ) {
    fail("bad_exif", "缺少 Exif 头");
  }
  const reader = new TiffReader(payload.subarray(6));
  const out: ExtractedField[] = [];
  const ifd0 = reader.readIfd(reader.ifd0Offset);
  extractFromIfd(reader, ifd0, out);
  // ExifIFD 指针：存在即必须合法可读。
  const pointer = ifd0.find((e) => e.tag === EXIF_IFD_POINTER);
  if (pointer !== undefined) {
    if (pointer.type !== 4 || pointer.count !== 1) {
      fail("bad_exif", "ExifIFD 指针类型或数量非法");
    }
    const exifIfdOffset = reader.u32(pointer.valuePos);
    const exifIfd = reader.readIfd(exifIfdOffset);
    extractFromIfd(reader, exifIfd, out);
  }
  return out;
}

function valuesEqual(a: ExifValue, b: ExifValue): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "ascii" && b.kind === "ascii") return a.text === b.text;
  if ((a.kind === "uint" || a.kind === "int" || a.kind === "float") &&
      (b.kind === "uint" || b.kind === "int" || b.kind === "float")) {
    return a.values.length === b.values.length && a.values.every((v, i) => v === b.values[i]);
  }
  if (a.kind === "rational" && b.kind === "rational") {
    return (
      a.values.length === b.values.length &&
      a.values.every((pair, i) => pair[0] === b.values[i]![0] && pair[1] === b.values[i]![1])
    );
  }
  return false;
}

/**
 * 合并多个 EXIF 段提取的白名单字段。
 * 同一字段重复出现时，类型、数量及解码值全部一致才保留一份，否则抛错。
 */
export function mergeWhitelistFields(perSegment: ExtractedField[][]): ExtractedField[] {
  const merged: ExtractedField[] = [];
  for (const fields of perSegment) {
    for (const field of fields) {
      const existing = merged.find((f) => f.tag === field.tag);
      if (existing === undefined) {
        merged.push(field);
        continue;
      }
      if (
        existing.type !== field.type ||
        existing.count !== field.count ||
        !valuesEqual(existing.value, field.value)
      ) {
        fail(
          "conflict",
          `保留字段 ${field.name} 在多个 EXIF 段中冲突`,
        );
      }
    }
  }
  return merged;
}
