import {
  WHITELIST_FIELD_NAMES,
  buildExif,
  fieldCount,
  mergeExifFields,
  parseExif,
} from "./exif.ts";
import type { MergedExif, ParsedExif, TiffField } from "./exif.ts";
import { parseJpeg, serializeJpeg } from "./jpeg.ts";
import type { JpegElement } from "./jpeg.ts";
import { classifyAppSegment } from "./metadata.ts";
import type { KeptFieldPreview, PreviewValue } from "./types.ts";

const EXIF_HEADER_LENGTH = 6; // "Exif\0\0"

function isAppOrCom(marker: number): boolean {
  return (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
}

interface ExtractionResult {
  elements: JpegElement[];
  mergedExif: MergedExif | undefined;
  exifInsertAt: number;
}

/**
 * Parses the JPEG, drops/replaces non-whitelisted APP/COM segments, and
 * collects + merges every EXIF segment. Shared by sanitize and preview so
 * both always agree on the kept field set.
 */
function extract(input: Uint8Array): ExtractionResult {
  const parsed = parseJpeg(input);
  const elements: JpegElement[] = [];
  const exifSegments: ParsedExif[] = [];
  let exifInsertAt = -1;

  for (const element of parsed.elements) {
    if (!isAppOrCom(element.marker)) {
      elements.push(element);
      continue;
    }
    const decision = classifyAppSegment(element.marker, element.data);
    switch (decision.action) {
      case "keep":
        elements.push(element);
        break;
      case "drop":
        break;
      case "replace":
        elements.push({ marker: element.marker, data: decision.data });
        break;
      case "exif": {
        if (exifInsertAt < 0) {
          exifInsertAt = elements.length;
        }
        const tiff = element.data.subarray(EXIF_HEADER_LENGTH);
        exifSegments.push(parseExif(tiff));
        break;
      }
    }
  }

  let mergedExif: MergedExif | undefined;
  if (exifSegments.length > 0) {
    const merged = mergeExifFields(exifSegments);
    if (merged.ifd0.length > 0 || merged.exifIfd.length > 0) {
      mergedExif = merged;
    }
  }
  return { elements, mergedExif, exifInsertAt };
}

export function sanitizeJpeg(input: Uint8Array): Uint8Array {
  const { elements, mergedExif, exifInsertAt } = extract(input);
  if (mergedExif !== undefined) {
    const tiff = buildExif(mergedExif);
    const data = new Uint8Array(EXIF_HEADER_LENGTH + tiff.length);
    data.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 0);
    data.set(tiff, EXIF_HEADER_LENGTH);
    elements.splice(exifInsertAt, 0, { marker: 0xe1, data });
  }
  return serializeJpeg({ elements });
}

function toPreviewValue(field: TiffField): PreviewValue {
  const value = field.value;
  switch (value.type) {
    case 2: {
      let end = 0;
      while (end < value.bytes.length && value.bytes[end] !== 0) {
        end += 1;
      }
      let text = "";
      for (let i = 0; i < end; i += 1) {
        text += String.fromCharCode(value.bytes[i]!);
      }
      return { kind: "ascii", text };
    }
    case 3:
    case 4:
    case 8:
    case 9:
      return { kind: "integers", values: [...value.ints] };
    case 5:
    case 10:
      return { kind: "rationals", values: value.rationals.map((r) => ({ ...r })) };
    case 11:
    case 12:
      return { kind: "floats", values: [...value.floats] };
    default:
      return { kind: "bytes", bytes: value.bytes.slice() };
  }
}

function toPreview(ifd: "IFD0" | "ExifIFD", field: TiffField): KeptFieldPreview {
  return {
    ifd,
    tag: field.tag,
    name: WHITELIST_FIELD_NAMES[`${ifd}:${field.tag}`] ?? `Tag0x${field.tag.toString(16)}`,
    type: field.value.type,
    count: fieldCount(field),
    value: toPreviewValue(field),
  };
}

export function previewKeptFields(input: Uint8Array): KeptFieldPreview[] {
  const { mergedExif } = extract(input);
  if (mergedExif === undefined) {
    return [];
  }
  return [
    ...mergedExif.ifd0.map((field) => toPreview("IFD0" as const, field)),
    ...mergedExif.exifIfd.map((field) => toPreview("ExifIFD" as const, field)),
  ];
}
