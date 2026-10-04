"""primitive 三角形展开：TRIANGLES / TRIANGLE_STRIP / TRIANGLE_FAN。"""
from __future__ import annotations

MODE_TRIANGLES = 4
MODE_TRIANGLE_STRIP = 5
MODE_TRIANGLE_FAN = 6

_SUPPORTED = (MODE_TRIANGLES, MODE_TRIANGLE_STRIP, MODE_TRIANGLE_FAN)


def expand_triangles(mode: int, vertex_count: int, indices) -> list:
    """按 glTF 2.0 顶点顺序把 primitive 展开为三角形顶点索引三元组列表。

    退化三角形仍占编号，原样保留在结果中。
    """
    if mode not in _SUPPORTED:
        raise ValueError(f"不支持的 primitive mode: {mode}")
    sequence = list(indices) if indices is not None else list(range(vertex_count))

    triangles = []
    if mode == MODE_TRIANGLES:
        for i in range(0, len(sequence) - 2, 3):
            triangles.append((sequence[i], sequence[i + 1], sequence[i + 2]))
    elif mode == MODE_TRIANGLE_STRIP:
        for i in range(len(sequence) - 2):
            a, b, c = sequence[i], sequence[i + 1], sequence[i + 2]
            if i % 2 == 1:
                a, b = b, a
            triangles.append((a, b, c))
    else:  # MODE_TRIANGLE_FAN
        for i in range(1, len(sequence) - 1):
            triangles.append((sequence[0], sequence[i], sequence[i + 1]))
    return triangles
