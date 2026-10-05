import { JpegPrivacyError } from "./errors.ts";

export type AppAction =
  | { action: "keep" }
  | { action: "drop" }
  | { action: "replace"; data: Uint8Array }
  | { action: "exif" };

const MARKER_APP0 = 0xe0;
const MARKER_APP1 = 0xe1;
const MARKER_APP2 = 0xe2;
const MARKER_APP14 = 0xee;
const MARKER_COM = 0xfe;

function startsWith(data: Uint8Array, signature: string): boolean {
  if (data.length < signature.length) {
    return false;
  }
  for (let i = 0; i < signature.length; i += 1) {
    if (data[i] !== signature.charCodeAt(i)) {
      return false;
    }
  }
  return true;
}

function invalid(message: string): never {
  throw new JpegPrivacyError("INVALID_JPEG", message);
}

/**
 * Strips the JFIF thumbnail while keeping the display parameters (version,
 * density units, X/Y density) byte-identical.
 */
function stripJfifThumbnail(data: Uint8Array): Uint8Array {
  if (data.length < 14) {
    invalid("malformed JFIF segment");
  }
  const thumbX = data[12]!;
  const thumbY = data[13]!;
  if (data.length !== 14 + 3 * thumbX * thumbY) {
    invalid("malformed JFIF segment: thumbnail size mismatch");
  }
  if (thumbX === 0 && thumbY === 0) {
    return data;
  }
  const out = new Uint8Array(14);
  out.set(data.subarray(0, 12), 0);
  out[12] = 0;
  out[13] = 0;
  return out;
}

export function classifyAppSegment(marker: number, data: Uint8Array): AppAction {
  if (marker === MARKER_COM) {
    return { action: "drop" };
  }
  switch (marker) {
    case MARKER_APP0:
      if (startsWith(data, "JFIF\0")) {
        const stripped = stripJfifThumbnail(data);
        return stripped === data ? { action: "keep" } : { action: "replace", data: stripped };
      }
      // JFXX extension segments carry thumbnails; unknown APP0 is dropped too.
      return { action: "drop" };
    case MARKER_APP1:
      if (startsWith(data, "Exif\0\0")) {
        return { action: "exif" };
      }
      // XMP and any other APP1 are dropped.
      return { action: "drop" };
    case MARKER_APP2:
      if (startsWith(data, "ICC_PROFILE\0")) {
        if (data.length < 14) {
          invalid("malformed ICC_PROFILE segment");
        }
        return { action: "keep" };
      }
      return { action: "drop" };
    case MARKER_APP14:
      if (startsWith(data, "Adobe")) {
        return { action: "keep" };
      }
      return { action: "drop" };
    default:
      // IPTC (APP13), XMP extensions, and every other APPn are dropped.
      return { action: "drop" };
  }
}
