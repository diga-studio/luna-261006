import { GltfDocument, ParsedGlb } from "./types";

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const CHUNK_BIN = 0x004e4942; // "BIN\0"

/** Parse a GLB binary container into JSON document and BIN chunk. */
export function parseGlb(bytes: Uint8Array): ParsedGlb {
  if (bytes.byteLength < 12) {
    throw new Error("invalid GLB: too short for header");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) {
    throw new Error("invalid GLB: bad magic");
  }
  if (view.getUint32(4, true) !== 2) {
    throw new Error("invalid GLB: unsupported version");
  }
  const totalLength = view.getUint32(8, true);
  if (totalLength > bytes.byteLength) {
    throw new Error("invalid GLB: declared length exceeds data");
  }

  let json: GltfDocument | undefined;
  let bin: Uint8Array | undefined;
  let offset = 12;
  while (offset + 8 <= totalLength) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    if (chunkStart + chunkLength > totalLength) {
      throw new Error("invalid GLB: chunk exceeds declared length");
    }
    if (chunkType === CHUNK_JSON) {
      const text = new TextDecoder().decode(
        bytes.subarray(chunkStart, chunkStart + chunkLength)
      );
      json = JSON.parse(text) as GltfDocument;
    } else if (chunkType === CHUNK_BIN) {
      bin = bytes.subarray(chunkStart, chunkStart + chunkLength);
    }
    offset = chunkStart + chunkLength;
  }
  if (json === undefined) {
    throw new Error("invalid GLB: missing JSON chunk");
  }
  if (bin === undefined) {
    throw new Error("invalid GLB: missing BIN chunk");
  }
  return { json, bin };
}
