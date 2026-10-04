"""GLB 2.0 container parsing: JSON chunk + embedded BIN chunk."""

import json
import struct
from typing import Any, Dict, Tuple

_MAGIC = 0x46546C67  # "glTF"
_VERSION = 2
_CHUNK_JSON = 0x4E4F534A  # "JSON"
_CHUNK_BIN = 0x004E4942  # "BIN\0"


def load_glb(path: str) -> Tuple[Dict[str, Any], bytes]:
    """Parse a GLB file, returning (gltf_json, bin_chunk).

    Only GLB 2.0 with an embedded BIN chunk is supported.
    """
    with open(path, "rb") as fh:
        data = fh.read()
    if len(data) < 12:
        raise ValueError("file too small to be a GLB")
    magic, version, total_length = struct.unpack_from("<III", data, 0)
    if magic != _MAGIC:
        raise ValueError("not a GLB file (bad magic)")
    if version != _VERSION:
        raise ValueError(f"unsupported GLB version: {version}")
    if total_length != len(data):
        raise ValueError("GLB length header does not match file size")

    gltf: Dict[str, Any] = {}
    bin_chunk = b""
    offset = 12
    seen_json = False
    while offset + 8 <= len(data):
        chunk_length, chunk_type = struct.unpack_from("<II", data, offset)
        offset += 8
        chunk = data[offset : offset + chunk_length]
        offset += chunk_length
        if chunk_type == _CHUNK_JSON:
            if seen_json:
                raise ValueError("multiple JSON chunks")
            seen_json = True
            gltf = json.loads(chunk.decode("utf-8"))
        elif chunk_type == _CHUNK_BIN:
            bin_chunk = bytes(chunk)
    if not seen_json:
        raise ValueError("GLB has no JSON chunk")
    return gltf, bin_chunk
