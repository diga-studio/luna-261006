"""同距命中仲裁与校准后的锚点回放。"""
import math

import numpy as np

from ar_anchor import Anchor, ArAnnotationModel

from glb_factory import GlbBuilder, identity_matrix, pack_vec3f, translation_matrix


def make_two_triangle_model(tmp_path, name="tie.glb"):
    """node0 的 mesh 含两个共享一条边的三角形（z=0 平面）。"""
    b = GlbBuilder()
    points = [(0, 0, 0), (2, 0, 0), (0, 2, 0), (2, 2, 0)]
    view = b.add_buffer_view(pack_vec3f(points))
    pos = b.add_accessor(5126, 4, "VEC3", buffer_view=view)
    prim = {"attributes": {"POSITION": pos}, "mode": 5}  # STRIP: t0=(0,1,2) t1=(2,1,3)
    mesh = b.add_mesh([prim])
    node = b.add_node(mesh=mesh)
    b.add_root(node)
    path = tmp_path / name
    b.write(str(path))
    return ArAnnotationModel(str(path))


def test_edge_tie_same_mesh(tmp_path):
    """射线打在公共边中点：两个三角形同距，取三角形序号最小者。"""
    model = make_two_triangle_model(tmp_path)
    hit = model.pick(identity_matrix(), (1.0, 1.0, 3.0), (0.0, 0.0, -1.0))
    assert hit is not None
    assert hit.anchor.triangle_index == 0
    assert math.isclose(hit.distance, 3.0, abs_tol=1e-6)
    assert hit.point == (1.0, 1.0, 0.0)


def test_tie_across_nodes_and_primitives(tmp_path):
    """不同 node / 不同 primitive 的完全重叠三角形：按字典序取最小。"""
    b = GlbBuilder()
    points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
    view = b.add_buffer_view(pack_vec3f(points))
    pos = b.add_accessor(5126, 3, "VEC3", buffer_view=view)
    # mesh0 含两个完全相同的 primitive
    mesh0 = b.add_mesh([
        {"attributes": {"POSITION": pos}, "mode": 4},
        {"attributes": {"POSITION": pos}, "mode": 4},
    ])
    mesh1 = b.add_mesh([{"attributes": {"POSITION": pos}, "mode": 4}])
    n0 = b.add_node(mesh=mesh0)
    n1 = b.add_node(mesh=mesh1)
    b.add_root(n0)
    b.add_root(n1)
    path = tmp_path / "tie_nodes.glb"
    b.write(str(path))
    model = ArAnnotationModel(str(path))
    assert model.triangle_count == 3
    hit = model.pick(identity_matrix(), (0.25, 0.25, 1.0), (0.0, 0.0, -1.0))
    assert hit is not None
    assert (hit.anchor.node_index, hit.anchor.primitive_index,
            hit.anchor.triangle_index) == (0, 0, 0)


def make_occlusion_model(tmp_path):
    """node0：z=0 平面小三角形 A；node1：z=5 平面大三角形 B（覆盖 A）。"""
    b = GlbBuilder()
    tri_a = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
    tri_b = [(-1, -1, 5), (3, -1, 5), (-1, 3, 5)]
    meshes = []
    for tri in (tri_a, tri_b):
        view = b.add_buffer_view(pack_vec3f(tri))
        pos = b.add_accessor(5126, 3, "VEC3", buffer_view=view)
        meshes.append(b.add_mesh([{"attributes": {"POSITION": pos}, "mode": 4}]))
    for mesh in meshes:
        b.add_root(b.add_node(mesh=mesh))
    path = tmp_path / "occlusion.glb"
    b.write(str(path))
    return ArAnnotationModel(str(path))


def test_replay_after_recalibration_with_occlusion(tmp_path):
    """校准改变平移/旋转/缩放后，锚点仍落在原实例原三角形的同一相对位置。"""
    model = make_occlusion_model(tmp_path)
    m1 = translation_matrix(10.0, 0.0, 0.0)

    # 从下方发射：A 在前（z=0），B 在后（z=5），锚点落在 A 上
    hit = model.pick(m1, (10.25, 0.25, -1.0), (0.0, 0.0, 2.0))
    assert hit is not None
    assert hit.anchor.node_index == 0
    assert math.isclose(hit.distance, 1.0, abs_tol=1e-6)

    # 从上方看 A 被 B 遮挡：命中的是 B，证明 A 的原位置确有遮挡
    above = model.pick(m1, (10.25, 0.25, 10.0), (0.0, 0.0, -1.0))
    assert above is not None
    assert above.anchor.node_index == 1

    # 锚点序列化往返（调用方保存/恢复）
    saved = Anchor.from_dict(hit.anchor.to_dict())
    assert saved == hit.anchor

    # 重新校准：缩放 2 倍 + 绕 Y 旋转 90 度 + 平移 (0,7,0)
    rot_y90 = np.array([[0, 0, 1, 0], [0, 1, 0, 0], [-1, 0, 0, 0], [0, 0, 0, 1]],
                       dtype=float)
    scale2 = np.diag([2.0, 2.0, 2.0, 1.0])
    m2 = translation_matrix(0.0, 7.0, 0.0) @ rot_y90 @ scale2

    # 独立计算期望值：p2 = M2 @ M1^-1 @ p1
    p1 = np.array([*hit.point, 1.0])
    expected = (np.array(m2) @ (np.linalg.inv(np.array(m1)) @ p1))[:3]

    replayed = model.replay(m2, saved)
    for actual, exp in zip(replayed, expected):
        assert math.isclose(actual, exp, abs_tol=1e-6)

    # 回放结果确实落在 node0 三角形的新位置上（x=0 平面内）
    assert math.isclose(replayed[0], 0.0, abs_tol=1e-9)
    # 遮挡关系不影响归属：锚点仍属于 node0
    assert saved.node_index == 0


def test_replay_rejects_unknown_anchor(tmp_path):
    model = make_occlusion_model(tmp_path)
    bad = Anchor(node_index=0, primitive_index=0, triangle_index=99,
                 barycentric=(1.0, 0.0, 0.0))
    try:
        model.replay(identity_matrix(), bad)
    except ValueError:
        pass
    else:
        raise AssertionError("应当拒绝不存在的三角形")
