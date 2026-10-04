"""端到端：交错+稀疏几何经拾取得到可独立验证的结果；10 万三角形规模。"""
import math
import struct
import time

from ar_anchor import ArAnnotationModel

from glb_factory import (
    GlbBuilder,
    identity_matrix,
    pack_indices,
    pack_vec3f,
)


def build_interleaved_sparse_model(tmp_path):
    """交错布局 + sparse 覆盖的位置数据，经拾取验证几何。

    基础数据：两个三角形共 4 个顶点（STRIP），sparse 把顶点 1 挪到
    (0, 2, 0)，最终三角形：
      t0 = (0,0,0) (0,2,0) (2,0,0)
      t1 = (2,0,0) (0,2,0) (2,2,0)
    """
    b = GlbBuilder()
    base_points = [(0, 0, 0), (0, 1, 0), (2, 0, 0), (2, 2, 0)]
    # 交错：每顶点 16 字节 = vec3 位置 + 4 字节其它属性
    payload = b"".join(pack_vec3f([p]) + b"\x01" * 4 for p in base_points)
    view = b.add_buffer_view(payload, byte_stride=16)
    sparse_idx = b.add_buffer_view(pack_indices([1], 5121))
    sparse_val = b.add_buffer_view(pack_vec3f([(0.0, 2.0, 0.0)]))
    pos = b.add_accessor(
        5126, 4, "VEC3", buffer_view=view,
        sparse={
            "count": 1,
            "indices": {"bufferView": sparse_idx, "componentType": 5121},
            "values": {"bufferView": sparse_val},
        },
    )
    mesh = b.add_mesh([{"attributes": {"POSITION": pos}, "mode": 5}])
    b.add_root(b.add_node(mesh=mesh))
    path = tmp_path / "e2e.glb"
    b.write(str(path))
    return ArAnnotationModel(str(path))


def test_interleaved_sparse_pick(tmp_path):
    model = build_interleaved_sparse_model(tmp_path)
    # t1 重心：(4/3, 4/3, 0)
    hit = model.pick(identity_matrix(), (4/3, 4/3, 2.0), (0.0, 0.0, -1.0))
    assert hit is not None
    assert hit.anchor.triangle_index == 1
    for actual, expected in zip(hit.point, (4/3, 4/3, 0.0)):
        assert math.isclose(actual, expected, abs_tol=1e-6)
    # 顶点 1 被 sparse 挪到 y=2 后，(0, 1.5) 处应在 t0 内
    hit = model.pick(identity_matrix(), (0.2, 1.5, 2.0), (0.0, 0.0, -1.0))
    assert hit is not None
    assert hit.anchor.triangle_index == 0


def test_hundred_thousand_triangles(tmp_path):
    """10 万三角形场景：加载与拾取在可接受时间内完成。"""
    n = 316  # 316*316 个方格 * 2 三角形 ≈ 20 万，取一半方向即可
    points = []
    for row in range(51):
        for col in range(51):
            points.append((float(col), float(row), 0.0))
    indices = []
    for row in range(50):
        for col in range(50):
            a = row * 51 + col
            bidx = a + 1
            c = a + 51
            d = c + 1
            indices += [a, bidx, c, bidx, d, c]
    # 单实例 5000 三角形，20 个实例共 10 万三角形
    b = GlbBuilder()
    view = b.add_buffer_view(pack_vec3f(points))
    pos = b.add_accessor(5126, len(points), "VEC3", buffer_view=view)
    idx_view = b.add_buffer_view(pack_indices(indices, 5123))
    idx = b.add_accessor(5123, len(indices), "SCALAR", buffer_view=idx_view)
    mesh = b.add_mesh([{"attributes": {"POSITION": pos}, "indices": idx,
                        "mode": 4}])
    for inst in range(20):
        b.add_root(b.add_node(
            translation=[0.0, 0.0, float(inst) * 10.0], mesh=mesh))
    path = tmp_path / "big.glb"
    b.write(str(path))

    start = time.perf_counter()
    model = ArAnnotationModel(str(path))
    load_seconds = time.perf_counter() - start
    assert model.triangle_count == 100000

    start = time.perf_counter()
    hit = model.pick(identity_matrix(), (25.5, 25.5, 300.0), (0.0, 0.0, -1.0))
    pick_seconds = time.perf_counter() - start
    assert hit is not None
    assert hit.anchor.node_index == 19  # 最上层实例（z=190）
    assert math.isclose(hit.point[2], 190.0, abs_tol=1e-6)
    assert load_seconds < 30.0
    assert pick_seconds < 5.0
