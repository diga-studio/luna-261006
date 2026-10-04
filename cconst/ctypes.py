"""C11 整数类型系统（固定目标平台约定）。

平台约定：char=8 位有符号，short=16 位，int/long=32 位，long long=64 位，
均二补码。仅支持这些类型及其 signed/unsigned 形式。
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import IntEnum


class Rank(IntEnum):
    """整数转换阶（conversion rank），随类型等级递增。"""

    CHAR = 1
    SHORT = 2
    INT = 3
    LONG = 4
    LLONG = 5


_WIDTHS = {
    Rank.CHAR: 8,
    Rank.SHORT: 16,
    Rank.INT: 32,
    Rank.LONG: 32,
    Rank.LLONG: 64,
}

_NAMES = {
    Rank.CHAR: "char",
    Rank.SHORT: "short",
    Rank.INT: "int",
    Rank.LONG: "long",
    Rank.LLONG: "long long",
}


@dataclass(frozen=True)
class CType:
    """一个 C 整数类型：转换阶 + 是否有符号。"""

    rank: Rank
    signed: bool

    @property
    def width(self) -> int:
        return _WIDTHS[self.rank]

    @property
    def min_value(self) -> int:
        if self.signed:
            return -(1 << (self.width - 1))
        return 0

    @property
    def max_value(self) -> int:
        if self.signed:
            return (1 << (self.width - 1)) - 1
        return (1 << self.width) - 1

    def can_represent(self, other: "CType") -> bool:
        """本类型是否能表示 other 类型的全部值。"""
        return self.min_value <= other.min_value and other.max_value <= self.max_value

    def __str__(self) -> str:
        prefix = "" if self.signed else "unsigned "
        return prefix + _NAMES[self.rank]


SCHAR = CType(Rank.CHAR, True)
UCHAR = CType(Rank.CHAR, False)
SHORT = CType(Rank.SHORT, True)
USHORT = CType(Rank.SHORT, False)
INT = CType(Rank.INT, True)
UINT = CType(Rank.INT, False)
LONG = CType(Rank.LONG, True)
ULONG = CType(Rank.LONG, False)
LLONG = CType(Rank.LLONG, True)
ULLONG = CType(Rank.LLONG, False)


def integer_promote(ctype: CType) -> CType:
    """整数提升：阶低于 int 的类型提升为 int（本平台 int 可表示其全部值）。"""
    if ctype.rank < Rank.INT:
        return INT
    return ctype


def usual_arithmetic_conversion(left: CType, right: CType) -> CType:
    """通常算术转换（C11 6.3.1.8，仅整数情形），返回公共类型。"""
    if left == right:
        return left
    if left.signed == right.signed:
        return left if left.rank >= right.rank else right
    unsigned_t, signed_t = (left, right) if not left.signed else (right, left)
    if unsigned_t.rank >= signed_t.rank:
        return unsigned_t
    if signed_t.can_represent(unsigned_t):
        return signed_t
    return canonical(CType(signed_t.rank, False))


def convert_value(value: int, ctype: CType) -> int:
    """把数学整数值转换到指定类型：按位宽保留低位后按符号性作二补码解释。"""
    mask = (1 << ctype.width) - 1
    low = value & mask
    if ctype.signed and low >= (1 << (ctype.width - 1)):
        low -= 1 << ctype.width
    return low


# --- 整数字面量类型推断（C11 6.4.4.1）---

_SUFFIXES = ("ull", "llu", "ll", "ul", "lu", "u", "l", "")


def split_suffix(text: str) -> tuple[str, str]:
    """把字面量文本拆成（数值部分, 规范化后缀）。后缀统一小写、u 在前。"""
    lower = text.lower()
    for suffix in _SUFFIXES:
        if suffix and lower.endswith(suffix):
            suffix = "".join(sorted(suffix))  # 'lu'/'ul' -> 'lu', 'llu'/'ull' -> 'llu'
            return text[: -len(suffix)], suffix
    return text, ""


def literal_type(value: int, base: int, suffix: str) -> CType:
    """按 C11 6.4.4.1 的候选类型顺序，为字面量确定第一个能表示 value 的类型。

    suffix 为规范化形式：''、'u'、'l'、'lu'、'll'、'llu'。
    输入保证字面量能由某个候选类型表示。
    """
    decimal = base == 10
    if suffix == "":
        candidates = [INT, LONG, LLONG] if decimal else [INT, UINT, LONG, ULONG, LLONG, ULLONG]
    elif suffix == "u":
        candidates = [UINT, ULONG, ULLONG]
    elif suffix == "l":
        candidates = [LONG, LLONG] if decimal else [LONG, ULONG, LLONG, ULLONG]
    elif suffix == "lu":
        candidates = [ULONG, ULLONG]
    elif suffix == "ll":
        candidates = [LLONG] if decimal else [LLONG, ULLONG]
    elif suffix == "llu":
        candidates = [ULLONG]
    else:  # pragma: no cover - 词法层已过滤
        raise ValueError(f"unknown suffix: {suffix!r}")
    for ctype in candidates:
        if ctype.min_value <= value <= ctype.max_value:
            return ctype
    raise ValueError(f"literal value {value} not representable")  # pragma: no cover


_CANONICAL = {
    (rank, signed): ctype
    for ctype in (SCHAR, UCHAR, SHORT, USHORT, INT, UINT, LONG, ULONG, LLONG, ULLONG)
    for rank, signed in [(ctype.rank, ctype.signed)]
}


def canonical(ctype: CType) -> CType:
    """返回等价的预定义类型常量。"""
    return _CANONICAL[(ctype.rank, ctype.signed)]
