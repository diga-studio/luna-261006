"""射线拾取与锚点回放。

约定：model_to_project 为 4x4 行主序可逆仿射矩阵，把 glTF 根空间
坐标变换到项目空间（右手 Y 向上，单位米）。射线起点与方向在项目
空间给出，方向不要求单位长度。
"""
from __future__ import annotations

from typing import Optional

import numpy as np

from .types import Anchor, RayHit, SceneModel

_TIE_TOLERANCE_M = 1e-8  # 同距命中判定阈值（米）
_DET_EPS = 1e-12  # 共面/退化判定的相对阈值
_BARY_EPS = 1e-9  # 重心坐标边界容差


def _as_matrix(model_to_project) -> np.ndarray:
    mat = np.asarray(model_to_project, dtype=float)
    if mat.shape != (4, 4):
        raise ValueError("model_to_project 必须是 4x4 矩阵")
    return mat


def ray_pick(
    model: SceneModel,
    model_to_project,
    origin,
    direction,
) -> Optional[RayHit]:
    """在项目空间发射射线，返回前向最近命中或 None。"""
    mat = _as_matrix(model_to_project)
    inv = np.linalg.inv(mat)
    o = np.asarray(origin, dtype=float)
    d = np.asarray(direction, dtype=float)
    if o.shape != (3,) or d.shape != (3,):
        raise ValueError("origin 与 direction 必须是三维向量")
    if not np.any(d):
        raise ValueError("direction 不能是零向量")

    # 把射线变换到 glTF 根空间；仿射变换保持射线参数 t 一致
    o_root = inv[:3, :3] @ o + inv[:3, 3]
    d_root = inv[:3, :3] @ d

    tris = model.triangles
    if tris.shape[0] == 0:
        return None
    a = tris[:, 0, :]
    b = tris[:, 1, :]
    c = tris[:, 2, :]
    e1 = b - a
    e2 = c - a

    d_bcast = np.broadcast_to(d_root, e2.shape)
    pvec = np.cross(d_bcast, e2)
    det = np.einsum("ij,ij->i", e1, pvec)

    # 退化三角形与共面射线：det 相对为零，不参与命中
    scale = (
        np.linalg.norm(e1, axis=1)
        * np.linalg.norm(e2, axis=1)
        * np.linalg.norm(d_root)
    )
    valid = np.abs(det) > _DET_EPS * np.maximum(scale, 1e-300)

    inv_det = np.zeros_like(det)
    inv_det[valid] = 1.0 / det[valid]

    tvec = o_root - a
    u = np.einsum("ij,ij->i", tvec, pvec) * inv_det
    qvec = np.cross(tvec, e1)
    v = np.einsum("ij,ij->i", np.broadcast_to(d_root, e1.shape), qvec) * inv_det
    t = np.einsum("ij,ij->i", e2, qvec) * inv_det

    hit = (
        valid
        & (t >= 0.0)
        & (u >= -_BARY_EPS)
        & (v >= -_BARY_EPS)
        & (u + v <= 1.0 + _BARY_EPS)
    )
    if not np.any(hit):
        return None

    dir_len = float(np.linalg.norm(d))
    distances = np.where(hit, t * dir_len, np.inf)
    best = float(np.min(distances))
    # 与最短距离之差不超过 1e-8 米的命中，按 (node, primitive, triangle) 字典序
    tied = np.nonzero(hit & (distances <= best + _TIE_TOLERANCE_M))[0]
    winner = min(
        tied,
        key=lambda i: (
            model.node_of_triangle[i],
            model.primitive_of_triangle[i],
            model.triangle_of_primitive[i],
        ),
    )

    t_hit = max(float(t[winner]), 0.0)
    point = o + t_hit * d
    bu = min(max(float(u[winner]), 0.0), 1.0)
    bv = min(max(float(v[winner]), 0.0), 1.0)
    if bu + bv > 1.0:
        s = 1.0 / (bu + bv)
        bu *= s
        bv *= s
    bary = (1.0 - bu - bv, bu, bv)

    anchor = Anchor(
        node_index=model.node_of_triangle[winner],
        primitive_index=model.primitive_of_triangle[winner],
        triangle_index=model.triangle_of_primitive[winner],
        barycentric=bary,
    )
    return RayHit(
        point=(float(point[0]), float(point[1]), float(point[2])),
        distance=t_hit * dir_len,
        anchor=anchor,
    )


def replay_anchor(
    model: SceneModel,
    model_to_project,
    anchor: Anchor,
):
    """用新的模型到项目变换回放锚点，返回项目坐标三元组。"""
    mat = _as_matrix(model_to_project)
    key = (anchor.node_index, anchor.primitive_index, anchor.triangle_index)
    if key not in model.lookup:
        raise ValueError(f"锚点不对应任何场景三角形: {key}")
    flat = model.lookup[key]
    verts = model.triangles[flat]
    w = np.asarray(anchor.barycentric, dtype=float)
    if w.shape != (3,):
        raise ValueError("barycentric 必须是三维向量")
    p_root = w[0] * verts[0] + w[1] * verts[1] + w[2] * verts[2]
    p_project = mat[:3, :3] @ p_root + mat[:3, 3]
    return (float(p_project[0]), float(p_project[1]), float(p_project[2]))
