"""D 段（目录段）实体条目解析。"""
from __future__ import annotations

import re
from dataclasses import dataclass

from .errors import IgesPrecheckError
from .sections import RawLine

_INT_FIELD_RE = re.compile(r"^ *\d+$")


@dataclass(frozen=True)
class EntityDir:
    """一个实体的目录信息。"""

    type_id: int
    first_p: int
    param_lines: int
    d_seq: int


def parse_int_field(text: str) -> int:
    """解析前补空格的十进制整数字段。"""
    if not _INT_FIELD_RE.match(text):
        raise IgesPrecheckError(f"整数字段非法：{text!r}")
    return int(text)


def parse_entities(d_lines: list[RawLine]) -> list[EntityDir]:
    """每两行解析为一个实体目录条目。"""
    if len(d_lines) % 2 != 0:
        raise IgesPrecheckError("D 段行数必须为偶数")
    entities: list[EntityDir] = []
    for index in range(0, len(d_lines), 2):
        first, second = d_lines[index], d_lines[index + 1]
        type_id = parse_int_field(first.data[0:8])
        first_p = parse_int_field(first.data[8:16])
        type_again = parse_int_field(second.data[0:8])
        if type_again != type_id:
            raise IgesPrecheckError(
                f"D 段第 {second.seq} 行实体类型与首行不一致"
            )
        param_lines = parse_int_field(second.data[24:32])
        if param_lines <= 0:
            raise IgesPrecheckError(
                f"D 段第 {second.seq} 行参数行数必须为正整数"
            )
        entities.append(
            EntityDir(
                type_id=type_id,
                first_p=first_p,
                param_lines=param_lines,
                d_seq=first.seq,
            )
        )
    return entities
