import { Mp3ProbeError } from "./errors";

export interface XingInfo {
  /** Declared audio frame count, if the frames flag was set. */
  declaredFrames: number | null;
  /** Declared MPEG stream byte count, if the bytes flag was set. */
  declaredBytes: number | null;
  encoderDelay: number;
  endPadding: number;
  /** Total bytes from the marker to the end of the LAME extension. */
  totalLength: number;
}

const FLAG_FRAMES = 0x01;
const FLAG_BYTES = 0x02;
const FLAG_TOC = 0x04;
const FLAG_QUALITY = 0x08;
const LAME_EXT_LEN = 36;

/** Bytes after the 4-byte marker: flags word + optional fields + LAME ext. */
export function xingBodyLength(flags: number): number {
  if (flags & ~0x0f) {
    throw new Mp3ProbeError("ERR_XING", "unknown Xing flags");
  }
  let len = 4 + LAME_EXT_LEN;
  if (flags & FLAG_FRAMES) len += 4;
  if (flags & FLAG_BYTES) len += 4;
  if (flags & FLAG_TOC) len += 100;
  if (flags & FLAG_QUALITY) len += 4;
  return len;
}

function u32(buf: Uint8Array, off: number): number {
  return (
    ((buf[off]! << 24) | (buf[off + 1]! << 16) | (buf[off + 2]! << 8) | buf[off + 3]!) >>> 0
  );
}

/**
 * Parses a Xing/Info block whose marker starts at `buf[off]`.
 * The caller guarantees `off + 4 + xingBodyLength(flags)` bytes are present.
 */
export function parseXing(buf: Uint8Array, off: number): XingInfo {
  const marker = String.fromCharCode(buf[off]!, buf[off + 1]!, buf[off + 2]!, buf[off + 3]!);
  if (marker !== "Xing" && marker !== "Info") {
    throw new Mp3ProbeError("ERR_XING", "missing Xing/Info marker");
  }
  const flags = u32(buf, off + 4);
  const bodyLen = xingBodyLength(flags);

  let cursor = off + 8;
  let declaredFrames: number | null = null;
  let declaredBytes: number | null = null;
  if (flags & FLAG_FRAMES) {
    declaredFrames = u32(buf, cursor);
    cursor += 4;
  }
  if (flags & FLAG_BYTES) {
    declaredBytes = u32(buf, cursor);
    cursor += 4;
  }
  if (flags & FLAG_TOC) cursor += 100;
  if (flags & FLAG_QUALITY) cursor += 4;

  const lame = cursor;
  if (
    buf[lame] !== 0x4c || // L
    buf[lame + 1] !== 0x41 || // A
    buf[lame + 2] !== 0x4d || // M
    buf[lame + 3] !== 0x45 // E
  ) {
    throw new Mp3ProbeError("ERR_XING", "missing LAME extension");
  }
  const b21 = buf[lame + 21]!;
  const b22 = buf[lame + 22]!;
  const b23 = buf[lame + 23]!;
  const encoderDelay = (b21 << 4) | (b22 >> 4);
  const endPadding = ((b22 & 0x0f) << 8) | b23;

  return {
    declaredFrames,
    declaredBytes,
    encoderDelay,
    endPadding,
    totalLength: 4 + bodyLen,
  };
}
