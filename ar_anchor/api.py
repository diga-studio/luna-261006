"""Public API: Scene loading, ray picking, anchor replay."""

import math
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple

from .accessors import read_scalar_indices, read_vec3_positions
from .geometry import expand_triangles, ray_triangle
from .glb import load_glb
from .scenegraph import Mat4, collect_world_transforms, mat_mul

Vec3 = Tuple[float, float, float]

#: Hits within this distance (meters) of the closest hit are tied and resolved
#: by ascending (node, primitive, triangle) order.
TIE_TOLERANCE = 1e-8


@dataclass(frozen=True)
class Anchor:
    """Savable anchor: node instance + primitive + triangle + barycentric coords.

    Barycentric coordinates are relative to the triangle's vertex order after
    glTF winding expansion. The caller is responsible for persisting anchors.
    """

    node: int
    primitive: int
    triangle: int
    barycentric: Tuple[float, float, float]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "node": self.node,
            "primitive": self.primitive,
            "triangle": self.triangle,
            "barycentric": list(self.barycentric),
        }

    @staticmethod
    def from_dict(data: Dict[str, Any]) -> "Anchor":
        return Anchor(
            node=int(data["node"]),
            primitive=int(data["primitive"]),
            triangle=int(data["triangle"]),
            barycentric=tuple(float(c) for c in data["barycentric"]),
        )


@dataclass(frozen=True)
class PickResult:
    """Closest forward ray hit: project-space point, distance in meters, anchor."""

    point: Vec3
    distance: float
    anchor: Anchor


class _Primitive:
    __slots__ = ("node", "index", "positions", "triangles", "world")

    def __init__(self, node: int, index: int, positions, triangles, world: Mat4):
        self.node = node
        self.index = index
        self.positions = positions  # mesh-local VEC3 list
        self.triangles = triangles  # expanded (i0, i1, i2) triples
        self.world = world  # node world transform (model space)


def _as_mat4(transform: Sequence) -> Mat4:
    """Accept a 4x4 nested sequence (row-major) or a flat 16-element sequence."""
    items = list(transform)
    if len(items) == 16 and not isinstance(items[0], (list, tuple)):
        flat = [float(v) for v in items]
        return [flat[0:4], flat[4:8], flat[8:12], flat[12:16]]
    rows = [list(r) for r in items]
    if len(rows) == 4 and all(len(r) == 4 for r in rows):
        return [[float(v) for v in r] for r in rows]
    raise ValueError("transform must be a 4x4 matrix or a flat 16-element sequence")


def _transform_point(m: Mat4, p: Vec3) -> Vec3:
    return (
        m[0][0] * p[0] + m[0][1] * p[1] + m[0][2] * p[2] + m[0][3],
        m[1][0] * p[0] + m[1][1] * p[1] + m[1][2] * p[2] + m[1][3],
        m[2][0] * p[0] + m[2][1] * p[1] + m[2][2] * p[2] + m[2][3],
    )


class Scene:
    """A parsed GLB scene held in memory.

    The model is a static triangle mesh scene from a GLB 2.0 file; all data
    comes from the embedded BIN chunk. Project space is right-handed, Y-up,
    in meters.
    """

    def __init__(self, gltf: Dict[str, Any], bin_chunk: bytes, scene_index: int):
        self._gltf = gltf
        self._scene_index = scene_index
        world = collect_world_transforms(gltf, scene_index)
        self._primitives: List[_Primitive] = []
        self._by_key: Dict[Tuple[int, int], _Primitive] = {}
        for node_index, node_world in enumerate(world):
            if node_world is None:
                continue
            node = gltf.get("nodes", [])[node_index]
            if "mesh" not in node:
                continue
            mesh = gltf["meshes"][node["mesh"]]
            for prim_index, prim in enumerate(mesh.get("primitives", [])):
                mode = prim.get("mode", 4)
                if mode not in (4, 5, 6):
                    continue
                attributes = prim.get("attributes", {})
                if "POSITION" not in attributes:
                    continue
                positions = read_vec3_positions(gltf, bin_chunk, attributes["POSITION"])
                if "indices" in prim:
                    indices = read_scalar_indices(gltf, bin_chunk, prim["indices"])
                else:
                    indices = list(range(len(positions)))
                triangles = expand_triangles(mode, indices)
                record = _Primitive(node_index, prim_index, positions, triangles, node_world)
                self._primitives.append(record)
                self._by_key[(node_index, prim_index)] = record

    @staticmethod
    def load(path: str, scene: Optional[int] = None) -> "Scene":
        """Load a GLB 2.0 file into memory.

        `scene` selects the glTF scene index; defaults to the file's default
        scene (or scene 0 when the file declares none).
        """
        gltf, bin_chunk = load_glb(path)
        if scene is None:
            scene = gltf.get("scene", 0)
        return Scene(gltf, bin_chunk, scene)

    @property
    def triangle_count(self) -> int:
        return sum(len(p.triangles) for p in self._primitives)

    def pick(
        self,
        ray_origin: Sequence[float],
        ray_direction: Sequence[float],
        model_to_project: Sequence[Sequence[float]],
    ) -> Optional[PickResult]:
        """Cast a ray in project space; return the closest forward hit or None.

        `model_to_project` is the caller's current invertible affine transform
        (row-major 4x4 or flat 16). The ray direction need not be unit length;
        the returned distance is measured in meters along the ray.
        """
        transform = _as_mat4(model_to_project)
        origin = (float(ray_origin[0]), float(ray_origin[1]), float(ray_origin[2]))
        direction = (
            float(ray_direction[0]),
            float(ray_direction[1]),
            float(ray_direction[2]),
        )
        dir_len = math.sqrt(
            direction[0] ** 2 + direction[1] ** 2 + direction[2] ** 2
        )
        if dir_len == 0.0:
            raise ValueError("ray direction must be non-zero")

        hits = []
        for prim in self._primitives:
            m = mat_mul(transform, prim.world)
            positions = prim.positions
            for tri_index, (i0, i1, i2) in enumerate(prim.triangles):
                v0 = _transform_point(m, positions[i0])
                v1 = _transform_point(m, positions[i1])
                v2 = _transform_point(m, positions[i2])
                hit = ray_triangle(origin, direction, v0, v1, v2)
                if hit is None:
                    continue
                t, b0, b1, b2 = hit
                distance = t * dir_len
                point = (
                    origin[0] + direction[0] * t,
                    origin[1] + direction[1] * t,
                    origin[2] + direction[2] * t,
                )
                hits.append(
                    (distance, (prim.node, prim.index, tri_index), point, (b0, b1, b2))
                )
        if not hits:
            return None
        min_distance = min(h[0] for h in hits)
        best = min(
            (h for h in hits if h[0] <= min_distance + TIE_TOLERANCE),
            key=lambda h: h[1],
        )
        distance, key, point, bary = best
        return PickResult(
            point=point,
            distance=distance,
            anchor=Anchor(node=key[0], primitive=key[1], triangle=key[2], barycentric=bary),
        )

    def replay(
        self, anchor: Anchor, model_to_project: Sequence[Sequence[float]]
    ) -> Vec3:
        """Return the anchor's current project-space position.

        Uses the same model file with the caller's new model-to-project
        transform; the anchor stays on the same relative spot of the same
        triangle of the same node instance, regardless of new occlusions.
        """
        prim = self._by_key.get((anchor.node, anchor.primitive))
        if prim is None:
            raise ValueError(
                f"anchor references unknown primitive "
                f"(node={anchor.node}, primitive={anchor.primitive})"
            )
        if anchor.triangle < 0 or anchor.triangle >= len(prim.triangles):
            raise ValueError(f"anchor triangle index out of range: {anchor.triangle}")
        transform = _as_mat4(model_to_project)
        m = mat_mul(transform, prim.world)
        i0, i1, i2 = prim.triangles[anchor.triangle]
        v0 = _transform_point(m, prim.positions[i0])
        v1 = _transform_point(m, prim.positions[i1])
        v2 = _transform_point(m, prim.positions[i2])
        b0, b1, b2 = anchor.barycentric
        return (
            b0 * v0[0] + b1 * v1[0] + b2 * v2[0],
            b0 * v0[1] + b1 * v1[1] + b2 * v2[1],
            b0 * v0[2] + b1 * v1[2] + b2 * v2[2],
        )
