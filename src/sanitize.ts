import { JpegPrivacyError } from "./errors.js";
import type { JpegStructure } from "./jpeg.js";
import type { ExtractedField } from "./exif.js";
import { buildExifPayload } from "./exifWriter.js";

const M_APP0 = 0xe0;
const M_APP1 = 0xe1;
const M_APP2 = 0xe2;
const M_APP14 = 0xee;
const M_COM = 0xfe;

function isAppn(marker: number): boolean {
  return marker >= 0xe0 && marker <= 0xef;
}

function startsWith(payload: Uint8Array, magic: number[]): boolean {
  if (payload.length < magic.length) return false;
  return magic.every((b, i) => payload[i] === b);
}

const EXIF_MAGIC = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
const JFIF_MAGIC = [0x4a, 0x46, 0x49, 0x46, 0x00];
const ICC_MAGIC = [0x49, 0x43, 0x43, 0x5f, 0x50, 0x52, 0x4f, 0x46, 0x49, 0x4c, 0x45, 0x00];
const ADOBE_MAGIC = [0x41, 0x64, 0x6f, 0x62, 0x65];

function fail(code: string, message: string): never {
  throw new JpegPrivacyError(code, message);
}

function segmentRaw(marker: number, payload: Uint8Array): Uint8Array {
  const length = payload.length + 2;
  if (length > 0xffff) fail("too_large", "重建段超出 JPEG 段长度上限");
  const out = new Uint8Array(2 + length);
  out[0] = 0xff;
  out[1] = marker;
  out[2] = length >> 8;
  out[3] = length & 0xff;
  out.set(payload, 4);
  return out;
}

/** 保留 JFIF 显示参数、删除缩略图后的 APP0 负载。 */
function stripJfifThumbnail(payload: Uint8Array): Uint8Array {
  if (payload.length < 14) fail("bad_jfif", "JFIF 段过短");
  const xThumb = payload[12]!;
  const yThumb = payload[13]!;
  const thumbBytes = 3 * xThumb * yThumb;
  if (14 + thumbBytes > payload.length) fail("bad_jfif", "JFIF 缩略图数据越界");
  const out = new Uint8Array(14);
  out.set(payload.subarray(0, 14));
  out[12] = 0;
  out[13] = 0;
  return out;
}

function isStandardAdobe(payload: Uint8Array): boolean {
  return payload.length === 12 && startsWith(payload, ADOBE_MAGIC);
}

/**
 * 由解析后的结构与合并后的白名单字段组装净化 JPEG。
 * 扫描数据、编码标记（DQT/DHT/SOF/DRI 等）逐字节保留；
 * EXIF 重建为单段；JFIF 去缩略图；ICC 与标准 Adobe 原样保留；其余 APPn/COM/尾随数据删除。
 */
export function assembleSanitized(structure: JpegStructure, fields: ExtractedField[]): Uint8Array {
  const exifPayload = fields.length > 0 ? buildExifPayload(fields) : null;
  let exifWritten = false;
  const parts: Uint8Array[] = [];

  for (const piece of structure.pieces) {
    if (piece.kind === "scan") {
      parts.push(piece.raw);
      continue;
    }
    const { marker, payload, raw } = piece;
    if (payload === null) {
      parts.push(raw); // SOI/EOI/TEM/RSTn
      continue;
    }
    if (marker === M_APP0 && startsWith(payload, JFIF_MAGIC)) {
      parts.push(segmentRaw(M_APP0, stripJfifThumbnail(payload)));
      continue;
    }
    if (marker === M_APP1 && startsWith(payload, EXIF_MAGIC)) {
      if (exifPayload !== null && !exifWritten) {
        parts.push(segmentRaw(M_APP1, exifPayload));
        exifWritten = true;
      }
      continue; // 其余 EXIF 段删除
    }
    if (marker === M_APP2 && startsWith(payload, ICC_MAGIC)) {
      parts.push(raw); // ICC 分段内容与顺序保持不变
      continue;
    }
    if (marker === M_APP14 && isStandardAdobe(payload)) {
      parts.push(raw);
      continue;
    }
    if (isAppn(marker) || marker === M_COM) {
      continue; // XMP/IPTC/COM/其他 APP 内容删除
    }
    parts.push(raw); // DQT/DHT/SOF/DRI/DNL 等编码相关段
  }

  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
