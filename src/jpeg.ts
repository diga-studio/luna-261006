import { JpegPrivacyError } from "./errors.ts";

/** One length-prefixed marker segment; for SOS, scanData holds the entropy-coded bytes. */
export interface JpegElement {
  marker: number;
  data: Uint8Array;
  scanData?: Uint8Array;
}

export interface ParsedJpeg {
  elements: JpegElement[];
}

const MARKER_SOI = 0xd8;
const MARKER_EOI = 0xd9;
const MARKER_SOS = 0xda;
const MARKER_TEM = 0x01;

function isAppMarker(marker: number): boolean {
  return marker >= 0xe0 && marker <= 0xef;
}

function isRstMarker(marker: number): boolean {
  return marker >= 0xd0 && marker <= 0xd7;
}

function isSofMarker(marker: number): boolean {
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    marker !== 0xc4 &&
    marker !== 0xc8 &&
    marker !== 0xcc
  );
}

/** Length-prefixed structural markers this library understands and passes through. */
const KNOWN_STRUCTURAL_MARKERS = new Set<number>([
  0xc4, // DHT
  0xdb, // DQT
  0xdd, // DRI
  0xdc, // DNL
  0xfe, // COM (dropped later, but structurally known)
]);

function invalid(message: string): never {
  throw new JpegPrivacyError("INVALID_JPEG", message);
}

function unsupported(message: string): never {
  throw new JpegPrivacyError("UNSUPPORTED_JPEG", message);
}

function checkSof(element: JpegElement): void {
  const { marker, data } = element;
  if (marker !== 0xc0 && marker !== 0xc2) {
    unsupported(
      `unsupported SOF marker 0x${marker.toString(16)}: only baseline (SOF0) and progressive (SOF2) Huffman JPEG are supported`,
    );
  }
  if (data.length < 6) {
    invalid("truncated SOF segment");
  }
  if (data[0] !== 8) {
    unsupported(`unsupported sample precision ${data[0]}: only 8-bit JPEG is supported`);
  }
  const components = data[5]!;
  if (components < 1 || data.length !== 6 + 3 * components) {
    invalid("malformed SOF segment: component specifiers do not fit");
  }
}

export function parseJpeg(input: Uint8Array): ParsedJpeg {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== MARKER_SOI) {
    invalid("missing SOI marker");
  }
  const elements: JpegElement[] = [];
  let sawSof = false;
  let sawSos = false;
  let pos = 2;

  for (;;) {
    if (pos >= input.length) {
      invalid("unexpected end of file: missing EOI marker");
    }
    if (input[pos] !== 0xff) {
      invalid(`expected marker at offset ${pos}, found 0x${input[pos]!.toString(16)}`);
    }
    // Skip fill bytes (0xFF padding) between segments.
    while (pos < input.length && input[pos] === 0xff) {
      pos += 1;
    }
    if (pos >= input.length) {
      invalid("unexpected end of file inside marker padding");
    }
    const marker = input[pos]!;
    pos += 1;

    if (marker === MARKER_EOI) {
      // Anything after the first EOI is trailing garbage and gets dropped.
      if (!sawSof || !sawSos) {
        invalid("not a decodable JPEG image: missing SOF or SOS");
      }
      return { elements };
    }
    if (marker === MARKER_SOI) {
      invalid("unexpected duplicate SOI marker");
    }
    if (marker === 0x00 || isRstMarker(marker) || marker === MARKER_TEM) {
      invalid(`unexpected standalone marker 0x${marker.toString(16)} outside scan data`);
    }
    if (pos + 2 > input.length) {
      invalid("truncated segment length");
    }
    const length = (input[pos]! << 8) | input[pos + 1]!;
    if (length < 2 || pos + length > input.length) {
      invalid(`segment 0x${marker.toString(16)} length out of bounds`);
    }
    const data = input.subarray(pos + 2, pos + length);
    pos += length;

    const element: JpegElement = { marker, data };

    if (marker === MARKER_SOS) {
      sawSos = true;
      // Entropy-coded data runs until the next real marker. 0xFF 0x00 is a
      // stuffed data byte, 0xFF D0-D7 are restart markers, and runs of 0xFF
      // before a marker are fill bytes; none of them start a new segment.
      const scanStart = pos;
      let cursor = pos;
      for (;;) {
        if (cursor >= input.length) {
          invalid("unterminated scan data: missing EOI marker");
        }
        if (input[cursor] !== 0xff) {
          cursor += 1;
          continue;
        }
        let runEnd = cursor;
        while (runEnd < input.length && input[runEnd] === 0xff) {
          runEnd += 1;
        }
        if (runEnd >= input.length) {
          invalid("unterminated scan data: missing EOI marker");
        }
        const code = input[runEnd]!;
        if (code === 0x00 || isRstMarker(code)) {
          cursor = runEnd + 1;
          continue;
        }
        // Real marker. Fill bytes stay inside the scan data so the compressed
        // stream is preserved byte for byte; the marker itself starts at the
        // last 0xFF of the run.
        element.scanData = input.subarray(scanStart, runEnd - 1);
        pos = runEnd - 1;
        break;
      }
    } else if (isSofMarker(marker)) {
      checkSof(element);
      sawSof = true;
    } else if (isAppMarker(marker) || KNOWN_STRUCTURAL_MARKERS.has(marker)) {
      // Handled by later stages.
    } else {
      unsupported(
        `unsupported marker 0x${marker.toString(16)}: JPEG structure cannot be fully determined`,
      );
    }

    elements.push(element);
  }
}

export function serializeJpeg(parsed: ParsedJpeg): Uint8Array {
  let total = 2 + 2; // SOI + EOI
  for (const element of parsed.elements) {
    total += 2 + 2 + element.data.length + (element.scanData?.length ?? 0);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  out[offset++] = 0xff;
  out[offset++] = MARKER_SOI;
  for (const element of parsed.elements) {
    out[offset++] = 0xff;
    out[offset++] = element.marker;
    const length = element.data.length + 2;
    out[offset++] = (length >> 8) & 0xff;
    out[offset++] = length & 0xff;
    out.set(element.data, offset);
    offset += element.data.length;
    if (element.scanData !== undefined) {
      out.set(element.scanData, offset);
      offset += element.scanData.length;
    }
  }
  out[offset++] = 0xff;
  out[offset++] = MARKER_EOI;
  return out;
}
