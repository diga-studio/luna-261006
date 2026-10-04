"""Scene graph traversal and node transform math (glTF 2.0 semantics)."""

from typing import Any, Dict, List, Optional

Mat4 = List[List[float]]  # row-major 4x4

IDENTITY: Mat4 = [
    [1.0, 0.0, 0.0, 0.0],
    [0.0, 1.0, 0.0, 0.0],
    [0.0, 0.0, 1.0, 0.0],
    [0.0, 0.0, 0.0, 1.0],
]


def mat_mul(a: Mat4, b: Mat4) -> Mat4:
    return [
        [sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)]
        for i in range(4)
    ]


def mat_from_column_major(values) -> Mat4:
    """glTF stores matrices column-major as a flat array of 16 floats."""
    if len(values) != 16:
        raise ValueError("matrix must have 16 elements")
    return [[float(values[c * 4 + r]) for c in range(4)] for r in range(4)]


def quat_to_mat(x: float, y: float, z: float, w: float) -> Mat4:
    """Rotation matrix from a glTF xyzw quaternion (not assumed normalized)."""
    n = (x * x + y * y + z * z + w * w) ** 0.5
    if n == 0.0:
        raise ValueError("zero quaternion")
    x, y, z, w = x / n, y / n, z / n, w / n
    return [
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 0.0],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 0.0],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ]


def trs_to_mat(translation, rotation, scale) -> Mat4:
    """Local matrix from TRS: scale first, then rotate, then translate (M = T*R*S)."""
    r = quat_to_mat(*rotation) if rotation is not None else IDENTITY
    sx, sy, sz = scale if scale is not None else (1.0, 1.0, 1.0)
    tx, ty, tz = translation if translation is not None else (0.0, 0.0, 0.0)
    return [
        [r[0][0] * sx, r[0][1] * sy, r[0][2] * sz, tx],
        [r[1][0] * sx, r[1][1] * sy, r[1][2] * sz, ty],
        [r[2][0] * sx, r[2][1] * sy, r[2][2] * sz, tz],
        [0.0, 0.0, 0.0, 1.0],
    ]


def node_local_matrix(node: Dict[str, Any]) -> Mat4:
    if "matrix" in node:
        return mat_from_column_major(node["matrix"])
    return trs_to_mat(node.get("translation"), node.get("rotation"), node.get("scale"))


def collect_world_transforms(
    gltf: Dict[str, Any], scene_index: int
) -> List[Optional[Mat4]]:
    """World transform per glTF node index; None for nodes unreachable from the scene."""
    nodes = gltf.get("nodes", [])
    world: List[Optional[Mat4]] = [None] * len(nodes)
    scenes = gltf.get("scenes", [])
    if scene_index < 0 or scene_index >= len(scenes):
        raise ValueError(f"scene index out of range: {scene_index}")
    roots = scenes[scene_index].get("nodes", [])

    def visit(node_index: int, parent_world: Mat4, depth: int) -> None:
        if depth > 64:
            raise ValueError("node hierarchy deeper than 64 levels")
        if world[node_index] is not None:
            raise ValueError(f"node {node_index} visited twice (not a tree)")
        world[node_index] = mat_mul(parent_world, node_local_matrix(nodes[node_index]))
        for child in nodes[node_index].get("children", []):
            visit(child, world[node_index], depth + 1)

    for root in roots:
        visit(root, IDENTITY, 1)
    return world
