"""公共数据类型：锚点、命中结果、场景模型。"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Tuple

Vec3 = Tuple[float, float, float]


@dataclass(frozen=True)
class Anchor:
    """可序列化的标注锚点。

    通过 (node, primitive, triangle) 唯一定位一个实例化三角形，
    重心坐标相对于该三角形的顶点顺序记录。
    """

    node_index: int
    primitive_index: int
    triangle_index: int
    barycentric: Tuple[float, float, float]

    def to_dict(self) -> dict:
        return {
            "node_index": self.node_index,
            "primitive_index": self.primitive_index,
            "triangle_index": self.triangle_index,
            "barycentric": list(self.barycentric),
        }

    @staticmethod
    def from_dict(data: dict) -> "Anchor":
        return Anchor(
            node_index=int(data["node_index"]),
            primitive_index=int(data["primitive_index"]),
            triangle_index=int(data["triangle_index"]),
            barycentric=tuple(float(v) for v in data["barycentric"]),
        )


@dataclass(frozen=True)
class RayHit:
    """射线拾取结果。"""

    point: Vec3
    distance: float
    anchor: Anchor


@dataclass
class SceneModel:
    """展平后的场景三角形数据（glTF 根空间），全部驻留内存。"""

    triangles: object = None  # numpy 数组，形状 (N, 3, 3)
    node_of_triangle: list = field(default_factory=list)
    primitive_of_triangle: list = field(default_factory=list)
    triangle_of_primitive: list = field(default_factory=list)
    lookup: dict = field(default_factory=dict)  # (node, prim, tri) -> 扁平序号
    node_count: int = 0
