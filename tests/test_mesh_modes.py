"""TRIANGLES / TRIANGLE_STRIP / TRIANGLE_FAN 展开与拾取几何校验。"""
import math

from ar_anchor import ArAnnotationModel

from glb_factory import (
    GlbBuilder,
    identity_matrix,
    pack_indices,
    pack_vec3f,
)


def make_model(tmp_path, primitives, name="m.glb"):
    b = GlbBuilder()
    prims = []
    for points, indices, mode in primitives:
        view = b.add_buffer_view(pack_vec3f(points))
        pos_acc = b.add_accessor(5126, len(points), "VEC3", buffer_view=view)
        prim = {"attributes": {"POSITION": pos_acc}, "mode": mode}
        if indices is not None:
            idx_view = b.add_buffer_view(pack_indices(indices, 5123))
            prim["indices"] = b.add_accessor(5123, len(indices), "SCALAR",
                                             buffer_view=idx_view)
        prims.append(prim)
    mesh = b.add_mesh(prims)
    node = b.add_node(mesh=mesh)
    b.add_root(node)
    path = tmp_path / name
    b.write(str(path))
    return ArAnnotationModel(str(path))


def assert_vec_close(actual, expected, tol=1e-6):
    assert len(actual) == len(expected)
    for a, e in zip(actual, expected):
        assert math.isclose(a, e, abs_tol=tol), f"{actual} != {expected}"


def test_triangle_strip_indexed(tmp_path):
    """索引 TRIANGLE_STRIP：按 glTF 顶点顺序展开，非单位方向射线。"""
    points = [(0, 0, 0), (0, 1, 0), (1, 0, 0), (1, 1, 0), (2, 0, 0)]
    # 展开结果：t0=(0,1,2) t1=(2,1,3) t2=(2,3,4)
    model = make_model(tmp_path, [(points, [0, 1, 2, 3, 4], 5)])
    assert model.triangle_count == 3
    # 打 t1 的重心：(2/3, 2/3, 0)
    hit = model.pick(identity_matrix(), (2/3, 2/3, 5.0), (0, 0, -2.0))
    assert hit is not None
    assert_vec_close(hit.point, (2/3, 2/3, 0.0))
    assert math.isclose(hit.distance, 5.0, abs_tol=1e-6)
    assert hit.anchor.triangle_index == 1
    assert_vec_close(hit.anchor.barycentric, (1/3, 1/3, 1/3))
    # 打 t2 的重心：((1+1+2)/3, (0+1+0)/3, 0) = (4/3, 1/3, 0)
    hit = model.pick(identity_matrix(), (4/3, 1/3, 3.0), (0, 0, -1.0))
    assert hit is not None
    assert hit.anchor.triangle_index == 2
    assert math.isclose(hit.distance, 3.0, abs_tol=1e-6)


def test_triangle_fan_unindexed(tmp_path):
    """无索引 TRIANGLE_FAN。"""
    points = [(0, 0, 0), (1, 0, 0), (0, 1, 0), (-1, 0, 0)]
    # 展开结果：t0=(0,1,2) t1=(0,2,3)
    model = make_model(tmp_path, [(points, None, 6)])
    assert model.triangle_count == 2
    # t1 重心：((0+0-1)/3, (0+1+0)/3, 0) = (-1/3, 1/3, 0)
    hit = model.pick(identity_matrix(), (-1/3, 1/3, 2.0), (0, 0, -1.0))
    assert hit is not None
    assert_vec_close(hit.point, (-1/3, 1/3, 0.0))
    assert hit.anchor.triangle_index == 1
    assert_vec_close(hit.anchor.barycentric, (1/3, 1/3, 1/3))


def test_degenerate_triangles_keep_numbering(tmp_path):
    """退化三角形占编号但不参与命中。"""
    points = [(0, 0, 0), (1, 0, 0), (0, 1, 0), (5, 5, 0), (6, 5, 0), (5, 6, 0)]
    # t0 退化（顶点 0,0,1），t1 正常（顶点 3,4,5）
    indices = [0, 0, 1, 3, 4, 5]
    model = make_model(tmp_path, [(points, indices, 4)])
    assert model.triangle_count == 2
    # 命中正常三角形，编号必须是 1
    hit = model.pick(identity_matrix(), (5.25, 5.25, 1.0), (0, 0, -1.0))
    assert hit is not None
    assert hit.anchor.triangle_index == 1
    # 退化三角形区域无命中
    assert model.pick(identity_matrix(), (0.1, 0.0, 1.0), (0, 0, -1.0)) is None


def test_unindexed_triangles_and_backward_ray(tmp_path):
    """无索引 TRIANGLES；反方向命中不计。"""
    points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
    model = make_model(tmp_path, [(points, None, 4)])
    # 射线起点在三角形平面上方，方向朝上：前向无命中
    assert model.pick(identity_matrix(), (0.25, 0.25, 1.0), (0, 0, 1.0)) is None
    # 起点在平面下方，方向朝上：命中，距离 1
    hit = model.pick(identity_matrix(), (0.25, 0.25, -1.0), (0, 0, 1.0))
    assert hit is not None
    assert math.isclose(hit.distance, 1.0, abs_tol=1e-6)
    # 起点恰好在三角形内：距离为零
    hit = model.pick(identity_matrix(), (0.25, 0.25, 0.0), (0, 0, 1.0))
    assert hit is not None
    assert math.isclose(hit.distance, 0.0, abs_tol=1e-9)


def test_coplanar_ray_no_hit(tmp_path):
    """射线与三角形共面时不计命中。"""
    points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
    model = make_model(tmp_path, [(points, None, 4)])
    assert model.pick(identity_matrix(), (0.0, 0.0, 0.0), (1.0, 0.0, 0.0)) is None
    assert model.pick(identity_matrix(), (-1.0, 0.25, 0.0), (1.0, 0.0, 0.0)) is None
