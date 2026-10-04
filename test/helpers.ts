export interface FrameOptions {
  bitrateKbps?: number;
  sampleRate?: number;
  padding?: number;
  channelMode?: number;
}

const BITRATE_INDEX: Record<number, number> = {
  32: 1, 40: 2, 48: 3, 56: 4, 64: 5, 80: 6, 96: 7,
  112: 8, 128: 9, 160: 10, 192: 11, 224: 12, 256: 13, 320: 14,
};
const SAMPLE_RATE_INDEX: Record<number, number> = { 44100: 0, 48000: 1, 32000: 2 };

export function frameLength(opts: FrameOptions): number {
  const br = (opts.bitrateKbps ?? 128) * 1000;
  const sr = opts.sampleRate ?? 44100;
  return Math.floor((144 * br) / sr) + (opts.padding ?? 0);
}

export function makeFrameHeader(opts: FrameOptions): Uint8Array {
  const b0 = 0xff;
  const b1 = 0xe0 | 0x18 | 0x02 | 0x01; // sync | MPEG-1 | Layer III | no CRC
  const b2 = (BITRATE_INDEX[opts.bitrateKbps ?? 128]! << 4)
    | (SAMPLE_RATE_INDEX[opts.sampleRate ?? 44100]! << 2)
    | ((opts.padding ?? 0) << 1);
  const b3 = (opts.channelMode ?? 0) << 6;
  return new Uint8Array([b0, b1, b2, b3]);
}

// Builds a full frame. Body bytes cycle through a pattern containing
// pseudo-sync sequences (0xFF 0xFB) that must not be treated as frames.
export function makeFrame(opts: FrameOptions = {}): Uint8Array {
  const len = frameLength(opts);
  const out = new Uint8Array(len);
  out.set(makeFrameHeader(opts), 0);
  for (let i = 4; i < len; i++) {
    out[i] = i % 3 === 0 ? 0xff : 0xfb;
  }
  return out;
}

export interface XingOptions extends FrameOptions {
  declaredFrames?: number;
  declaredBytes?: number;
  encoderDelay?: number;
  endPadding?: number;
  includeToc?: boolean;
  includeQuality?: boolean;
  tag?: 'Xing' | 'Info';
}

export function makeXingFrame(opts: XingOptions = {}): Uint8Array {
  const frameOpts: FrameOptions = { ...opts, padding: 0 };
  const len = frameLength(frameOpts);
  const out = makeFrame(frameOpts);
  const sideInfo = (opts.channelMode ?? 0) === 3 ? 17 : 32;
  let off = 4 + sideInfo;
  const tag = opts.tag ?? 'Xing';
  for (let i = 0; i < 4; i++) out[off + i] = tag.charCodeAt(i);
  off += 4;
  let flags = 0;
  if (opts.declaredFrames !== undefined) flags |= 1;
  if (opts.declaredBytes !== undefined) flags |= 2;
  if (opts.includeToc) flags |= 4;
  if (opts.includeQuality) flags |= 8;
  writeU32(out, off, flags); off += 4;
  if (flags & 1) { writeU32(out, off, opts.declaredFrames!); off += 4; }
  if (flags & 2) { writeU32(out, off, opts.declaredBytes!); off += 4; }
  if (flags & 4) { for (let i = 0; i < 100; i++) out[off + i] = i; off += 100; }
  if (flags & 8) { writeU32(out, off, 42); off += 4; }
  out.set([0x4c, 0x41, 0x4d, 0x45], off); // "LAME"
  const delay = opts.encoderDelay ?? 0;
  const padding = opts.endPadding ?? 0;
  out[off + 21] = (delay >> 4) & 0xff;
  out[off + 22] = ((delay & 0xf) << 4) | ((padding >> 8) & 0xf);
  out[off + 23] = padding & 0xff;
  return out;
}

function writeU32(buf: Uint8Array, off: number, v: number): void {
  buf[off] = (v >>> 24) & 0xff;
  buf[off + 1] = (v >>> 16) & 0xff;
  buf[off + 2] = (v >>> 8) & 0xff;
  buf[off + 3] = v & 0xff;
}

export function makeId3v2Header(bodyLength: number, version = 4, footer = false): Uint8Array {
  const h = new Uint8Array(10);
  h[0] = 0x49; h[1] = 0x44; h[2] = 0x33;
  h[3] = version;
  h[5] = footer ? 0x10 : 0;
  h[6] = (bodyLength >>> 21) & 0x7f;
  h[7] = (bodyLength >>> 14) & 0x7f;
  h[8] = (bodyLength >>> 7) & 0x7f;
  h[9] = bodyLength & 0x7f;
  return h;
}

export function makeId3v2Footer(bodyLength: number, version = 4): Uint8Array {
  const f = makeId3v2Header(bodyLength, version, true);
  f[0] = 0x33; f[1] = 0x44; f[2] = 0x49; // "3DI"
  return f;
}

// ID3v1 tag whose body is stuffed with pseudo-sync bytes.
export function makeId3v1(): Uint8Array {
  const t = new Uint8Array(128);
  t[0] = 0x54; t[1] = 0x41; t[2] = 0x47; // "TAG"
  for (let i = 3; i < 128; i++) {
    t[i] = i % 2 === 0 ? 0xff : 0xfb;
  }
  return t;
}

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
