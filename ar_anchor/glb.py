"""GLB 2.0 容器解析：JSON 块 + 内嵌 BIN 块。"""
from __future__ import annotations

import json
import struct
from dataclasses import dataclass

GLB_MAGIC = 0x46546C67  # "glTF"
GLB_VERSION = 2
CHUNK_JSON = 0x4E4F534A  # "JSON"
CHUNK_BIN = 0x004E4942  # "BIN\0"


@dataclass
class GlbDocument:
    """解析后的 GLB 文档：gltf JSON 字典与 BIN 块字节。"""

    json: dict
    bin_chunk: bytes


def load_glb(path: str) -> GlbDocument:
    """读取并校验 GLB 文件，返回 JSON 与 BIN 块。"""
    with open(path, "rb") as fh:
        data = fh.read()
    if len(data) < 12:
        raise ValueError("文件太小，不是合法 GLB")
    magic, version, total_length = struct.unpack_from("<III", data, 0)
    if magic != GLB_MAGIC:
        raise ValueError("缺少 GLB magic 头")
    if version != GLB_VERSION:
        raise ValueError(f"仅支持 GLB 2.0，实际版本 {version}")
    if total_length != len(data):
        raise ValueError("GLB 头声明长度与文件实际长度不一致")

    offset = 12
    json_chunk = None
    bin_chunk = b""
    while offset + 8 <= len(data):
        chunk_length, chunk_type = struct.unpack_from("<II", data, offset)
        offset += 8
        chunk = data[offset : offset + chunk_length]
        if len(chunk) != chunk_length:
            raise ValueError("GLB 块长度越界")
        offset += chunk_length
        if chunk_type == CHUNK_JSON:
            if json_chunk is not None:
                raise ValueError("GLB 含多个 JSON 块")
            json_chunk = chunk
        elif chunk_type == CHUNK_BIN:
            bin_chunk = chunk
    if json_chunk is None:
        raise ValueError("GLB 缺少 JSON 块")

    gltf = json.loads(json_chunk.decode("utf-8"))
    buffers = gltf.get("buffers", [])
    for buf in buffers:
        if "uri" in buf:
            raise ValueError("仅支持内嵌 BIN 块，不支持外部 buffer uri")
    if buffers and not bin_chunk:
        raise ValueError("GLB 声明了 buffer 但缺少 BIN 块")
    return GlbDocument(json=gltf, bin_chunk=bin_chunk)
