"""glTF accessor decoding: bufferView offsets, byteStride, sparse overrides."""

import struct
from typing import Any, Dict, List, Tuple

_COMPONENT_FORMAT = {
    5120: ("b", 1),   # BYTE
    5121: ("B", 1),   # UNSIGNED_BYTE
    5122: ("h", 2),   # SHORT
    5123: ("H", 2),   # UNSIGNED_SHORT
    5125: ("I", 4),   # UNSIGNED_INT
    5126: ("f", 4),   # FLOAT
}

_TYPE_COMPONENTS = {
    "SCALAR": 1,
    "VEC2": 2,
    "VEC3": 3,
    "VEC4": 4,
    "MAT2": 4,
    "MAT3": 9,
    "MAT4": 16,
}


def _accessor_info(gltf: Dict[str, Any], accessor_index: int):
    accessor = gltf["accessors"][accessor_index]
    component_type = accessor["componentType"]
    fmt, comp_size = _COMPONENT_FORMAT[component_type]
    num_components = _TYPE_COMPONENTS[accessor["type"]]
    count = accessor["count"]
    return accessor, fmt, comp_size, num_components, count


def _read_elements(
    gltf: Dict[str, Any],
    bin_chunk: bytes,
    accessor_index: int,
) -> List[Tuple]:
    """Decode an accessor into a list of tuples, applying sparse overrides.

    Accessors without a base bufferView start from all-zero data.
    """
    accessor, fmt, comp_size, num_components, count = _accessor_info(gltf, accessor_index)
    element_size = comp_size * num_components

    if "bufferView" in accessor:
        buffer_view = gltf["bufferViews"][accessor["bufferView"]]
        buffer_index = buffer_view.get("buffer", 0)
        if buffer_index != 0:
            raise ValueError("only the embedded BIN buffer (index 0) is supported")
        base = buffer_view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
        stride = buffer_view.get("byteStride", element_size)
        if stride < element_size:
            raise ValueError("byteStride smaller than element size")
        elements = []
        for i in range(count):
            start = base + i * stride
            elements.append(
                struct.unpack_from("<" + fmt * num_components, bin_chunk, start)
            )
    else:
        elements = [(0,) * num_components] * count

    sparse = accessor.get("sparse")
    if sparse is not None:
        sparse_count = sparse["count"]
        idx_acc = {
            "componentType": sparse["indices"]["componentType"],
            "type": "SCALAR",
            "count": sparse_count,
            "bufferView": sparse["indices"]["bufferView"],
        }
        if "byteOffset" in sparse["indices"]:
            idx_acc["byteOffset"] = sparse["indices"]["byteOffset"]
        val_acc = {
            "componentType": accessor["componentType"],
            "type": accessor["type"],
            "count": sparse_count,
            "bufferView": sparse["values"]["bufferView"],
        }
        if "byteOffset" in sparse["values"]:
            val_acc["byteOffset"] = sparse["values"]["byteOffset"]
        tmp_gltf = dict(gltf)
        tmp_gltf["accessors"] = [idx_acc, val_acc]
        sparse_indices = _read_elements(tmp_gltf, bin_chunk, 0)
        sparse_values = _read_elements(tmp_gltf, bin_chunk, 1)
        elements = list(elements)
        for (target,), value in zip(sparse_indices, sparse_values):
            elements[target] = value
    return elements


def read_scalar_indices(
    gltf: Dict[str, Any], bin_chunk: bytes, accessor_index: int
) -> List[int]:
    """Decode a SCALAR unsigned-integer accessor (8/16/32-bit), with sparse support."""
    accessor = gltf["accessors"][accessor_index]
    if accessor["type"] != "SCALAR":
        raise ValueError("index accessor must be SCALAR")
    if accessor["componentType"] not in (5121, 5123, 5125):
        raise ValueError("index accessor must be unsigned 8/16/32-bit integer")
    return [int(e[0]) for e in _read_elements(gltf, bin_chunk, accessor_index)]


def read_vec3_positions(
    gltf: Dict[str, Any], bin_chunk: bytes, accessor_index: int
) -> List[Tuple[float, float, float]]:
    """Decode a VEC3 float32 accessor, with sparse support."""
    accessor = gltf["accessors"][accessor_index]
    if accessor["type"] != "VEC3":
        raise ValueError("position accessor must be VEC3")
    if accessor["componentType"] != 5126:
        raise ValueError("position accessor must be float32")
    return [tuple(map(float, e)) for e in _read_elements(gltf, bin_chunk, accessor_index)]
