/** Helpers to build synthetic JPEG/TIFF byte streams for tests. */

export function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) {
    total += p.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    out[i] = text.charCodeAt(i) & 0xff;
  }
  return out;
}

export function seg(marker: number, data: Uint8Array): Uint8Array {
  const length = data.length + 2;
  const out = new Uint8Array(2 + 2 + data.length);
  out[0] = 0xff;
  out[1] = marker;
  out[2] = (length >> 8) & 0xff;
  out[3] = length & 0xff;
  out.set(data, 4);
  return out;
}

export const SOI = new Uint8Array([0xff, 0xd8]);
export const EOI = new Uint8Array([0xff, 0xd9]);

export function jpeg(...parts: Uint8Array[]): Uint8Array {
  return concat(SOI, ...parts, EOI);
}

export function appn(n: number, data: Uint8Array): Uint8Array {
  return seg(0xe0 + n, data);
}

export function com(text: string): Uint8Array {
  return seg(0xfe, ascii(text));
}

export function exifApp1(tiff: Uint8Array): Uint8Array {
  return appn(1, concat(ascii("Exif\0\0"), tiff));
}

export function xmpApp1(text: string): Uint8Array {
  return appn(1, concat(ascii("http://ns.adobe.com/xap/1.0/\0"), ascii(text)));
}

export function jfifApp0(options: { thumbnail?: Uint8Array } = {}): Uint8Array {
  const thumb = options.thumbnail ?? new Uint8Array(0);
  if (thumb.length % 3 !== 0) {
    throw new Error("thumbnail byte length must be a multiple of 3");
  }
  const thumbX = thumb.length === 0 ? 0 : 1;
  const thumbY = thumb.length === 0 ? 0 : thumb.length / 3;
  const data = new Uint8Array(14 + thumb.length);
  data.set(ascii("JFIF\0"), 0);
  data[5] = 1;
  data[6] = 2;
  data[7] = 1; // units: dpi
  data[8] = 0;
  data[9] = 72;
  data[10] = 0;
  data[11] = 72;
  data[12] = thumbX;
  data[13] = thumbY;
  data.set(thumb, 14);
  return appn(0, data);
}

export function jfxxApp0(thumbnail: Uint8Array): Uint8Array {
  return appn(0, concat(ascii("JFXX\0\x10"), thumbnail));
}

export function iccApp2(seq: number, count: number, profile: Uint8Array): Uint8Array {
  const data = new Uint8Array(14 + profile.length);
  data.set(ascii("ICC_PROFILE\0"), 0);
  data[12] = seq;
  data[13] = count;
  data.set(profile, 14);
  return appn(2, data);
}

export function adobeApp14(transform: number): Uint8Array {
  const data = new Uint8Array(12);
  data.set(ascii("Adobe"), 0);
  data[5] = 0;
  data[6] = 100;
  data[11] = transform;
  return appn(14, data);
}

export function dqt(): Uint8Array {
  const data = new Uint8Array(65);
  data[0] = 0;
  for (let i = 1; i < 65; i += 1) {
    data[i] = i & 0xff;
  }
  return seg(0xdb, data);
}

export function dht(): Uint8Array {
  const data = new Uint8Array(2 + 16 + 4);
  data[0] = 0x00;
  data[1] = 1;
  data[18] = 0;
  data[19] = 1;
  data[20] = 2;
  data[21] = 3;
  return seg(0xc4, data);
}

export function sof(marker: 0xc0 | 0xc2, width: number, height: number): Uint8Array {
  const data = new Uint8Array(6 + 3 * 3);
  data[0] = 8; // precision
  data[1] = (height >> 8) & 0xff;
  data[2] = height & 0xff;
  data[3] = (width >> 8) & 0xff;
  data[4] = width & 0xff;
  data[5] = 3;
  for (let c = 0; c < 3; c += 1) {
    data[6 + c * 3] = c + 1;
    data[7 + c * 3] = 0x11;
    data[8 + c * 3] = 0;
  }
  return seg(marker, data);
}

export function sos(entropy: Uint8Array): Uint8Array {
  const header = new Uint8Array(6 + 3 * 3 - 3);
  header[0] = 3;
  for (let c = 0; c < 3; c += 1) {
    header[1 + c * 2] = c + 1;
    header[2 + c * 2] = 0;
  }
  header[7] = 0;
  header[8] = 63;
  header[9] = 0;
  return concat(seg(0xda, header), entropy);
}

export interface TiffEntrySpec {
  tag: number;
  type: number;
  count: number;
  value: Uint8Array;
}

export interface TiffSpec {
  byteOrder: "II" | "MM";
  ifd0: TiffEntrySpec[];
  exifIfd?: TiffEntrySpec[];
  gpsIfd?: TiffEntrySpec[];
  ifd1?: TiffEntrySpec[];
  /** Embedded thumbnail bytes; referenced from IFD1 automatically. */
  thumbnail?: Uint8Array;
  /** Extra unreachable garbage appended after all referenced data. */
  trailingGarbage?: Uint8Array;
}

export function tiffValues(order: "II" | "MM"): {
  short: (...nums: number[]) => Uint8Array;
  long: (...nums: number[]) => Uint8Array;
  rational: (...pairs: Array<[number, number]>) => Uint8Array;
  ascii: (text: string) => Uint8Array;
} {
  const little = order === "II";
  const push16 = (out: number[], v: number) => {
    if (little) {
      out.push(v & 0xff, (v >> 8) & 0xff);
    } else {
      out.push((v >> 8) & 0xff, v & 0xff);
    }
  };
  const push32 = (out: number[], v: number) => {
    if (little) {
      out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
    } else {
      out.push((v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
    }
  };
  return {
    short: (...nums) => {
      const out: number[] = [];
      nums.forEach((n) => push16(out, n));
      return new Uint8Array(out);
    },
    long: (...nums) => {
      const out: number[] = [];
      nums.forEach((n) => push32(out, n));
      return new Uint8Array(out);
    },
    rational: (...pairs) => {
      const out: number[] = [];
      pairs.forEach(([n, d]) => {
        push32(out, n);
        push32(out, d);
      });
      return new Uint8Array(out);
    },
    ascii: (text) => concat(ascii(text), new Uint8Array([0])),
  };
}

const TYPE_SIZES: Record<number, number> = {
  1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8,
};

interface IfdLayout {
  entries: TiffEntrySpec[];
  offset: number;
}

/** Builds a classic TIFF payload with IFD0, optional sub-IFDs and IFD1. */
export function buildTiff(spec: TiffSpec): Uint8Array {
  const little = spec.byteOrder === "II";
  const ifd0Entries = [...spec.ifd0];
  if (spec.exifIfd !== undefined) {
    ifd0Entries.push({ tag: 0x8769, type: 4, count: 1, value: new Uint8Array(4) });
  }
  if (spec.gpsIfd !== undefined) {
    ifd0Entries.push({ tag: 0x8825, type: 4, count: 1, value: new Uint8Array(4) });
  }
  ifd0Entries.sort((a, b) => a.tag - b.tag);

  const sections: IfdLayout[] = [{ entries: ifd0Entries, offset: 8 }];
  if (spec.exifIfd !== undefined) {
    sections.push({ entries: [...spec.exifIfd].sort((a, b) => a.tag - b.tag), offset: 0 });
  }
  if (spec.gpsIfd !== undefined) {
    sections.push({ entries: [...spec.gpsIfd].sort((a, b) => a.tag - b.tag), offset: 0 });
  }
  const ifd1Entries = spec.ifd1 !== undefined ? [...spec.ifd1] : undefined;
  if (spec.thumbnail !== undefined && ifd1Entries !== undefined) {
    ifd1Entries.push({ tag: 0x0201, type: 4, count: 1, value: new Uint8Array(4) });
    ifd1Entries.push({
      tag: 0x0202,
      type: 4,
      count: 1,
      value: tiffValues(spec.byteOrder).long(spec.thumbnail.length),
    });
    ifd1Entries.sort((a, b) => a.tag - b.tag);
  }
  if (ifd1Entries !== undefined) {
    sections.push({ entries: ifd1Entries, offset: 0 });
  }

  // Assign IFD offsets.
  let cursor = 8;
  for (const section of sections) {
    section.offset = cursor;
    cursor += 2 + 12 * section.entries.length + 4;
  }
  if (cursor % 2 !== 0) {
    cursor += 1;
  }

  // Assign value-area offsets for out-of-line values, in section order.
  const valueOffsets = new Map<TiffEntrySpec, number>();
  for (const section of sections) {
    for (const entry of section.entries) {
      const size = (TYPE_SIZES[entry.type] ?? 1) * entry.count;
      if (size > 4) {
        valueOffsets.set(entry, cursor);
        cursor += size;
        if (cursor % 2 !== 0) {
          cursor += 1;
        }
      }
    }
  }
  const thumbnailOffset = spec.thumbnail !== undefined ? cursor : 0;
  if (spec.thumbnail !== undefined) {
    cursor += spec.thumbnail.length;
    if (cursor % 2 !== 0) {
      cursor += 1;
    }
  }
  const totalLength = cursor + (spec.trailingGarbage?.length ?? 0);

  const out = new Uint8Array(totalLength);
  const view = new DataView(out.buffer);
  out[0] = little ? 0x49 : 0x4d;
  out[1] = little ? 0x49 : 0x4d;
  view.setUint16(2, 42, little);
  view.setUint32(4, 8, little);

  const writeEntry = (offset: number, entry: TiffEntrySpec, valueOverride?: number) => {
    view.setUint16(offset, entry.tag, little);
    view.setUint16(offset + 2, entry.type, little);
    view.setUint32(offset + 4, entry.count, little);
    const size = (TYPE_SIZES[entry.type] ?? 1) * entry.count;
    if (valueOverride !== undefined) {
      view.setUint32(offset + 8, valueOverride, little);
    } else if (size <= 4) {
      out.set(entry.value.subarray(0, size), offset + 8);
    } else {
      view.setUint32(offset + 8, valueOffsets.get(entry)!, little);
      out.set(entry.value.subarray(0, size), valueOffsets.get(entry)!);
    }
  };

  sections.forEach((section, sectionIndex) => {
    view.setUint16(section.offset, section.entries.length, little);
    section.entries.forEach((entry, i) => {
      const entryOffset = section.offset + 2 + i * 12;
      if (sectionIndex === 0 && entry.tag === 0x8769) {
        writeEntry(entryOffset, entry, sections[1]!.offset);
      } else if (sectionIndex === 0 && entry.tag === 0x8825) {
        const gpsIndex = spec.exifIfd !== undefined ? 2 : 1;
        writeEntry(entryOffset, entry, sections[gpsIndex]!.offset);
      } else if (entry.tag === 0x0201 && spec.thumbnail !== undefined) {
        writeEntry(entryOffset, entry, thumbnailOffset);
      } else {
        writeEntry(entryOffset, entry);
      }
    });
    const nextOffset =
      sectionIndex === 0 && ifd1Entries !== undefined
        ? sections[sections.length - 1]!.offset
        : 0;
    view.setUint32(section.offset + 2 + 12 * section.entries.length, nextOffset, little);
  });

  if (spec.thumbnail !== undefined) {
    out.set(spec.thumbnail, thumbnailOffset);
  }
  if (spec.trailingGarbage !== undefined) {
    out.set(spec.trailingGarbage, cursor);
  }
  return out;
}

export function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        continue outer;
      }
    }
    return i;
  }
  return -1;
}

export function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  return indexOfBytes(haystack, needle) >= 0;
}

/** Minimal independent JPEG walker used by tests to extract segments. */
export function walkSegments(bytes: Uint8Array): Array<{ marker: number; data: Uint8Array; scanData?: Uint8Array }> {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error("not a JPEG");
  }
  const out: Array<{ marker: number; data: Uint8Array; scanData?: Uint8Array }> = [];
  let pos = 2;
  for (;;) {
    while (bytes[pos] === 0xff) {
      pos += 1;
    }
    const marker = bytes[pos]!;
    pos += 1;
    if (marker === 0xd9) {
      return out;
    }
    const length = (bytes[pos]! << 8) | bytes[pos + 1]!;
    const data = bytes.subarray(pos + 2, pos + length);
    pos += length;
    const element: { marker: number; data: Uint8Array; scanData?: Uint8Array } = { marker, data };
    if (marker === 0xda) {
      const start = pos;
      for (;;) {
        if (bytes[pos] === 0xff) {
          let runEnd = pos;
          while (bytes[runEnd] === 0xff) {
            runEnd += 1;
          }
          const code = bytes[runEnd]!;
          if (code !== 0x00 && !(code >= 0xd0 && code <= 0xd7)) {
            element.scanData = bytes.subarray(start, runEnd - 1);
            pos = runEnd - 1;
            break;
          }
          pos = runEnd + 1;
        } else {
          pos += 1;
        }
      }
    }
    out.push(element);
  }
}
