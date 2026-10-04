"""固定列整数字段解析：前补空格的十进制整数。"""

from __future__ import annotations

from typing import Optional


def parse_int_field(field: str) -> Optional[int]:
    """解析前补空格的十进制整数字段；格式非法时返回 None。"""
    if not field or field != field.rstrip(" "):
        return None
    text = field.strip(" ")
    if not text or not text.isdigit():
        return None
    return int(text)
