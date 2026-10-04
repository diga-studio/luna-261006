import { Mp3ProbeError } from './errors';

export interface XingInfo {
  readonly declaredFrames: number | null;
  readonly declaredBytes: number | null;
  readonly encoderDelay: number;
  readonly endPadding: number;
}

function readU32(buf: Uint8Array, off: number): number {
  return ((buf[off]! << 24) | (buf[off + 1]! << 16) | (buf[off + 2]! << 8) | buf[off + 3]!) >>> 0;
}

function isTag(buf: Uint8Array, off: number, a: number, b: number, c: number, d: number): boolean {
  return buf[off] === a && buf[off + 1] === b && buf[off + 2] === c && buf[off + 3] === d;
}

// Parses the first MPEG frame (header + body). Returns null when no Xing/Info
// marker sits at the standard offset; throws on malformed Xing metadata.
export function parseXing(frame: Uint8Array, channelMode: number): XingInfo | null {
  const sideInfo = channelMode === 3 ? 17 : 32;
  const base = 4 + sideInfo;
  if (frame.length < base + 4) {
    return null;
  }
  const isXing = isTag(frame, base, 0x58, 0x69, 0x6e, 0x67); // "Xing"
  const isInfo = isTag(frame, base, 0x49, 0x6e, 0x66, 0x6f); // "Info"
  if (!isXing && !isInfo) {
    return null;
  }
  let off = base + 4;
  const need = (n: number): void => {
    if (frame.length < off + n) {
      throw new Mp3ProbeError('XING_INVALID', 'truncated Xing header');
    }
  };
  need(4);
  const flags = readU32(frame, off);
  off += 4;
  if (flags & ~0xf) {
    throw new Mp3ProbeError('XING_INVALID', 'unknown Xing flags');
  }
  let declaredFrames: number | null = null;
  let declaredBytes: number | null = null;
  if (flags & 0x1) {
    need(4);
    declaredFrames = readU32(frame, off);
    off += 4;
  }
  if (flags & 0x2) {
    need(4);
    declaredBytes = readU32(frame, off);
    off += 4;
  }
  if (flags & 0x4) {
    need(100);
    off += 100;
  }
  if (flags & 0x8) {
    need(4);
    off += 4;
  }
  need(36);
  if (!isTag(frame, off, 0x4c, 0x41, 0x4d, 0x45)) { // "LAME"
    throw new Mp3ProbeError('XING_INVALID', 'missing LAME extension');
  }
  const d21 = frame[off + 21]!;
  const d22 = frame[off + 22]!;
  const d23 = frame[off + 23]!;
  const encoderDelay = (d21 << 4) | (d22 >> 4);
  const endPadding = ((d22 & 0xf) << 8) | d23;
  return { declaredFrames, declaredBytes, encoderDelay, endPadding };
}
