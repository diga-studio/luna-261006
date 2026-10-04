"""accessor 读取：交错布局、sparse 覆盖、无基础 bufferView、索引位宽。"""
import struct

import pytest

from ar_anchor.accessors import read_indices, read_vec3_float
from ar_anchor.glb import load_glb

from glb_factory import GlbBuilder, pack_indices, pack_vec3f


def test_interleaved_with_stride_and_offsets(tmp_path):
    """byteStride 交错 + bufferView/accessor 双重偏移 + sparse 覆盖。"""
    b = GlbBuilder()
    # 前缀垃圾字节，制造 bufferView 偏移
    b.add_data(b"\xaa" * 8)
    # 交错布局：每个顶点 20 字节 = 4 字节填充 + vec3 位置 + 4 字节填充
    points = [(1.0, 2.0, 3.0), (4.0, 5.0, 6.0), (7.0, 8.0, 9.0)]
    payload = b"".join(
        b"\x00" * 4 + pack_vec3f([p]) + b"\x00" * 4 for p in points
    )
    view = b.add_buffer_view(payload, byte_stride=20)
    # sparse：覆盖第 1 个顶点
    sparse_idx_view = b.add_buffer_view(pack_indices([1], 5121))
    sparse_val_view = b.add_buffer_view(pack_vec3f([(40.0, 50.0, 60.0)]))
    # accessor 自身再偏移：跳过第 0 个顶点（20 字节）并越过 4 字节前导填充
    acc = b.add_accessor(
        5126, 2, "VEC3", buffer_view=view, byte_offset=24,
        sparse={
            "count": 1,
            "indices": {"bufferView": sparse_idx_view, "componentType": 5121},
            "values": {"bufferView": sparse_val_view},
        },
    )
    path = tmp_path / "interleaved.glb"
    b.write(str(path))
    doc = load_glb(str(path))
    assert read_vec3_float(doc, acc) == [(4.0, 5.0, 6.0), (40.0, 50.0, 60.0)]


def test_sparse_without_base_buffer_view(tmp_path):
    """无基础 bufferView 的稀疏 accessor：未覆盖元素按零处理。"""
    b = GlbBuilder()
    sparse_idx_view = b.add_buffer_view(pack_indices([0, 3], 5123))
    sparse_val_view = b.add_buffer_view(
        pack_vec3f([(1.0, 0.0, 0.0), (0.0, 0.0, 2.0)])
    )
    acc = b.add_accessor(
        5126, 4, "VEC3", buffer_view=None,
        sparse={
            "count": 2,
            "indices": {"bufferView": sparse_idx_view, "componentType": 5123},
            "values": {"bufferView": sparse_val_view},
        },
    )
    path = tmp_path / "sparse_only.glb"
    b.write(str(path))
    doc = load_glb(str(path))
    assert read_vec3_float(doc, acc) == [
        (1.0, 0.0, 0.0),
        (0.0, 0.0, 0.0),
        (0.0, 0.0, 0.0),
        (0.0, 0.0, 2.0),
    ]


@pytest.mark.parametrize("component_type", [5121, 5123, 5125])
def test_index_widths(tmp_path, component_type):
    """u8 / u16 / u32 索引，含 accessor 偏移。"""
    b = GlbBuilder()
    b.add_data(b"\xbb" * 4)
    values = [0, 2, 1, 3]
    view = b.add_buffer_view(pack_indices(values, component_type))
    acc = b.add_accessor(5125 if False else component_type, 3, "SCALAR",
                         buffer_view=view, byte_offset={5121: 1, 5123: 2, 5125: 4}[component_type])
    path = tmp_path / "idx.glb"
    b.write(str(path))
    doc = load_glb(str(path))
    assert read_indices(doc, acc) == [2, 1, 3]


def test_sparse_indices(tmp_path):
    """索引 accessor 的 sparse 覆盖。"""
    b = GlbBuilder()
    view = b.add_buffer_view(pack_indices([0, 1, 2, 3, 4, 5], 5123))
    sparse_idx_view = b.add_buffer_view(pack_indices([4], 5121))
    sparse_val_view = b.add_buffer_view(pack_indices([2], 5123))
    acc = b.add_accessor(
        5123, 6, "SCALAR", buffer_view=view,
        sparse={
            "count": 1,
            "indices": {"bufferView": sparse_idx_view, "componentType": 5121},
            "values": {"bufferView": sparse_val_view},
        },
    )
    path = tmp_path / "sparse_idx.glb"
    b.write(str(path))
    doc = load_glb(str(path))
    assert read_indices(doc, acc) == [0, 1, 2, 3, 2, 5]
