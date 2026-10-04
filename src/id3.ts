import { Mp3ProbeError } from "./errors";

export interface Id3v2Header {
  /** 3 or 4. */
  version: number;
  flags: number;
  /** Synchsafe tag size: bytes after the 10-byte header, including footer if present. */
  bodySize: number;
  footerPresent: boolean;
}

function synchsafe(
  buf: Uint8Array,
  off: number,
  code: "ERR_ID3V2_HEADER" | "ERR_ID3V2_FOOTER",
): number {
  let value = 0;
  for (let i = 0; i < 4; i++) {
    const b = buf[off + i]!;
    if (b & 0x80) {
      throw new Mp3ProbeError(code, "tag size is not synchsafe");
    }
    value = (value << 7) | b;
  }
  return value;
}

/** Validates an ID3v2.3 / ID3v2.4 header at `buf[off .. off+9]`. */
export function parseId3v2Header(buf: Uint8Array, off: number): Id3v2Header {
  if (buf[off] !== 0x49 || buf[off + 1] !== 0x44 || buf[off + 2] !== 0x33) {
    throw new Mp3ProbeError("ERR_ID3V2_HEADER", "missing ID3 magic");
  }
  const version = buf[off + 3]!;
  if (version !== 3 && version !== 4) {
    throw new Mp3ProbeError("ERR_ID3V2_HEADER", `unsupported ID3v2.${version}`);
  }
  if (buf[off + 5] === undefined) {
    throw new Mp3ProbeError("ERR_ID3V2_HEADER", "truncated header");
  }
  const flags = buf[off + 5]!;
  const allowed = version === 3 ? 0xe0 : 0xf0;
  if (flags & ~allowed) {
    throw new Mp3ProbeError("ERR_ID3V2_HEADER", "unknown ID3v2 flags");
  }
  const bodySize = synchsafe(buf, off + 6, "ERR_ID3V2_HEADER");
  const footerPresent = version === 4 && (flags & 0x10) !== 0;
  return { version, flags, bodySize, footerPresent };
}

/**
 * Validates an ID3v2.4 footer at `buf[off .. off+9]` against its header.
 * The footer must carry the "3DI" magic and mirror version, flags and size.
 */
export function checkId3v2Footer(buf: Uint8Array, off: number, header: Id3v2Header): void {
  if (buf[off] !== 0x33 || buf[off + 1] !== 0x44 || buf[off + 2] !== 0x49) {
    throw new Mp3ProbeError("ERR_ID3V2_FOOTER", "missing 3DI magic");
  }
  if (buf[off + 3] !== header.version || buf[off + 5] !== header.flags) {
    throw new Mp3ProbeError("ERR_ID3V2_FOOTER", "footer does not match header");
  }
  if (synchsafe(buf, off + 6, "ERR_ID3V2_FOOTER") !== header.bodySize) {
    throw new Mp3ProbeError("ERR_ID3V2_FOOTER", "footer size does not match header");
  }
}
