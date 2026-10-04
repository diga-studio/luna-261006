"""G 段全局参数与 P 段实体参数的词法解析（含 Hollerith 字符串）。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional

from .errors import PrecheckResult


@dataclass(frozen=True)
class Delimiters:
    """参数分隔符与结束符。"""

    param_sep: str    # ',' 或 '|'
    record_term: str  # ';' 或 '!'


@dataclass
class ParsedParams:
    """一段拼接参数数据的词法解析结果。"""

    params: List[Optional[str]]  # None 表示空参数；字符串参数保留原始内容
    ok: bool


_HEADER_PREFIXES = {
    "1H,,1H;,": Delimiters(param_sep=",", record_term=";"),
    "1H||1H!|": Delimiters(param_sep="|", record_term="!"),
}


def parse_global_header(g_data: str, result: PrecheckResult) -> Optional[Delimiters]:
    """解析 G 段前两项（1H, / 1H| 形式），返回分隔符组。"""
    for prefix, delim in _HEADER_PREFIXES.items():
        if g_data.startswith(prefix):
            return delim
    result.add(
        "E_G_HEADER",
        "G 段开头不是受支持的分隔符声明（1H,,1H;, 或 1H||1H!|）",
    )
    return None


def parse_params(data: str, delim: Delimiters, result: PrecheckResult,
                 context: str) -> ParsedParams:
    """解析拼接后的参数字符串，要求字符串外恰好一个结束符且其后只有空格。"""
    params: List[Optional[str]] = []
    ok = True
    pos = 0
    end = len(data)

    while True:
        # 忽略前导空格后判断是否为 Hollerith 字符串（非负整数 n 紧跟 H）
        probe = pos
        while probe < end and data[probe] == " ":
            probe += 1
        digits_end = probe
        while digits_end < end and data[digits_end].isdigit():
            digits_end += 1
        is_hollerith = (
            digits_end > probe
            and digits_end < end
            and data[digits_end] == "H"
        )

        if is_hollerith:
            count = int(data[probe:digits_end])
            content_start = digits_end + 1
            content_end = content_start + count
            if content_end > end:
                result.add(
                    "E_HOLLERITH",
                    f"{context}：Hollerith 字符串声明长度 {count} 超出剩余数据",
                )
                return ParsedParams(params=params, ok=False)
            params.append(data[content_start:content_end])
            # 内容之后只能有空格及一个分隔符
            cursor = content_end
            while cursor < end and data[cursor] == " ":
                cursor += 1
            if cursor >= end:
                result.add("E_SEP", f"{context}：Hollerith 字符串后缺少分隔符")
                return ParsedParams(params=params, ok=False)
            symbol = data[cursor]
            if symbol == delim.param_sep:
                pos = cursor + 1
                continue
            if symbol == delim.record_term:
                pos = cursor + 1
                break
            result.add(
                "E_SEP",
                f"{context}：Hollerith 字符串内容之后出现非法字符 {symbol!r}",
            )
            return ParsedParams(params=params, ok=False)

        # 其他参数：不解释语义，扫描到下一个分隔符
        cursor = pos
        while cursor < end and data[cursor] not in (delim.param_sep, delim.record_term):
            cursor += 1
        raw = data[pos:cursor].strip(" ")
        params.append(raw if raw else None)
        if cursor >= end:
            result.add("E_TERM", f"{context}：缺少结束符 {delim.record_term!r}")
            return ParsedParams(params=params, ok=False)
        if data[cursor] == delim.param_sep:
            pos = cursor + 1
            continue
        pos = cursor + 1
        break

    # 结束符之后只允许空格
    if data[pos:].strip(" "):
        result.add("E_TERM", f"{context}：结束符之后存在非空格内容")
        ok = False
    return ParsedParams(params=params, ok=ok)
