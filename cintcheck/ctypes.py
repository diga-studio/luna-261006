"""C11 integer type model for the fixed target platform.

Platform: char 8-bit (signed by default), short 16-bit, int/long 32-bit,
long long 64-bit; two's complement.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class CIntType:
    """A C integer type: rank-ordered, signed or unsigned."""

    name: str
    bits: int
    signed: bool
    rank: int  # C11 6.3.1.1 conversion rank

    @property
    def min_value(self) -> int:
        if self.signed:
            return -(1 << (self.bits - 1))
        return 0

    @property
    def max_value(self) -> int:
        if self.signed:
            return (1 << (self.bits - 1)) - 1
        return (1 << self.bits) - 1


CHAR = CIntType("char", 8, True, 1)
SIGNED_CHAR = CIntType("signed char", 8, True, 1)
UNSIGNED_CHAR = CIntType("unsigned char", 8, False, 1)
SHORT = CIntType("short", 16, True, 2)
UNSIGNED_SHORT = CIntType("unsigned short", 16, False, 2)
INT = CIntType("int", 32, True, 3)
UNSIGNED_INT = CIntType("unsigned int", 32, False, 3)
LONG = CIntType("long", 32, True, 4)
UNSIGNED_LONG = CIntType("unsigned long", 32, False, 4)
LONG_LONG = CIntType("long long", 64, True, 5)
UNSIGNED_LONG_LONG = CIntType("unsigned long long", 64, False, 5)

ALL_TYPES = (
    CHAR,
    SIGNED_CHAR,
    UNSIGNED_CHAR,
    SHORT,
    UNSIGNED_SHORT,
    INT,
    UNSIGNED_INT,
    LONG,
    UNSIGNED_LONG,
    LONG_LONG,
    UNSIGNED_LONG_LONG,
)

_TYPES_BY_NAME = {t.name: t for t in ALL_TYPES}
# Aliases accepted in cast syntax.
_TYPES_BY_NAME.update(
    {
        "signed": INT,
        "unsigned": UNSIGNED_INT,
        "signed int": INT,
        "signed short": SHORT,
        "signed short int": SHORT,
        "short int": SHORT,
        "unsigned short int": UNSIGNED_SHORT,
        "signed long": LONG,
        "signed long int": LONG,
        "long int": LONG,
        "unsigned long int": UNSIGNED_LONG,
        "signed long long": LONG_LONG,
        "signed long long int": LONG_LONG,
        "long long int": LONG_LONG,
        "unsigned long long int": UNSIGNED_LONG_LONG,
    }
)

_UNSIGNED_COUNTERPART = {
    CHAR: UNSIGNED_CHAR,
    SIGNED_CHAR: UNSIGNED_CHAR,
    SHORT: UNSIGNED_SHORT,
    INT: UNSIGNED_INT,
    LONG: UNSIGNED_LONG,
    LONG_LONG: UNSIGNED_LONG_LONG,
}


def type_from_name(name: str) -> CIntType:
    """Resolve a cast type name (normalized whitespace) to a CIntType."""
    key = " ".join(name.split())
    try:
        return _TYPES_BY_NAME[key]
    except KeyError:
        raise ValueError(f"unsupported type in cast: {name!r}") from None


def integer_promote(t: CIntType) -> CIntType:
    """C11 6.3.1.1 integer promotions: everything below int promotes to int."""
    if t.rank < INT.rank:
        return INT
    return t


def usual_arithmetic_convert(a: CIntType, b: CIntType) -> CIntType:
    """C11 6.3.1.8 usual arithmetic conversions (operands already promoted)."""
    if a is b or a.name == b.name:
        return a
    if a.signed == b.signed:
        return a if a.rank >= b.rank else b
    unsigned_t, signed_t = (a, b) if not a.signed else (b, a)
    if unsigned_t.rank >= signed_t.rank:
        return unsigned_t
    if signed_t.max_value >= unsigned_t.max_value:
        return signed_t
    return _UNSIGNED_COUNTERPART[signed_t]


def convert_value(value: int, t: CIntType) -> int:
    """Convert to type t: keep low bits, interpret as two's complement."""
    mask = (1 << t.bits) - 1
    value &= mask
    if t.signed and value >= (1 << (t.bits - 1)):
        value -= 1 << t.bits
    return value
