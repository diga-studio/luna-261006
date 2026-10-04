"""Acceptance tests for the ar_anchor library."""

import os
import struct
import tempfile

import pytest

from ar_anchor import Anchor, Scene
from glb_builder import GlbBuilder

IDENTITY = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]


def write_tmp(builder: GlbBuilder, roots, name: str = "m.glb") -> str:
    path = os.path.join(tempfile.mkdtemp(), name)
    builder.write(path, roots)
    return path


def assert_vec_close(actual, expected, tol=1e-6):
    assert len(actual) == len(expected)
    for a, e in zip(actual, expected):
        assert abs(a - e) <= tol, f"{actual} != {expected}"


# 1. Interleaved positions (byteStride) + sparse overrides on positions and
#    8-bit indices; non-unit ray direction; origin-on-surface zero distance.
def test_interleaved_with_sparse_overrides():
    b = GlbBuilder()
    positions = [(0, 0, 0), (1, 0, 0), (0, 1, 0), (1, 1, 0)]
    sparse_pos = b.make_sparse([1], struct.pack("<fff", 2.0, 0.0, 0.0))
    pos = b.add_positions(positions, byte_stride=16, sparse=sparse_pos)
    sparse_idx = b.make_sparse([1], struct.pack("<B", 1), indices_component_type=5121)
    idx = b.add_indices([0, 0, 2], component_type=5121, sparse=sparse_idx)
    mesh = b.add_mesh([{"position": pos, "indices": idx}])
    node = b.add_node(mesh=mesh)
    scene = Scene.load(write_tmp(b, [node]))

    # Effective triangle: (0,0,0), (2,0,0), (0,1,0) after sparse overrides.
    hit = scene.pick((0.5, 0.1, 3.0), (0, 0, -6), IDENTITY)
    assert hit is not None
    assert_vec_close(hit.point, (0.5, 0.1, 0.0))
    assert hit.distance == pytest.approx(3.0, abs=1e-6)
    assert (hit.anchor.node, hit.anchor.primitive, hit.anchor.triangle) == (0, 0, 0)
    assert_vec_close(hit.anchor.barycentric, (0.65, 0.25, 0.1))

    # Ray origin on the surface: distance is exactly zero.
    hit0 = scene.pick((0.5, 0.1, 0.0), (0, 0, -6), IDENTITY)
    assert hit0 is not None and hit0.distance == 0.0


# 2. Sparse accessor without a base bufferView: uncovered elements are zero;
#    16-bit indices.
def test_sparse_without_base_buffer_view():
    b = GlbBuilder()
    values = struct.pack("<fff", 10, 10, 0) + struct.pack("<fff", 11, 10, 0)
    values += struct.pack("<fff", 10, 11, 0)
    sparse_pos = b.make_sparse([0, 1, 2], values, indices_component_type=5123)
    pos = b.add_accessor(5126, 4, "VEC3", sparse=sparse_pos)  # no bufferView
    idx = b.add_indices([0, 1, 2, 1, 2, 3], component_type=5123)
    mesh = b.add_mesh([{"position": pos, "indices": idx}])
    node = b.add_node(mesh=mesh)
    scene = Scene.load(write_tmp(b, [node]))

    # Triangle 1 uses vertex 3, which defaults to (0,0,0).
    hit = scene.pick((0.2, 0.2, 1.0), (0, 0, -1), IDENTITY)
    assert hit is not None
    assert hit.anchor.triangle == 1
    assert_vec_close(hit.point, (0.2, 0.2, 0.0))
    # Barycentric relative to triangle 1 vertex order: (11,10,0),(10,11,0),(0,0,0).
    b01 = 0.2 / 21.0
    assert_vec_close(hit.anchor.barycentric, (b01, b01, 1 - 2 * b01))


# 3. TRIANGLE_STRIP (indexed, 32-bit) and TRIANGLE_FAN (non-indexed); fan
#    shares the position accessor. Degenerate strip triangles keep numbering.
def test_strip_and_fan_modes():
    b = GlbBuilder()
    pos_strip = b.add_positions([(0, 0, 0), (1, 0, 0), (1, 1, 0), (2, 1, 0)])
    pos_fan = b.add_positions([(5, 5, 0), (6, 5, 0), (6, 6, 0), (5, 6, 0)])
    strip_idx = b.add_indices([0, 1, 2, 3], component_type=5125)
    mesh = b.add_mesh([
        {"position": pos_strip, "indices": strip_idx, "mode": 5},
        {"position": pos_fan, "mode": 6},  # non-indexed fan uses vertices 0..3
    ])
    node = b.add_node(mesh=mesh)
    scene = Scene.load(write_tmp(b, [node]))

    # Strip triangle 1 has vertex order (2,1,3) -> (1,1),(1,0),(2,1).
    hit = scene.pick((1.2, 0.8, 1.0), (0, 0, -1), IDENTITY)
    assert hit is not None
    assert (hit.anchor.primitive, hit.anchor.triangle) == (0, 1)
    assert_vec_close(hit.anchor.barycentric, (0.6, 0.2, 0.2))

    # Fan triangle 1 has vertex order (0,2,3) -> (5,5),(6,6),(5,6).
    hit = scene.pick((5.4, 5.6, 1.0), (0, 0, -1), IDENTITY)
    assert hit is not None
    assert (hit.anchor.primitive, hit.anchor.triangle) == (1, 1)
    assert_vec_close(hit.anchor.barycentric, (0.4, 0.4, 0.2))


def test_degenerate_triangles_keep_numbering():
    b = GlbBuilder()
    positions = [(0, 0, 0), (1, 0, 0), (0, 1, 0), (5, 0, 0), (5, 1, 0)]
    pos = b.add_positions(positions)
    # Repeated index 2 makes strip triangles 1 and 2 degenerate.
    idx = b.add_indices([0, 1, 2, 2, 3, 4], component_type=5123)
    mesh = b.add_mesh([{"position": pos, "indices": idx, "mode": 5}])
    node = b.add_node(mesh=mesh)
    scene = Scene.load(write_tmp(b, [node]))
    assert scene.triangle_count == 4

    # Triangle 3 has vertex order (3,2,4) -> (5,0),(0,1),(5,1).
    hit = scene.pick((4.5, 0.9, 1.0), (0, 0, -1), IDENTITY)
    assert hit is not None
    assert hit.anchor.triangle == 3
    assert_vec_close(hit.anchor.barycentric, (0.1, 0.1, 0.8))


# 4. One mesh instanced by two nodes under a matrix-form root with nested
#    rotation, non-uniform and negative scale; non-unit ray direction.
def test_shared_mesh_instances_nested_transforms():
    b = GlbBuilder()
    pos = b.add_positions([(0, 0, 0), (1, 0, 0), (0, 1, 0)])
    mesh = b.add_mesh([{"position": pos}])
    # Root: T(1,2,3) * Rz(90deg), supplied as a column-major matrix.
    root_matrix = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1]
    node_a = b.add_node(mesh=mesh, scale=[2, 3, 1])
    node_b = b.add_node(mesh=mesh, translation=[0, 5, 0], scale=[-1, 1, 1])
    root = b.add_node(matrix=root_matrix, children=[node_a, node_b])
    scene = Scene.load(write_tmp(b, [root]))

    # Instance A world triangle: (1,2,3), (1,4,3), (-2,2,3).
    # Instance B world triangle: (-4,2,3), (-4,1,3), (-5,2,3).
    # Model->project: translation (100,50,1000), given as a flat 16 sequence.
    m2p = [1, 0, 0, 100, 0, 1, 0, 50, 0, 0, 1, 1000, 0, 0, 0, 1]
    hit = scene.pick((100.0, 53.0, 1010.0), (0, 0, -20), m2p)
    assert hit is not None
    assert hit.anchor.node == node_a  # not the negatively scaled instance B
    assert hit.distance == pytest.approx(7.0, abs=1e-6)
    assert_vec_close(hit.point, (100.0, 53.0, 1003.0))
    assert_vec_close(hit.anchor.barycentric, (1 / 6, 0.5, 1 / 3))

    # A ray aimed at instance B must resolve to B (negative scale is valid).
    hit_b = scene.pick((100 - 4.2, 51.8, 1010.0), (0, 0, -20), m2p)
    assert hit_b is not None
    assert hit_b.anchor.node == node_b
    assert hit_b.distance == pytest.approx(7.0, abs=1e-6)


# 5. Equal-distance hits resolve to lexicographically smallest
#    (node, primitive, triangle).
def test_tie_breaking_node_primitive_triangle():
    b = GlbBuilder()
    pos = b.add_positions([(0, 0, 0), (1, 0, 0), (0, 1, 0)])
    mesh_two_prims = b.add_mesh([{"position": pos}, {"position": pos}])
    node0 = b.add_node(mesh=mesh_two_prims)
    node1 = b.add_node(mesh=mesh_two_prims)  # same transform as node0
    scene = Scene.load(write_tmp(b, [node0, node1]))

    hit = scene.pick((0.25, 0.25, 1.0), (0, 0, -1), IDENTITY)
    assert hit is not None
    assert (hit.anchor.node, hit.anchor.primitive, hit.anchor.triangle) == (0, 0, 0)


def test_tie_breaking_shared_edge():
    b = GlbBuilder()
    pos = b.add_positions([(0, 0, 0), (1, 0, 0), (0, 1, 0), (1, 1, 0)])
    idx = b.add_indices([0, 1, 2, 3], component_type=5123)
    mesh = b.add_mesh([{"position": pos, "indices": idx, "mode": 5}])
    node = b.add_node(mesh=mesh)
    scene = Scene.load(write_tmp(b, [node]))

    # Ray through the shared edge midpoint hits both strip triangles.
    hit = scene.pick((0.5, 0.5, 1.0), (0, 0, -1), IDENTITY)
    assert hit is not None
    assert hit.anchor.triangle == 0
    assert_vec_close(hit.anchor.barycentric, (0.0, 0.5, 0.5))


def test_no_hit_returns_none():
    b = GlbBuilder()
    pos = b.add_positions([(0, 0, 0), (1, 0, 0), (0, 1, 0)])
    mesh = b.add_mesh([{"position": pos}])
    node = b.add_node(mesh=mesh)
    scene = Scene.load(write_tmp(b, [node]))
    assert scene.pick((5.0, 5.0, 1.0), (0, 0, -1), IDENTITY) is None
    assert scene.pick((0.25, 0.25, 1.0), (0, 0, 1), IDENTITY) is None  # behind


# 6. Replay after recalibration: translation+rotation+scale; the anchor keeps
#    its original ownership even where another component now occludes it.
def test_replay_after_recalibration_with_occlusion():
    b = GlbBuilder()
    pos_a = b.add_positions([(0, 0, 0), (1, 0, 0), (0, 1, 0)])
    # Instance B sits above instance A's original spot in model space, so the
    # initial pick must come from below to belong to A.
    pos_b = b.add_positions([(0.5, 0.5, 0.25), (0.5, 0, 0.25), (1, 0.5, 0.25)])
    mesh_a = b.add_mesh([{"position": pos_a}])
    mesh_b = b.add_mesh([{"position": pos_b}])
    node_a = b.add_node(mesh=mesh_a)
    node_b = b.add_node(mesh=mesh_b)
    scene = Scene.load(write_tmp(b, [node_a, node_b]))

    hit = scene.pick((0.6, 0.25, -1.0), (0, 0, 1), IDENTITY)
    assert hit is not None and hit.anchor.node == node_a
    assert hit.distance == pytest.approx(1.0, abs=1e-6)
    anchor = Anchor.from_dict(hit.anchor.to_dict())  # caller-side persistence

    # Recalibrate: rotate 90deg about Z, scale by 2, translate by (10,0,-1).
    # Instance A's triangle moves directly under instance B's triangle.
    recalibrated = [
        [0, -2, 0, 10],
        [2, 0, 0, 0],
        [0, 0, 2, -1],
        [0, 0, 0, 1],
    ]
    point = scene.replay(anchor, recalibrated)
    # Model point (0.6,0.25,0) -> scale (1.2,0.5,0) -> rotate (-0.5,1.2,0)
    # -> translate (9.5,1.2,-1).
    assert_vec_close(point, (9.5, 1.2, -1.0))

    # A fresh pick at the replayed spot hits occluding instance B first,
    # but the anchor still belongs to instance A.
    above = (point[0], point[1], point[2] + 5.0)
    occluded = scene.pick(above, (0, 0, -1), recalibrated)
    assert occluded is not None and occluded.anchor.node == node_b
    assert occluded.distance == pytest.approx(4.5, abs=1e-6)
    assert scene.replay(occluded.anchor, recalibrated) != point
    assert_vec_close(scene.replay(anchor, recalibrated), (9.5, 1.2, -1.0))


def test_anchor_round_trip_and_errors():
    anchor = Anchor(node=3, primitive=1, triangle=7, barycentric=(0.2, 0.3, 0.5))
    assert Anchor.from_dict(anchor.to_dict()) == anchor

    b = GlbBuilder()
    pos = b.add_positions([(0, 0, 0), (1, 0, 0), (0, 1, 0)])
    mesh = b.add_mesh([{"position": pos}])
    node = b.add_node(mesh=mesh)
    scene = Scene.load(write_tmp(b, [node]))
    with pytest.raises(ValueError):
        scene.replay(anchor, IDENTITY)
    with pytest.raises(ValueError):
        scene.replay(Anchor(0, 0, 99, (0.0, 0.0, 1.0)), IDENTITY)
