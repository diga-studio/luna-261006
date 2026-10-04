"""数据模型。"""
from dataclasses import dataclass
from typing import Dict, Tuple


@dataclass(frozen=True)
class UniqueKeyRule:
    """唯一键规则：由一组字段名组成。"""

    fields: Tuple[str, ...]


@dataclass(frozen=True)
class Entry:
    """条目：稳定 ID + 一组文本字段。"""

    entry_id: str
    fields: Dict[str, str]
