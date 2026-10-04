"""D 记录解析与 P 区间覆盖校验。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional

from .errors import PrecheckResult
from .fields import parse_int_field
from .sections import RawLine


@dataclass
class EntityRecord:
    """一个实体（两条 D 记录）的结构信息。"""

    de_seq: int        # 首条 D 记录的段内序号
    entity_type: int   # 实体类型号
    p_start: int       # 首条 P 记录的段内序号
    p_count: int       # 参数行数（正整数）


def parse_d_records(d_lines: List[RawLine], result: PrecheckResult) -> List[EntityRecord]:
    """解析 D 段，每两行一个实体。"""
    entities: List[EntityRecord] = []
    if len(d_lines) % 2 != 0:
        result.add("E_D_PAIRS", "D 段行数必须为偶数（每实体两行）")
        return entities

    for pair_start in range(0, len(d_lines), 2):
        first_lineno, first = d_lines[pair_start]
        second_lineno, second = d_lines[pair_start + 1]
        de_seq = pair_start + 1

        entity_type = parse_int_field(first[0:8].decode("ascii"))
        if entity_type is None:
            result.add("E_D_TYPE", "D 首行第 1-8 列实体类型格式非法", line=first_lineno)
            continue
        p_start = parse_int_field(first[8:16].decode("ascii"))
        if p_start is None:
            result.add("E_D_PTR", "D 首行第 9-16 列 P 指针格式非法", line=first_lineno)
            continue

        second_type = parse_int_field(second[0:8].decode("ascii"))
        if second_type is None:
            result.add("E_D_TYPE", "D 次行第 1-8 列实体类型格式非法", line=second_lineno)
            continue
        if second_type != entity_type:
            result.add(
                "E_D_TYPE",
                f"D 次行实体类型 {second_type} 与首行 {entity_type} 不一致",
                line=second_lineno,
            )
            continue
        p_count = parse_int_field(second[24:32].decode("ascii"))
        if p_count is None or p_count <= 0:
            result.add(
                "E_D_COUNT", "D 次行第 25-32 列参数行数必须为正整数", line=second_lineno
            )
            continue
        entities.append(
            EntityRecord(
                de_seq=de_seq, entity_type=entity_type, p_start=p_start, p_count=p_count
            )
        )
    return entities


def check_p_coverage(entities: List[EntityRecord], p_lines: List[RawLine],
                     result: PrecheckResult) -> None:
    """校验 P 区间连续、归属指回、全覆盖且不重叠。"""
    total = len(p_lines)
    # owner[p_seq - 1] = 覆盖该 P 记录的实体首条 D 序号
    owner: List[Optional[int]] = [None] * total

    for entity in entities:
        last = entity.p_start + entity.p_count - 1
        if entity.p_start < 1 or last > total:
            result.add(
                "E_P_RANGE",
                f"实体（D 序号 {entity.de_seq}）的 P 区间 "
                f"[{entity.p_start}, {last}] 超出 P 段范围 1..{total}",
            )
            continue
        for p_seq in range(entity.p_start, last + 1):
            lineno, content = p_lines[p_seq - 1]
            back_ptr = parse_int_field(content[64:72].decode("ascii"))
            if back_ptr is None:
                result.add("E_P_OWNER", "P 归属字段格式非法", line=lineno)
                continue
            if back_ptr != entity.de_seq:
                result.add(
                    "E_P_OWNER",
                    f"P 记录 {p_seq} 归属字段 {back_ptr} 未指回实体首条 D 记录 "
                    f"{entity.de_seq}",
                    line=lineno,
                )
            previous = owner[p_seq - 1]
            if previous is not None:
                result.add(
                    "E_P_OVERLAP",
                    f"P 记录 {p_seq} 同时被实体（D 序号 {previous}）与"
                    f"（D 序号 {entity.de_seq}）覆盖",
                    line=lineno,
                )
            else:
                owner[p_seq - 1] = entity.de_seq

    for p_seq, holder in enumerate(owner, start=1):
        if holder is None:
            lineno = p_lines[p_seq - 1][0]
            result.add("E_P_ORPHAN", f"P 记录 {p_seq} 未被任何实体覆盖", line=lineno)
