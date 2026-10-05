import { JpegPrivacyError } from "./errors.js";

/** JPEG 顶层结构片段：标记段或扫描数据块。 */
export type JpegPiece =
  | {
      kind: "segment";
      /** 标记码（不含 0xFF），如 0xe1 表示 APP1。 */
      marker: number;
      /** 段负载（不含长度字段）。standalone 标记时为 null。 */
      payload: Uint8Array | null;
      /** 该段完整字节（含前导填充 0xFF、标记与长度）。 */
      raw: Uint8Array;
    }
  | {
      kind: "scan";
      /** SOS 头（含 0xFFDA 与长度）及其后直到下一标记的熵编码数据，逐字节保留。 */
      raw: Uint8Array;
    };

export interface JpegStructure {
  pieces: JpegPiece[];
  /** SOF 标记码：0xc0 基线或 0xc2 渐进。 */
  sofMarker: number;
}

const M_SOI = 0xd8;
const M_EOI = 0xd9;
const M_SOS = 0xda;
const M_TEM = 0x01;

function isRst(marker: number): boolean {
  return marker >= 0xd0 && marker <= 0xd7;
}

function isSof(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function fail(code: string, message: string): never {
  throw new JpegPrivacyError(code, message);
}

function u8(bytes: Uint8Array, i: number): number {
  return bytes[i]!;
}

function u16(bytes: Uint8Array, i: number): number {
  return (u8(bytes, i) << 8) | u8(bytes, i + 1);
}

/** 校验 SOF 负载：8 位精度、分量数与长度一致。 */
function validateSof(payload: Uint8Array): void {
  if (payload.length < 6) fail("bad_sof", "SOF 段过短");
  const precision = u8(payload, 0);
  if (precision !== 8) fail("unsupported", `仅支持 8 位精度，实际为 ${precision}`);
  const components = u8(payload, 5);
  if (components < 1) fail("bad_sof", "SOF 分量数非法");
  if (payload.length !== 6 + 3 * components) fail("bad_sof", "SOF 长度与分量数不一致");
}

/** 校验 SOS 头：分量数与长度一致。 */
function validateSos(payload: Uint8Array): void {
  if (payload.length < 4) fail("bad_sos", "SOS 头过短");
  const components = u8(payload, 0);
  if (components < 1) fail("bad_sos", "SOS 分量数非法");
  if (payload.length !== 4 + 2 * components) fail("bad_sos", "SOS 头长度与分量数不一致");
}

/**
 * 解析 JPEG 顶层结构。
 * 仅支持 8 位 Huffman 基线（SOF0）与渐进式（SOF2）。
 * 结构无法完整确定时抛 JpegPrivacyError。
 */
export function parseJpegStructure(bytes: Uint8Array): JpegStructure {
  if (bytes.length < 4 || u8(bytes, 0) !== 0xff || u8(bytes, 1) !== M_SOI) {
    fail("not_jpeg", "不是以 SOI 开头的 JPEG 文件");
  }
  const pieces: JpegPiece[] = [];
  pieces.push({ kind: "segment", marker: M_SOI, payload: null, raw: bytes.subarray(0, 2) });

  let pos = 2;
  let sofMarker = -1;
  let sawSof = false;
  let sawSos = false;

  for (;;) {
    if (pos >= bytes.length) fail("truncated", "文件在 EOI 之前结束");
    const markerStart = pos;
    if (u8(bytes, pos) !== 0xff) fail("bad_structure", "段之间出现非标记字节");
    while (pos < bytes.length && u8(bytes, pos) === 0xff) pos++;
    if (pos >= bytes.length) fail("truncated", "文件在标记处截断");
    const marker = u8(bytes, pos);
    pos++;

    if (marker === 0x00) fail("bad_structure", "段之间出现 stuffed 字节");
    if (marker === M_SOI) fail("bad_structure", "重复的 SOI 标记");
    if (marker === M_EOI) {
      pieces.push({ kind: "segment", marker, payload: null, raw: bytes.subarray(markerStart, pos) });
      break; // 首个 EOI 之后的尾随数据直接丢弃
    }
    if (marker === M_TEM || isRst(marker)) {
      pieces.push({ kind: "segment", marker, payload: null, raw: bytes.subarray(markerStart, pos) });
      continue;
    }
    if (isSof(marker)) {
      if (marker !== 0xc0 && marker !== 0xc2) {
        fail("unsupported", `仅支持基线/渐进式 Huffman JPEG，SOF=0x${marker.toString(16)}`);
      }
      if (sawSof) fail("bad_structure", "出现多个 SOF 标记");
      sawSof = true;
      sofMarker = marker;
    }

    if (pos + 2 > bytes.length) fail("truncated", "段长度字段越界");
    const length = u16(bytes, pos);
    if (length < 2) fail("bad_structure", "段长度小于 2");
    const end = pos + length;
    if (end > bytes.length) fail("truncated", "段长度超出文件末尾");
    const payload = bytes.subarray(pos + 2, end);

    if (isSof(marker)) validateSof(payload);

    if (marker === M_SOS) {
      if (!sawSof) fail("bad_structure", "SOS 出现在 SOF 之前");
      sawSos = true;
      validateSos(payload);
      // 熵编码数据：FF00 为填充字节，FFD0-D7 为重启标记，其余 FFxx 结束扫描。
      let p = end;
      let scanEnd = -1;
      while (p < bytes.length) {
        if (u8(bytes, p) !== 0xff) {
          p++;
          continue;
        }
        let q = p;
        while (q < bytes.length && u8(bytes, q) === 0xff) q++;
        if (q >= bytes.length) fail("truncated", "扫描数据之后缺少标记");
        const next = u8(bytes, q);
        if (next === 0x00 || isRst(next)) {
          p = q + 1;
          continue;
        }
        scanEnd = p; // 前导填充 FF 归入下一段的 raw
        pos = p;
        break;
      }
      if (scanEnd < 0) fail("truncated", "扫描数据未正常终止");
      pieces.push({ kind: "scan", raw: bytes.subarray(markerStart, scanEnd) });
      continue;
    }

    pieces.push({ kind: "segment", marker, payload, raw: bytes.subarray(markerStart, end) });
    pos = end;
  }

  if (!sawSof) fail("bad_structure", "缺少 SOF 标记");
  if (!sawSos) fail("bad_structure", "缺少 SOS 标记");
  return { pieces, sofMarker };
}
