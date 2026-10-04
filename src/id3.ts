import { Mp3ProbeError } from './errors';

export interface Id3v2Header {
  readonly majorVersion: number;
  readonly flags: number;
  readonly bodyLength: number;
  readonly hasFooter: boolean;
}

// Validates a 10-byte ID3v2 header. Only v2.3 and v2.4 are accepted.
export function parseId3v2Header(h: Uint8Array): Id3v2Header {
  if (h.length !== 10 || h[0] !== 0x49 || h[1] !== 0x44 || h[2] !== 0x33) { // "ID3"
    throw new Mp3ProbeError('ID3V2_INVALID', 'bad ID3v2 magic');
  }
  const major = h[3]!;
  if (major !== 3 && major !== 4) {
    throw new Mp3ProbeError('ID3V2_INVALID', 'unsupported ID3v2 version');
  }
  if (h[5] === undefined) {
    throw new Mp3ProbeError('ID3V2_INVALID', 'truncated header');
  }
  const flags = h[5]!;
  const allowed = major === 3 ? 0xe0 : 0xf0;
  if (flags & ~allowed) {
    throw new Mp3ProbeError('ID3V2_INVALID', 'unknown ID3v2 flags');
  }
  const s6 = h[6]!;
  const s7 = h[7]!;
  const s8 = h[8]!;
  const s9 = h[9]!;
  if ((s6 | s7 | s8 | s9) & 0x80) {
    throw new Mp3ProbeError('ID3V2_INVALID', 'non-synchsafe size');
  }
  const bodyLength = ((s6 << 21) | (s7 << 14) | (s8 << 7) | s9) >>> 0;
  const hasFooter = major === 4 && (flags & 0x10) !== 0;
  return { majorVersion: major, flags, bodyLength, hasFooter };
}

// Validates a 10-byte ID3v2.4 footer ("3DI") against the original header.
export function checkId3v2Footer(f: Uint8Array, header: Id3v2Header): void {
  if (f.length !== 10 || f[0] !== 0x33 || f[1] !== 0x44 || f[2] !== 0x49) { // "3DI"
    throw new Mp3ProbeError('ID3V2_FOOTER_MISMATCH', 'bad footer magic');
  }
  if (f[3] !== header.majorVersion || f[5] !== header.flags) {
    throw new Mp3ProbeError('ID3V2_FOOTER_MISMATCH', 'footer differs from header');
  }
  const parsed = parseId3v2Header(new Uint8Array([0x49, 0x44, 0x33, f[3]!, f[4]!, f[5]!, f[6]!, f[7]!, f[8]!, f[9]!]));
  if (parsed.bodyLength !== header.bodyLength) {
    throw new Mp3ProbeError('ID3V2_FOOTER_MISMATCH', 'footer size differs from header');
  }
}

// Validates a 128-byte ID3v1 tag.
export function checkId3v1(t: Uint8Array): void {
  if (t.length !== 128 || t[0] !== 0x54 || t[1] !== 0x41 || t[2] !== 0x47) { // "TAG"
    throw new Mp3ProbeError('ID3V1_INVALID', 'malformed ID3v1 tag');
  }
}
