"""accessor / bufferView 读取，含 sparse 覆盖与 byteStride。"""
from __future__ import annotations

import struct

from .glb import GlbDocument

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


def _buffer_view_bytes(doc: GlbDocument, view_index: int):
    views = doc.json.get("bufferViews", [])
    view = views[view_index]
    if view.get("buffer", 0) != 0:
        raise ValueError("仅支持单个内嵌 BIN buffer")
    start = view.get("byteOffset", 0)
    length = view["byteLength"]
    end = start + length
    if end > len(doc.bin_chunk):
        raise ValueError("bufferView 越界")
    return view, doc.bin_chunk[start:end]


def _read_elements(doc: GlbDocument, accessor: dict) -> list:
    """读取 accessor 的全部元素（未应用 sparse），每元素为分量元组。"""
    comp_type = accessor["componentType"]
    fmt, comp_size = _COMPONENT_FORMAT[comp_type]
    n_comp = _TYPE_COMPONENTS[accessor["type"]]
    count = accessor["count"]
    elem_size = comp_size * n_comp

    view_index = accessor.get("bufferView")
    if view_index is None:
        # 无基础 bufferView：全部元素按零处理
        return [tuple(0 for _ in range(n_comp)) for _ in range(count)]

    view, view_bytes = _buffer_view_bytes(doc, view_index)
    stride = view.get("byteStride")
    if stride is None:
        stride = elem_size
    if stride < elem_size:
        raise ValueError("byteStride 小于元素大小")
    base = accessor.get("byteOffset", 0)
    if count > 0 and base + (count - 1) * stride + elem_size > len(view_bytes):
        raise ValueError("accessor 数据越界")

    unpack_fmt = "<" + fmt * n_comp
    out = []
    for i in range(count):
        off = base + i * stride
        out.append(struct.unpack_from(unpack_fmt, view_bytes, off))
    return out


def _apply_sparse(doc: GlbDocument, accessor: dict, elements: list) -> list:
    sparse = accessor.get("sparse")
    if sparse is None:
        return elements
    comp_type = accessor["componentType"]
    fmt, comp_size = _COMPONENT_FORMAT[comp_type]
    n_comp = _TYPE_COMPONENTS[accessor["type"]]

    idx_view_idx = sparse["indices"]["bufferView"]
    _, idx_bytes = _buffer_view_bytes(doc, idx_view_idx)
    idx_comp = sparse["indices"]["componentType"]
    idx_fmt, idx_size = _COMPONENT_FORMAT[idx_comp]
    idx_base = sparse["indices"].get("byteOffset", 0)

    val_view_idx = sparse["values"]["bufferView"]
    _, val_bytes = _buffer_view_bytes(doc, val_view_idx)
    val_base = sparse["values"].get("byteOffset", 0)
    val_size = comp_size * n_comp

    count = sparse["count"]
    result = list(elements)
    for i in range(count):
        target = struct.unpack_from("<" + idx_fmt, idx_bytes, idx_base + i * idx_size)[0]
        value = struct.unpack_from("<" + fmt * n_comp, val_bytes, val_base + i * val_size)
        result[target] = value
    return result


def read_accessor(doc: GlbDocument, accessor_index: int) -> list:
    """读取 accessor（含 sparse 覆盖），返回分量元组列表。"""
    accessor = doc.json["accessors"][accessor_index]
    elements = _read_elements(doc, accessor)
    return _apply_sparse(doc, accessor, elements)


def read_vec3_float(doc: GlbDocument, accessor_index: int) -> list:
    """读取 VEC3/float32 accessor，返回 [(x, y, z), ...]。"""
    accessor = doc.json["accessors"][accessor_index]
    if accessor["componentType"] != 5126 or accessor["type"] != "VEC3":
        raise ValueError("位置 accessor 必须是 float32 VEC3")
    return [(float(x), float(y), float(z)) for x, y, z in read_accessor(doc, accessor_index)]


def read_indices(doc: GlbDocument, accessor_index: int) -> list:
    """读取 SCALAR 无符号整型 accessor（u8/u16/u32），返回 [int, ...]。"""
    accessor = doc.json["accessors"][accessor_index]
    if accessor["type"] != "SCALAR" or accessor["componentType"] not in (5121, 5123, 5125):
        raise ValueError("索引 accessor 必须是 u8/u16/u32 SCALAR")
    return [int(v[0]) for v in read_accessor(doc, accessor_index)]
