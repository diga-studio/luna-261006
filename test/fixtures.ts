/** 测试夹具：程序化构造 JPEG / TIFF / EXIF 字节。 */

export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function bytes(...vals: number[]): Uint8Array {
  return new Uint8Array(vals);
}

/** 构造一个长度前缀标记段（不含前导 0xFF 填充）。 */
export function segment(marker: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  out[0] = 0xff;
  out[1] = marker;
  out[2] = (payload.length + 2) >> 8;
  out[3] = (payload.length + 2) & 0xff;
  out.set(payload, 4);
  return out;
}

export function markerOnly(marker: number): Uint8Array {
  return bytes(0xff, marker);
}

// ---------- TIFF / EXIF ----------

export interface EntrySpec {
  tag: number;
  type: number;
  count: number;
  /** 已按目标字节序编码的原始值字节。 */
  data: Uint8Array;
  /** 即使 <=4 字节也强制放入偏移区。 */
  forceOffset?: boolean;
}

function u16enc(le: boolean, v: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, v, le);
  return b;
}

function u32enc(le: boolean, v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v, le);
  return b;
}

export function eRaw(tag: number, type: number, count: number, data: Uint8Array, forceOffset = false): EntrySpec {
  return forceOffset ? { tag, type, count, data, forceOffset } : { tag, type, count, data };
}

export function eAscii(le: boolean, tag: number, text: string): EntrySpec {
  const data = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) data[i] = text.charCodeAt(i) & 0xff;
  return { tag, type: 2, count: text.length, data };
}

export function eShort(le: boolean, tag: number, ...vals: number[]): EntrySpec {
  const data = new Uint8Array(vals.length * 2);
  const v = new DataView(data.buffer);
  vals.forEach((x, i) => v.setUint16(i * 2, x, le));
  return { tag, type: 3, count: vals.length, data };
}

export function eLong(le: boolean, tag: number, ...vals: number[]): EntrySpec {
  const data = new Uint8Array(vals.length * 4);
  const v = new DataView(data.buffer);
  vals.forEach((x, i) => v.setUint32(i * 4, x, le));
  return { tag, type: 4, count: vals.length, data };
}

export function eRational(le: boolean, tag: number, ...vals: Array<[number, number]>): EntrySpec {
  const data = new Uint8Array(vals.length * 8);
  const v = new DataView(data.buffer);
  vals.forEach(([n, d], i) => {
    v.setUint32(i * 8, n, le);
    v.setUint32(i * 8 + 4, d, le);
  });
  return { tag, type: 5, count: vals.length, data };
}

export interface TiffSpec {
  littleEndian?: boolean;
  ifd0: EntrySpec[];
  /** 存在时自动在 IFD0 加入 0x8825 GPSInfo 指针。 */
  gps?: EntrySpec[];
  /** 存在时自动在 IFD0 加入 0x8769 ExifIFD 指针。 */
  exifIfd?: EntrySpec[];
  /** IFD1（缩略图目录）。thumbnail 存在时自动加入 0x0201/0x0202。 */
  ifd1?: { entries: EntrySpec[]; thumbnail?: Uint8Array };
}

const TYPE_SIZE: Record<number, number> = {
  1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8,
};

function entryFitsInline(e: EntrySpec): boolean {
  return !e.forceOffset && e.data.length <= 4;
}

/** 序列化一个 IFD，返回 { ifdBytes, dataBytes }，data 区偏移基于 dataBase。 */
function serializeIfd(
  le: boolean,
  entries: EntrySpec[],
  dataBase: number,
  nextIfdOffset: number,
): { ifdBytes: Uint8Array; dataBytes: Uint8Array } {
  const ifdLen = 2 + entries.length * 12 + 4;
  const ifdBytes = new Uint8Array(ifdLen);
  const view = new DataView(ifdBytes.buffer);
  view.setUint16(0, entries.length, le);
  const dataParts: Uint8Array[] = [];
  let dataCursor = dataBase;
  entries.forEach((e, i) => {
    const at = 2 + i * 12;
    view.setUint16(at, e.tag, le);
    view.setUint16(at + 2, e.type, le);
    view.setUint32(at + 4, e.count, le);
    if (entryFitsInline(e)) {
      ifdBytes.set(e.data, at + 8);
    } else {
      view.setUint32(at + 8, dataCursor, le);
      dataParts.push(u32pad(e.data));
      dataCursor += u32pad(e.data).length;
    }
  });
  view.setUint32(2 + entries.length * 12, nextIfdOffset, le);
  return { ifdBytes, dataBytes: concat(...dataParts) };
}

function u32pad(b: Uint8Array): Uint8Array {
  return b;
}

/** 构造经典 TIFF 字节（含 8 字节头）。 */
export function buildTiff(spec: TiffSpec): Uint8Array {
  const le = spec.littleEndian ?? false;
  const header = new Uint8Array(8);
  const hv = new DataView(header.buffer);
  header[0] = le ? 0x49 : 0x4d;
  header[1] = le ? 0x49 : 0x4d;
  hv.setUint16(2, 42, le);
  hv.setUint32(4, 8, le);

  // 指针条目
  const ifd0 = [...spec.ifd0];
  if (spec.exifIfd) ifd0.push(eLong(le, 0x8769, 0)); // 占位，稍后填偏移
  if (spec.gps) ifd0.push(eLong(le, 0x8825, 0));
  ifd0.sort((a, b) => a.tag - b.tag);

  const ifd0Len = 2 + ifd0.length * 12 + 4;
  const ifd0DataBase = 8 + ifd0Len;
  const ifd0DataLen = ifd0.filter((e) => !entryFitsInline(e)).reduce((n, e) => n + e.data.length, 0);

  let cursor = ifd0DataBase + ifd0DataLen;
  const exifOff = spec.exifIfd ? cursor : 0;
  if (spec.exifIfd) {
    cursor += 2 + spec.exifIfd.length * 12 + 4;
    cursor += spec.exifIfd.filter((e) => !entryFitsInline(e)).reduce((n, e) => n + e.data.length, 0);
  }
  const gpsOff = spec.gps ? cursor : 0;
  if (spec.gps) {
    cursor += 2 + spec.gps.length * 12 + 4;
    cursor += spec.gps.filter((e) => !entryFitsInline(e)).reduce((n, e) => n + e.data.length, 0);
  }
  const ifd1Off = spec.ifd1 ? cursor : 0;

  // 回填指针
  for (const e of ifd0) {
    if (e.tag === 0x8769 && spec.exifIfd) e.data = u32enc(le, exifOff);
    if (e.tag === 0x8825 && spec.gps) e.data = u32enc(le, gpsOff);
  }

  const parts: Uint8Array[] = [header];
  const ifd0Ser = serializeIfd(le, ifd0, ifd0DataBase, ifd1Off);
  parts.push(ifd0Ser.ifdBytes, ifd0Ser.dataBytes);

  if (spec.exifIfd) {
    const base = exifOff + 2 + spec.exifIfd.length * 12 + 4;
    const ser = serializeIfd(le, spec.exifIfd, base, 0);
    parts.push(ser.ifdBytes, ser.dataBytes);
  }
  if (spec.gps) {
    const base = gpsOff + 2 + spec.gps.length * 12 + 4;
    const ser = serializeIfd(le, spec.gps, base, 0);
    parts.push(ser.ifdBytes, ser.dataBytes);
  }
  if (spec.ifd1) {
    const entries = [...spec.ifd1.entries];
    const thumb = spec.ifd1.thumbnail;
    const ifd1Len = 2 + (entries.length + (thumb ? 2 : 0)) * 12 + 4;
    const ifd1DataBase = ifd1Off + ifd1Len;
    const ifd1DataLen = entries.filter((e) => !entryFitsInline(e)).reduce((n, e) => n + e.data.length, 0);
    if (thumb) {
      entries.push(eLong(le, 0x0201, ifd1DataBase + ifd1DataLen));
      entries.push(eLong(le, 0x0202, thumb.length));
    }
    entries.sort((a, b) => a.tag - b.tag);
    const ser = serializeIfd(le, entries, ifd1DataBase, 0);
    parts.push(ser.ifdBytes, ser.dataBytes);
    if (thumb) parts.push(thumb);
  }
  return concat(...parts);
}

/** 构造 APP1 EXIF 段。 */
export function exifSegment(tiff: Uint8Array): Uint8Array {
  const header = new Uint8Array(6);
  header.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]); // "Exif\0\0"
  return segment(0xe1, concat(header, tiff));
}

/** 构造 JFIF APP0 段，可带缩略图。 */
export function jfifSegment(opts: { thumbnail?: Uint8Array; version?: [number, number]; units?: number; xdensity?: number; ydensity?: number } = {}): Uint8Array {
  const thumb = opts.thumbnail ?? new Uint8Array();
  const payload = new Uint8Array(14 + thumb.length);
  payload.set([0x4a, 0x46, 0x49, 0x46, 0x00]); // "JFIF\0"
  payload[5] = opts.version?.[0] ?? 1;
  payload[6] = opts.version?.[1] ?? 1;
  payload[7] = opts.units ?? 1;
  new DataView(payload.buffer).setUint16(8, opts.xdensity ?? 72);
  new DataView(payload.buffer).setUint16(10, opts.ydensity ?? 72);
  payload[12] = thumb.length > 0 ? Math.floor(thumb.length / 3) : 0;
  payload[13] = thumb.length > 0 ? 1 : 0;
  payload.set(thumb, 14);
  return segment(0xe0, payload);
}

/** 构造分段 ICC APP2。chunks 按顺序编号 1..n。 */
export function iccSegments(chunks: Uint8Array[]): Uint8Array[] {
  return chunks.map((chunk, i) => {
    const header = new Uint8Array(14);
    header.set([0x49, 0x43, 0x43, 0x5f, 0x50, 0x52, 0x4f, 0x46, 0x49, 0x4c, 0x45, 0x00]); // "ICC_PROFILE\0"
    header[12] = i + 1;
    header[13] = chunks.length;
    return segment(0xe2, concat(header, chunk));
  });
}

/** 构造 Adobe APP14 段。 */
export function adobeSegment(transform: number): Uint8Array {
  const payload = new Uint8Array(12);
  payload.set([0x41, 0x64, 0x6f, 0x62, 0x65]); // "Adobe"
  new DataView(payload.buffer).setUint16(5, 100);
  new DataView(payload.buffer).setUint16(7, 0);
  new DataView(payload.buffer).setUint16(9, 0);
  payload[11] = transform;
  return segment(0xee, payload);
}

// ---------- 最小 JPEG ----------

export const DQT = segment(0xdb, new Uint8Array(65).fill(1));
export const DHT = segment(0xc4, concat(bytes(0x00, 1), new Uint8Array(16)));

export function sof(marker: number, width = 8, height = 8): Uint8Array {
  const payload = bytes(8, 0, height, 0, width, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1);
  return segment(marker, payload);
}

export const SOS = segment(0xda, bytes(3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0));

/** 最小基线 JPEG：SOI + 附加段 + SOF0 + SOS + 扫描数据 + EOI。 */
export function minimalJpeg(extraSegments: Uint8Array[] = [], scanData?: Uint8Array): Uint8Array {
  const scan = scanData ?? bytes(0x11, 0x22, 0xff, 0x00, 0x33, 0xff, 0xd0, 0x44);
  return concat(
    markerOnly(0xd8),
    ...extraSegments,
    DQT,
    sof(0xc0),
    DHT,
    SOS,
    scan,
    markerOnly(0xd9),
  );
}
