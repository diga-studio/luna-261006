import type { ExtractedField } from "./exif.js";

const EXIF_IFD_POINTER = 0x8769;
const IFD0_TAGS: ReadonlySet<number> = new Set([0x010f, 0x0110, 0x0112]);

interface OutEntry {
  tag: number;
  type: number;
  count: number;
  data: Uint8Array;
}

/** 字段源字节序与输出不一致时，按解码值重新编码（值不变，仅转换字节序）。 */
function reencode(field: ExtractedField, le: boolean): Uint8Array {
  const v = field.value;
  const out = new Uint8Array(field.count * typeSize(field.type));
  const view = new DataView(out.buffer);
  switch (v.kind) {
    case "ascii": {
      for (let i = 0; i < field.count; i++) {
        out[i] = i < v.text.length ? v.text.charCodeAt(i) & 0xff : 0;
      }
      return out;
    }
    case "uint":
    case "int": {
      for (let i = 0; i < field.count; i++) {
        const x = v.values[i]!;
        if (field.type === 1 || field.type === 7) view.setUint8(i, x);
        else if (field.type === 6) view.setInt8(i, x);
        else if (field.type === 3) view.setUint16(i * 2, x, le);
        else if (field.type === 8) view.setInt16(i * 2, x, le);
        else if (field.type === 4) view.setUint32(i * 4, x, le);
        else view.setInt32(i * 4, x, le);
      }
      return out;
    }
    case "rational": {
      for (let i = 0; i < field.count; i++) {
        const [n, d] = v.values[i]!;
        if (field.type === 10) {
          view.setInt32(i * 8, n, le);
          view.setInt32(i * 8 + 4, d, le);
        } else {
          view.setUint32(i * 8, n, le);
          view.setUint32(i * 8 + 4, d, le);
        }
      }
      return out;
    }
    case "float": {
      for (let i = 0; i < field.count; i++) {
        const x = v.values[i]!;
        if (field.type === 11) view.setFloat32(i * 4, x, le);
        else view.setFloat64(i * 8, x, le);
      }
      return out;
    }
  }
}

function typeSize(type: number): number {
  const sizes: Record<number, number> = {
    1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8,
  };
  return sizes[type] ?? 1;
}

function fieldBytes(field: ExtractedField, le: boolean): Uint8Array {
  if (field.littleEndian === le) return field.rawValue;
  return reencode(field, le);
}

function serializeIfd(
  le: boolean,
  entries: OutEntry[],
  dataBase: number,
  nextIfdOffset: number,
  out: Uint8Array,
  at: number,
): number {
  const view = new DataView(out.buffer);
  view.setUint16(at, entries.length, le);
  let cursor = at + 2 + entries.length * 12;
  let dataCursor = dataBase;
  entries.forEach((e, i) => {
    const p = at + 2 + i * 12;
    view.setUint16(p, e.tag, le);
    view.setUint16(p + 2, e.type, le);
    view.setUint32(p + 4, e.count, le);
    if (e.data.length <= 4) {
      out.set(e.data, p + 8);
    } else {
      view.setUint32(p + 8, dataCursor, le);
      out.set(e.data, dataCursor);
      dataCursor += e.data.length;
    }
  });
  view.setUint32(cursor, nextIfdOffset, le);
  return dataCursor;
}

/**
 * 由白名单字段重建一个经典 TIFF 格式的 EXIF 段负载（含 "Exif\0\0" 头）。
 * 字节序取第一个字段的源字节序；同字节序字段的值逐字节拷贝。
 * 只含 IFD0（Make/Model/Orientation + ExifIFD 指针）与 ExifIFD，无其他区域。
 */
export function buildExifPayload(fields: ExtractedField[]): Uint8Array {
  const le = fields[0]?.littleEndian ?? true;
  const ifd0Fields = fields
    .filter((f) => IFD0_TAGS.has(f.tag))
    .sort((a, b) => a.tag - b.tag);
  const exifFields = fields
    .filter((f) => !IFD0_TAGS.has(f.tag))
    .sort((a, b) => a.tag - b.tag);

  const ifd0Entries: OutEntry[] = ifd0Fields.map((f) => ({
    tag: f.tag,
    type: f.type,
    count: f.count,
    data: fieldBytes(f, le),
  }));
  const exifEntries: OutEntry[] = exifFields.map((f) => ({
    tag: f.tag,
    type: f.type,
    count: f.count,
    data: fieldBytes(f, le),
  }));

  const ifd0Len = 2 + (ifd0Entries.length + (exifEntries.length > 0 ? 1 : 0)) * 12 + 4;
  const ifd0DataBase = 8 + ifd0Len;
  const ifd0DataLen = ifd0Entries.reduce((n, e) => n + (e.data.length > 4 ? e.data.length : 0), 0);
  const exifIfdOffset = exifEntries.length > 0 ? ifd0DataBase + ifd0DataLen : 0;
  const exifLen = exifEntries.length > 0 ? 2 + exifEntries.length * 12 + 4 : 0;
  const exifDataBase = exifIfdOffset + exifLen;
  const exifDataLen = exifEntries.reduce((n, e) => n + (e.data.length > 4 ? e.data.length : 0), 0);
  const total = 8 + ifd0Len + ifd0DataLen + exifLen + exifDataLen;

  const tiff = new Uint8Array(total);
  const view = new DataView(tiff.buffer);
  tiff[0] = le ? 0x49 : 0x4d;
  tiff[1] = le ? 0x49 : 0x4d;
  view.setUint16(2, 42, le);
  view.setUint32(4, 8, le);

  const entries0: OutEntry[] = [...ifd0Entries];
  if (exifEntries.length > 0) {
    const ptr = new Uint8Array(4);
    new DataView(ptr.buffer).setUint32(0, exifIfdOffset, le);
    entries0.push({ tag: EXIF_IFD_POINTER, type: 4, count: 1, data: ptr });
    entries0.sort((a, b) => a.tag - b.tag);
  }
  serializeIfd(le, entries0, ifd0DataBase, 0, tiff, 8);
  if (exifEntries.length > 0) {
    serializeIfd(le, exifEntries, exifDataBase, 0, tiff, exifIfdOffset);
  }

  const header = new Uint8Array(6);
  header.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]);
  const payload = new Uint8Array(6 + tiff.length);
  payload.set(header, 0);
  payload.set(tiff, 6);
  return payload;
}
