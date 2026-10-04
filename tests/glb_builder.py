"""Test helper: build GLB 2.0 files with full control over layout."""

import json
import struct
from typing import Any, Dict, List, Optional


class GlbBuilder:
    """Accumulates accessors/bufferViews/meshes/nodes and writes a GLB file."""

    def __init__(self) -> None:
        self._bin = bytearray()
        self.gltf: Dict[str, Any] = {
            "asset": {"version": "2.0"},
            "buffers": [],
            "bufferViews": [],
            "accessors": [],
            "meshes": [],
            "nodes": [],
            "scenes": [],
        }

    def _align(self, alignment: int = 4) -> None:
        while len(self._bin) % alignment:
            self._bin.append(0)

    def add_buffer(self, data: bytes, byte_stride: Optional[int] = None) -> int:
        """Append raw bytes as a bufferView; returns the bufferView index."""
        self._align()
        offset = len(self._bin)
        self._bin.extend(data)
        view: Dict[str, Any] = {
            "buffer": 0,
            "byteOffset": offset,
            "byteLength": len(data),
        }
        if byte_stride is not None:
            view["byteStride"] = byte_stride
        self.gltf["bufferViews"].append(view)
        return len(self.gltf["bufferViews"]) - 1

    def add_accessor(
        self,
        component_type: int,
        count: int,
        accessor_type: str,
        buffer_view: Optional[int] = None,
        byte_offset: Optional[int] = None,
        sparse: Optional[Dict[str, Any]] = None,
    ) -> int:
        accessor: Dict[str, Any] = {
            "componentType": component_type,
            "count": count,
            "type": accessor_type,
        }
        if buffer_view is not None:
            accessor["bufferView"] = buffer_view
        if byte_offset is not None:
            accessor["byteOffset"] = byte_offset
        if sparse is not None:
            accessor["sparse"] = sparse
        self.gltf["accessors"].append(accessor)
        return len(self.gltf["accessors"]) - 1

    def add_positions(self, positions, byte_stride: Optional[int] = None,
                      sparse: Optional[Dict[str, Any]] = None) -> int:
        """Add a VEC3 float32 position accessor (optionally interleaved)."""
        if byte_stride is None:
            data = b"".join(struct.pack("<fff", *p) for p in positions)
            view = self.add_buffer(data)
        else:
            assert byte_stride >= 12
            pad = b"\x00" * (byte_stride - 12)
            data = b"".join(struct.pack("<fff", *p) + pad for p in positions)
            view = self.add_buffer(data, byte_stride=byte_stride)
        return self.add_accessor(5126, len(positions), "VEC3", view, sparse=sparse)

    def add_indices(self, indices, component_type: int = 5123,
                    sparse: Optional[Dict[str, Any]] = None) -> int:
        """Add a SCALAR unsigned integer index accessor (5121/5123/5125)."""
        fmt = {5121: "B", 5123: "H", 5125: "I"}[component_type]
        data = b"".join(struct.pack("<" + fmt, i) for i in indices)
        view = self.add_buffer(data)
        return self.add_accessor(
            component_type, len(indices), "SCALAR", view, sparse=sparse
        )

    def make_sparse(self, indices, values: bytes, indices_component_type: int = 5123):
        """Build a sparse dict from raw index list and packed values bytes."""
        fmt = {5121: "B", 5123: "H", 5125: "I"}[indices_component_type]
        idx_data = b"".join(struct.pack("<" + fmt, i) for i in indices)
        idx_view = self.add_buffer(idx_data)
        val_view = self.add_buffer(values)
        return {
            "count": len(indices),
            "indices": {"bufferView": idx_view, "componentType": indices_component_type},
            "values": {"bufferView": val_view},
        }

    def add_mesh(self, primitives) -> int:
        """primitives: list of dicts with position/indices/mode keys."""
        prims = []
        for p in primitives:
            prim: Dict[str, Any] = {"attributes": {"POSITION": p["position"]}}
            if "indices" in p:
                prim["indices"] = p["indices"]
            if "mode" in p:
                prim["mode"] = p["mode"]
            prims.append(prim)
        self.gltf["meshes"].append({"primitives": prims})
        return len(self.gltf["meshes"]) - 1

    def add_node(self, mesh: Optional[int] = None, children=None, **transform) -> int:
        node: Dict[str, Any] = {}
        if mesh is not None:
            node["mesh"] = mesh
        if children is not None:
            node["children"] = list(children)
        node.update(transform)
        self.gltf["nodes"].append(node)
        return len(self.gltf["nodes"]) - 1

    def write(self, path: str, roots) -> None:
        self.gltf["scenes"].append({"nodes": list(roots)})
        self.gltf["scene"] = 0
        self.gltf["buffers"] = [{"byteLength": len(self._bin)}]
        payload = json.dumps(self.gltf).encode("utf-8")
        payload += b" " * (-len(payload) % 4)
        bin_chunk = bytes(self._bin)
        bin_chunk += b"\x00" * (-len(bin_chunk) % 4)
        body = struct.pack("<II", len(payload), 0x4E4F534A) + payload
        body += struct.pack("<II", len(bin_chunk), 0x004E4942) + bin_chunk
        glb = struct.pack("<III", 0x46546C67, 2, 12 + len(body)) + body
        with open(path, "wb") as fh:
            fh.write(glb)
