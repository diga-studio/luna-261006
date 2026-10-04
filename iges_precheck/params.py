"""G/P 数据拼接后的参数词法解析（含 Hollerith 字符串）。"""
from __future__ import annotations

import re
from dataclasses import dataclass

from .errors import IgesPrecheckError

_HOLLERITH_RE = re.compile(r"(\d+)H")

_DECLARATIONS = {
    "1H,,1H;,": (",", ";"),
    "1H||1H!|": ("|", "!"),
}


@dataclass(frozen=True)
class Delimiters:
    """参数分隔符与结束符。"""

    delimiter: str
    terminator: str


def detect_delimiters(g_data: str) -> Delimiters:
    """从 G 段数据开头的 1H 声明识别分隔符组合。"""
    for prefix, pair in _DECLARATIONS.items():
        if g_data.startswith(prefix):
            return Delimiters(delimiter=pair[0], terminator=pair[1])
    raise IgesPrecheckError("G 段未以受支持的 1H 声明开头")


def parse_parameters(data: str, delims: Delimiters) -> list[str]:
    """解析参数序列，要求字符串外恰好一个结束符且其后只有空格。"""
    params: list[str] = []
    pos = 0
    size = len(data)
    while True:
        start = pos
        while pos < size and data[pos] == " ":
            pos += 1
        if pos >= size:
            raise IgesPrecheckError("参数数据缺少结束符")
        char = data[pos]
        if char == delims.terminator:
            pos += 1
            break
        if char == delims.delimiter:
            params.append("")
            pos += 1
            continue
        match = _HOLLERITH_RE.match(data, pos)
        if match:
            length = int(match.group(1))
            content_end = match.end() + length
            if content_end > size:
                raise IgesPrecheckError("Hollerith 字符串内容不足声明长度")
            params.append(data[pos:content_end])
            pos = content_end
            while pos < size and data[pos] == " ":
                pos += 1
            if pos >= size:
                raise IgesPrecheckError("Hollerith 字符串后缺少分隔符")
            if data[pos] == delims.delimiter:
                pos += 1
                continue
            if data[pos] == delims.terminator:
                pos += 1
                break
            raise IgesPrecheckError("Hollerith 字符串内容之后存在非法字符")
        end = pos
        while end < size and data[end] not in (delims.delimiter, delims.terminator):
            end += 1
        params.append(data[start:end])
        if end >= size:
            raise IgesPrecheckError("参数数据缺少结束符")
        pos = end + 1
        if data[end] == delims.terminator:
            break
    if data[pos:].strip(" "):
        raise IgesPrecheckError("结束符之后存在非空格内容")
    return params
