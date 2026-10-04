"""共享 mesh 多实例：嵌套旋转、负缩放、非均匀缩放、非单位方向射线。"""
import math

from ar_anchor import ArAnnotationModel

from glb_factory import GlbBuilder, identity_matrix, pack_vec3f

SQRT2_2 = math.sqrt(2.0) / 2.0


def build_shared_mesh_model(tmp_path):
    """一个三角形 mesh 被三个节点以不同变换实例化。

    mesh 三角形：p0=(0,0,0) p1=(1,0,0) p2=(0,1,0)
    node0: 绕 Y 轴旋转 90 度（四元数 xyzw）
    node1: node0 的子节点，平移 (0,0,5)，引用 mesh
           世界变换后三角形 -> (5,0,0) (5,0,-1) (5,1,0)
    node2: 根节点，matrix = T(10,0,0)*S(-2,1,1)（负缩放，列主序）
           三角形 -> (10,0,0) (8,0,0) (10,1,0)
    node3: 根节点，TRS 非均匀缩放 S(1,3,1) + 平移 (0,0,20)
           三角形 -> (0,0,20) (1,0,20) (0,3,20)
    """
    b = GlbBuilder()
    view = b.add_buffer_view(pack_vec3f([(0, 0, 0), (1, 0, 0), (0, 1, 0)]))
    pos = b.add_accessor(5126, 3, "VEC3", buffer_view=view)
    mesh = b.add_mesh([{"attributes": {"POSITION": pos}, "mode": 4}])

    n0 = b.add_node(rotation=[0.0, SQRT2_2, 0.0, SQRT2_2], children=[])
    n1 = b.add_node(translation=[0.0, 0.0, 5.0], mesh=mesh)
    b.nodes[n0]["children"] = [n1]
    # 列主序矩阵：T(10,0,0) * S(-2,1,1)
    n2 = b.add_node(matrix=[-2, 0, 0, 0,
                            0, 1, 0, 0,
                            0, 0, 1, 0,
                            10, 0, 0, 1], mesh=mesh)
    n3 = b.add_node(translation=[0.0, 0.0, 20.0], scale=[1.0, 3.0, 1.0],
                    mesh=mesh)
    for n in (n0, n2, n3):
        b.add_root(n)
    path = tmp_path / "shared.glb"
    b.write(str(path))
    return ArAnnotationModel(str(path))


def test_nested_rotation_instance(tmp_path):
    model = build_shared_mesh_model(tmp_path)
    # 非单位方向（模长 3），命中 node1 实例（三角形在 x=5 平面内）
    hit = model.pick(identity_matrix(), (8.0, 0.25, -0.25), (-3.0, 0.0, 0.0))
    assert hit is not None
    assert hit.anchor.node_index == 1
    assert math.isclose(hit.distance, 3.0, abs_tol=1e-6)
    assert hit.point == (5.0, 0.25, -0.25)
    # 重心：p = a + 0.25*(b-a) + 0.25*(c-a)
    for actual, expected in zip(hit.anchor.barycentric, (0.5, 0.25, 0.25)):
        assert math.isclose(actual, expected, abs_tol=1e-9)


def test_negative_scale_instance_via_matrix(tmp_path):
    model = build_shared_mesh_model(tmp_path)
    hit = model.pick(identity_matrix(), (9.0, 0.25, 1.0), (0.0, 0.0, -2.0))
    assert hit is not None
    assert hit.anchor.node_index == 2
    assert math.isclose(hit.distance, 1.0, abs_tol=1e-6)
    assert hit.point == (9.0, 0.25, 0.0)
    for actual, expected in zip(hit.anchor.barycentric, (0.25, 0.5, 0.25)):
        assert math.isclose(actual, expected, abs_tol=1e-9)


def test_nonuniform_scale_instance(tmp_path):
    model = build_shared_mesh_model(tmp_path)
    hit = model.pick(identity_matrix(), (0.4, 1.0, 25.0), (0.0, 0.0, -5.0))
    assert hit is not None
    assert hit.anchor.node_index == 3
    assert math.isclose(hit.distance, 5.0, abs_tol=1e-6)
    assert hit.point == (0.4, 1.0, 20.0)
    for actual, expected in zip(hit.anchor.barycentric, (1 - 0.4 - 1/3, 0.4, 1/3)):
        assert math.isclose(actual, expected, abs_tol=1e-9)


def test_deep_node_chain(tmp_path):
    """64 层嵌套平移，每层 z+1，最深的 mesh 三角形整体平移 64。"""
    b = GlbBuilder()
    view = b.add_buffer_view(pack_vec3f([(0, 0, 0), (1, 0, 0), (0, 1, 0)]))
    pos = b.add_accessor(5126, 3, "VEC3", buffer_view=view)
    mesh = b.add_mesh([{"attributes": {"POSITION": pos}, "mode": 4}])
    parent = None
    for depth in range(64):
        kwargs = {"translation": [0.0, 0.0, 1.0]}
        if depth == 63:
            kwargs["mesh"] = mesh
        node = b.add_node(**kwargs)
        if parent is not None:
            b.nodes[parent]["children"] = [node]
        else:
            b.add_root(node)
        parent = node
    path = tmp_path / "deep.glb"
    b.write(str(path))
    model = ArAnnotationModel(str(path))
    hit = model.pick(identity_matrix(), (0.25, 0.25, 100.0), (0.0, 0.0, -1.0))
    assert hit is not None
    assert hit.anchor.node_index == 63
    assert math.isclose(hit.point[2], 64.0, abs_tol=1e-6)
    assert math.isclose(hit.distance, 36.0, abs_tol=1e-6)
