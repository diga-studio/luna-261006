"""测试用 GLB 2.0 文件构造工具。"""
from __future__ import annotations

import json
import struct


class GlbBuilder:
    """以编程方式组装 GLB：追加数据块、声明 bufferView/accessor 等。"""

    def __init__(self):
        self.bin = bytearray()
        self.buffer_views = []
        self.accessors = []
        self.meshes = []
        self.nodes = []
        self.scenes = [{"nodes": []}]
        self.scene = 0

    def add_data(self, payload: bytes, align: int = 4) -> int:
        """追加原始字节，返回起始偏移。"""
        pad = (-len(self.bin)) % align
        self.bin.extend(b"\x00" * pad)
        offset = len(self.bin)
        self.bin.extend(payload)
        return offset

    def add_buffer_view(self, payload: bytes, byte_stride=None, align: int = 4) -> int:
        offset = self.add_data(payload, align)
        view = {"buffer": 0, "byteOffset": offset, "byteLength": len(payload)}
        if byte_stride is not None:
            view["byteStride"] = byte_stride
        self.buffer_views.append(view)
        return len(self.buffer_views) - 1

    def add_accessor(self, component_type, count, type_, buffer_view=None,
                     byte_offset=0, sparse=None) -> int:
        accessor = {"componentType": component_type, "count": count, "type": type_}
        if buffer_view is not None:
            accessor["bufferView"] = buffer_view
        if byte_offset:
            accessor["byteOffset"] = byte_offset
        if sparse is not None:
            accessor["sparse"] = sparse
        self.accessors.append(accessor)
        return len(self.accessors) - 1

    def add_mesh(self, primitives) -> int:
        self.meshes.append({"primitives": primitives})
        return len(self.meshes) - 1

    def add_node(self, **kwargs) -> int:
        self.nodes.append(kwargs)
        return len(self.nodes) - 1

    def add_root(self, node_index: int):
        self.scenes[0]["nodes"].append(node_index)

    def write(self, path: str):
        gltf = {
            "asset": {"version": "2.0"},
            "scene": self.scene,
            "scenes": self.scenes,
            "nodes": self.nodes,
            "meshes": self.meshes,
            "accessors": self.accessors,
            "bufferViews": self.buffer_views,
            "buffers": [{"byteLength": len(self.bin)}],
        }
        json_chunk = json.dumps(gltf).encode("utf-8")
        json_chunk += b" " * ((-len(json_chunk)) % 4)
        bin_chunk = bytes(self.bin)
        bin_chunk += b"\x00" * ((-len(bin_chunk)) % 4)
        total = 12 + 8 + len(json_chunk) + 8 + len(bin_chunk)
        with open(path, "wb") as fh:
            fh.write(struct.pack("<III", 0x46546C67, 2, total))
            fh.write(struct.pack("<II", len(json_chunk), 0x4E4F534A))
            fh.write(json_chunk)
            fh.write(struct.pack("<II", len(bin_chunk), 0x004E4942))
            fh.write(bin_chunk)


def pack_vec3f(points) -> bytes:
    return struct.pack("<" + "f" * 3 * len(points),
                       *(c for p in points for c in p))


def pack_indices(values, component_type) -> bytes:
    fmt = {5121: "B", 5123: "H", 5125: "I"}[component_type]
    return struct.pack("<" + fmt * len(values), *values)


def translation_matrix(tx, ty, tz):
    return [
        [1.0, 0.0, 0.0, tx],
        [0.0, 1.0, 0.0, ty],
        [0.0, 0.0, 1.0, tz],
        [0.0, 0.0, 0.0, 1.0],
    ]


def identity_matrix():
    return translation_matrix(0.0, 0.0, 0.0)
