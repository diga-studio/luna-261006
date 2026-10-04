"""Triangle expansion (TRIANGLES/STRIP/FAN) and ray-triangle intersection."""

from typing import List, Optional, Sequence, Tuple

Vec3 = Tuple[float, float, float]

MODE_TRIANGLES = 4
MODE_TRIANGLE_STRIP = 5
MODE_TRIANGLE_FAN = 6


def expand_triangles(mode: int, indices: Sequence[int]) -> List[Tuple[int, int, int]]:
    """Expand an index sequence into per-triangle vertex index triples.

    Winding follows glTF 2.0: strips swap vertex order on odd triangles,
    fans pivot on the first vertex. Degenerate triangles keep their numbering.
    """
    n = len(indices)
    triangles: List[Tuple[int, int, int]] = []
    if mode == MODE_TRIANGLES:
        for i in range(0, n - n % 3, 3):
            triangles.append((indices[i], indices[i + 1], indices[i + 2]))
    elif mode == MODE_TRIANGLE_STRIP:
        for i in range(n - 2):
            if i % 2 == 0:
                triangles.append((indices[i], indices[i + 1], indices[i + 2]))
            else:
                triangles.append((indices[i + 1], indices[i], indices[i + 2]))
    elif mode == MODE_TRIANGLE_FAN:
        for i in range(1, n - 1):
            triangles.append((indices[0], indices[i], indices[i + 1]))
    else:
        raise ValueError(f"unsupported primitive mode: {mode}")
    return triangles


def _sub(a: Vec3, b: Vec3) -> Vec3:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _cross(a: Vec3, b: Vec3) -> Vec3:
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def _dot(a: Vec3, b: Vec3) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def ray_triangle(
    origin: Vec3, direction: Vec3, v0: Vec3, v1: Vec3, v2: Vec3
) -> Optional[Tuple[float, float, float, float]]:
    """Moller-Trumbore intersection, double-sided, forward hits only (t >= 0).

    Returns (t, u, v, w) where t is the ray parameter and (u, v, w) the
    barycentric coordinates relative to (v0, v1, v2), or None when there is
    no forward hit. Degenerate triangles and rays parallel to (including
    coplanar with) the triangle plane never hit.
    """
    edge1 = _sub(v1, v0)
    edge2 = _sub(v2, v0)
    pvec = _cross(direction, edge2)
    det = _dot(edge1, pvec)
    if det == 0.0:
        return None
    inv_det = 1.0 / det
    tvec = _sub(origin, v0)
    u = _dot(tvec, pvec) * inv_det
    if u < 0.0 or u > 1.0:
        return None
    qvec = _cross(tvec, edge1)
    v = _dot(direction, qvec) * inv_det
    if v < 0.0 or u + v > 1.0:
        return None
    t = _dot(edge2, qvec) * inv_det
    if t < 0.0:
        return None
    return (t, 1.0 - u - v, u, v)
