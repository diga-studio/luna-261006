"""场景图遍历与节点世界变换（matrix 或 TRS，父子级联）。"""
from __future__ import annotations

import numpy as np

from .glb import GlbDocument


def quaternion_to_matrix(quat) -> np.ndarray:
    """xyzw 四元数转 3x3 旋转矩阵。"""
    x, y, z, w = quat
    n = float(x * x + y * y + z * z + w * w)
    if n == 0.0:
        return np.eye(3)
    s = 2.0 / n
    xx, yy, zz = x * x * s, y * y * s, z * z * s
    xy, xz, yz = x * y * s, x * z * s, y * z * s
    wx, wy, wz = w * x * s, w * y * s, w * z * s
    return np.array(
        [
            [1.0 - (yy + zz), xy - wz, xz + wy],
            [xy + wz, 1.0 - (xx + zz), yz - wx],
            [xz - wy, yz + wx, 1.0 - (xx + yy)],
        ]
    )


def node_local_matrix(node: dict) -> np.ndarray:
    """节点局部变换：matrix（列主序）或 TRS（先缩放、再旋转、后平移）。"""
    if "matrix" in node:
        m = np.array(node["matrix"], dtype=float).reshape(4, 4).T
        return m
    mat = np.eye(4)
    if "rotation" in node:
        mat[:3, :3] = quaternion_to_matrix(node["rotation"])
    if "scale" in node:
        mat[:3, :3] = mat[:3, :3] @ np.diag(node["scale"])
    if "translation" in node:
        mat[:3, 3] = node["translation"]
    return mat


def iter_scene_nodes(doc: GlbDocument, scene_index=None):
    """按先序遍历指定 scene 可达节点。

    产出 (node_index, world_matrix)，world_matrix 为 4x4 numpy 数组，
    将节点局部坐标变换到 glTF 场景根空间。
    """
    scenes = doc.json.get("scenes", [])
    if scene_index is None:
        scene_index = doc.json.get("scene", 0)
    if not scenes:
        return
    scene = scenes[scene_index]
    nodes = doc.json.get("nodes", [])

    def visit(node_index: int, parent_world: np.ndarray):
        node = nodes[node_index]
        world = parent_world @ node_local_matrix(node)
        yield node_index, world
        for child in node.get("children", []):
            yield from visit(child, world)

    identity = np.eye(4)
    for root in scene.get("nodes", []):
        yield from visit(root, identity)
