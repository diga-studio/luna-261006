"""把场景图展平为 glTF 根空间下的三角形数组。"""
from __future__ import annotations

import numpy as np

from .accessors import read_indices, read_vec3_float
from .glb import GlbDocument
from .mesh import expand_triangles
from .scene import iter_scene_nodes
from .types import SceneModel


def build_scene_model(doc: GlbDocument, scene_index=None) -> SceneModel:
    """遍历场景，展开所有 mesh 实例的三角形并变换到 glTF 根空间。"""
    model = SceneModel()
    model.node_count = len(doc.json.get("nodes", []))
    meshes = doc.json.get("meshes", [])

    positions_cache = {}
    indices_cache = {}
    triangles = []

    for node_index, world in iter_scene_nodes(doc, scene_index):
        node = doc.json["nodes"][node_index]
        if "mesh" not in node:
            continue
        mesh = meshes[node["mesh"]]
        for prim_index, primitive in enumerate(mesh.get("primitives", [])):
            mode = primitive.get("mode", 4)
            if mode not in (4, 5, 6):
                continue
            attributes = primitive.get("attributes", {})
            if "POSITION" not in attributes:
                continue
            pos_accessor = attributes["POSITION"]
            if pos_accessor not in positions_cache:
                positions_cache[pos_accessor] = read_vec3_float(doc, pos_accessor)
            positions = positions_cache[pos_accessor]

            idx_accessor = primitive.get("indices")
            indices = None
            if idx_accessor is not None:
                if idx_accessor not in indices_cache:
                    indices_cache[idx_accessor] = read_indices(doc, idx_accessor)
                indices = indices_cache[idx_accessor]

            expanded = expand_triangles(mode, len(positions), indices)
            rot = world[:3, :3]
            trans = world[:3, 3]
            for tri_index, (ia, ib, ic) in enumerate(expanded):
                va = rot @ np.array(positions[ia]) + trans
                vb = rot @ np.array(positions[ib]) + trans
                vc = rot @ np.array(positions[ic]) + trans
                flat = len(triangles)
                triangles.append((va, vb, vc))
                model.node_of_triangle.append(node_index)
                model.primitive_of_triangle.append(prim_index)
                model.triangle_of_primitive.append(tri_index)
                model.lookup[(node_index, prim_index, tri_index)] = flat

    if triangles:
        model.triangles = np.array(triangles, dtype=float)
    else:
        model.triangles = np.zeros((0, 3, 3), dtype=float)
    return model
