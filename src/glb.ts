import type { GltfDocument } from './types.js';

/** 解析后的 GLB 内容：JSON 文档与内嵌 BIN 字节。 */
export interface ParsedGlb {
  json: GltfDocument;
  bin: Uint8Array;
}

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'

/** 解析 GLB 容器（头部、JSON chunk、BIN chunk）。 */
export function parseGlb(bytes: Uint8Array): ParsedGlb {
  if (bytes.byteLength < 12) {
    throw new Error('invalid GLB: too short');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) {
    throw new Error('invalid GLB: bad magic');
  }
  if (view.getUint32(4, true) !== 2) {
    throw new Error('invalid GLB: only glTF 2.0 is supported');
  }
  const totalLength = view.getUint32(8, true);
  if (totalLength > bytes.byteLength) {
    throw new Error('invalid GLB: declared length exceeds data');
  }

  let json: GltfDocument | null = null;
  let bin: Uint8Array | null = null;
  let offset = 12;
  while (offset + 8 <= totalLength) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + chunkLength > totalLength) {
      throw new Error('invalid GLB: chunk exceeds declared length');
    }
    if (chunkType === CHUNK_JSON && json === null) {
      const text = new TextDecoder().decode(bytes.subarray(start, start + chunkLength));
      json = JSON.parse(text) as GltfDocument;
    } else if (chunkType === CHUNK_BIN && bin === null) {
      bin = bytes.subarray(start, start + chunkLength);
    }
    offset = start + chunkLength;
  }

  if (json === null) {
    throw new Error('invalid GLB: missing JSON chunk');
  }
  if (bin === null) {
    throw new Error('invalid GLB: missing BIN chunk');
  }
  return { json, bin };
}
