"""构造测试用 IGES 文件字节的工具。"""

from __future__ import annotations

from typing import Dict, List, Tuple


def make_line(data: str, section: str, seq: int) -> bytes:
    """拼一条 80 字节物理行：数据列 + 段名 + 7 列序号。"""
    width = 64 if section == "P" else 72
    if section == "P":
        raise ValueError("P 行请使用 make_p_line")
    body = data.ljust(width)[:width]
    return f"{body}{section}{seq:7d}".encode("ascii")


def make_p_line(data: str, owner_de: int, seq: int) -> bytes:
    body = data.ljust(64)[:64]
    return f"{body}{owner_de:8d}P{seq:7d}".encode("ascii")


def make_d_pair(entity_type: int, p_start: int, p_count: int) -> Tuple[bytes, bytes]:
    first = f"{entity_type:8d}{p_start:8d}" + " " * 56
    second = f"{entity_type:8d}" + " " * 16 + f"{p_count:8d}" + " " * 40
    return first.encode("ascii"), second.encode("ascii")


def chunk(text: str, width: int) -> List[str]:
    return [text[i:i + width] for i in range(0, len(text), width)] or [""]


def build_file(
    g_data: str,
    entities: List[Tuple[int, str]],
    newline: str = "\n",
    s_lines: int = 1,
    p_order: List[int] = None,
) -> bytes:
    """根据 G 数据与实体列表（类型, P 数据）构造完整文件。

    entities 按 D 段出现顺序给出；p_order 可指定 P 段中实体区间的排列
    （元素为 entities 下标），默认与 D 顺序一致。
    """
    lines: List[bytes] = []
    for i in range(s_lines):
        lines.append(make_line(f"test S line {i + 1}", "S", i + 1))
    for i, part in enumerate(chunk(g_data, 72), start=1):
        lines.append(make_line(part, "G", i))

    order = p_order if p_order is not None else list(range(len(entities)))
    # 计算每个实体的 P 起始序号与行数
    p_start: Dict[int, int] = {}
    p_count: Dict[int, int] = {}
    cursor = 1
    for idx in order:
        p_start[idx] = cursor
        count = len(chunk(entities[idx][1], 64))
        p_count[idx] = count
        cursor += count

    d_seq = 1
    for idx, (entity_type, _) in enumerate(entities):
        first, second = make_d_pair(entity_type, p_start[idx], p_count[idx])
        lines.append(first + b"D" + f"{d_seq:7d}".encode())
        lines.append(second + b"D" + f"{d_seq + 1:7d}".encode())
        d_seq += 2

    p_seq = 1
    for idx in order:
        de_seq = 2 * idx + 1
        for part in chunk(entities[idx][1], 64):
            lines.append(make_p_line(part, de_seq, p_seq))
            p_seq += 1

    t_data = (
        f"S{s_lines:7d}G{len(chunk(g_data, 72)):7d}"
        f"D{2 * len(entities):7d}P{p_seq - 1:7d}"
    )
    lines.append(make_line(t_data, "T", 1))

    return newline.encode("ascii").join(lines) + newline.encode("ascii")
