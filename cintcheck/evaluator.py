"""Evaluator: computes value/type and detects integer-operation violations."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import List

from .ctypes import (
    INT,
    LONG,
    LONG_LONG,
    UNSIGNED_INT,
    UNSIGNED_LONG,
    UNSIGNED_LONG_LONG,
    CIntType,
    convert_value,
    integer_promote,
    type_from_name,
    usual_arithmetic_convert,
)
from .parser import Node


@dataclass(frozen=True)
class Value:
    """A typed integer value."""

    type: CIntType
    value: int  # always within the type's range


@dataclass(frozen=True)
class Violation:
    kind: str  # 'signed-overflow' | 'division-by-zero' | 'invalid-shift'
    detail: str


class _ViolationError(Exception):
    def __init__(self, violation: Violation):
        super().__init__(violation.detail)
        self.violation = violation


_LITERAL_RE = re.compile(r"(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)([uUlL]*)$")

_DEC_NO_SUFFIX = [INT, LONG, LONG_LONG]
_OCT_HEX_NO_SUFFIX = [INT, UNSIGNED_INT, LONG, UNSIGNED_LONG, LONG_LONG, UNSIGNED_LONG_LONG]
_U = [UNSIGNED_INT, UNSIGNED_LONG, UNSIGNED_LONG_LONG]
_L_DEC = [LONG, LONG_LONG]
_L_OCT_HEX = [LONG, UNSIGNED_LONG, LONG_LONG, UNSIGNED_LONG_LONG]
_LL_DEC = [LONG_LONG]
_LL_OCT_HEX = [LONG_LONG, UNSIGNED_LONG_LONG]
_UL = [UNSIGNED_LONG, UNSIGNED_LONG_LONG]
_ULL = [UNSIGNED_LONG_LONG]


def _literal_type(text: str) -> tuple[int, CIntType]:
    m = _LITERAL_RE.match(text)
    if not m:
        raise ValueError(f"invalid integer literal: {text!r}")
    digits, suffix = m.group(1), m.group(2).lower()
    if digits.lower().startswith("0x"):
        base = 16
    elif len(digits) > 1 and digits.startswith("0"):
        base = 8
    elif digits == "0":
        base = 8
    else:
        base = 10
    value = int(digits, base)
    has_u = "u" in suffix
    lcount = suffix.count("l")
    if not suffix:
        candidates = _DEC_NO_SUFFIX if base == 10 else _OCT_HEX_NO_SUFFIX
    elif has_u and lcount == 0:
        candidates = _U
    elif not has_u and lcount == 1:
        candidates = _L_DEC if base == 10 else _L_OCT_HEX
    elif not has_u and lcount == 2:
        candidates = _LL_DEC if base == 10 else _LL_OCT_HEX
    elif has_u and lcount == 1:
        candidates = _UL
    else:
        candidates = _ULL
    for t in candidates:
        if value <= t.max_value:
            return value, t
    raise ValueError(f"literal not representable: {text!r}")


def _common_type(a: CIntType, b: CIntType) -> CIntType:
    return usual_arithmetic_convert(integer_promote(a), integer_promote(b))


def _signed_result(value: int, t: CIntType, op: str) -> int:
    if not (t.min_value <= value <= t.max_value):
        raise _ViolationError(
            Violation(
                "signed-overflow",
                f"result of '{op}' ({value}) is out of range for {t.name}",
            )
        )
    return value


def _arith(op: str, a: Value, b: Value) -> Value:
    t = _common_type(a.type, b.type)
    x = convert_value(a.value, t)
    y = convert_value(b.value, t)
    if op == "+":
        raw = x + y
    elif op == "-":
        raw = x - y
    elif op == "*":
        raw = x * y
    elif op in ("/", "%"):
        if y == 0:
            raise _ViolationError(
                Violation("division-by-zero", f"{'division' if op == '/' else 'remainder'} by zero")
            )
        if t.signed and x == t.min_value and y == -1:
            raise _ViolationError(
                Violation(
                    "signed-overflow",
                    f"{t.name} minimum divided by -1 overflows",
                )
            )
        q = abs(x) // abs(y)
        if (x < 0) != (y < 0):
            q = -q
        raw = q if op == "/" else x - q * y
    elif op == "&":
        raw = x & y if t.signed else (x & y) & ((1 << t.bits) - 1)
    elif op == "^":
        raw = x ^ y if t.signed else (x ^ y) & ((1 << t.bits) - 1)
    elif op == "|":
        raw = x | y if t.signed else (x | y) & ((1 << t.bits) - 1)
    else:
        raise ValueError(f"unknown arithmetic operator {op!r}")
    if t.signed:
        return Value(t, _signed_result(raw, t, op))
    return Value(t, raw & ((1 << t.bits) - 1))


def _shift(op: str, a: Value, b: Value) -> Value:
    lt = integer_promote(a.type)
    rt = integer_promote(b.type)
    x = convert_value(a.value, lt)
    count = convert_value(b.value, rt)
    if count < 0 or count >= lt.bits:
        raise _ViolationError(
            Violation(
                "invalid-shift",
                f"shift count {count} is negative or >= width of {lt.name} ({lt.bits})",
            )
        )
    if op == "<<":
        if lt.signed:
            if x < 0:
                raise _ViolationError(
                    Violation("invalid-shift", "left shift of a negative signed value")
                )
            raw = x << count
            return Value(lt, _signed_result(raw, lt, op))
        return Value(lt, (x << count) & ((1 << lt.bits) - 1))
    # right shift: Python >> is arithmetic for negatives (sign-extending),
    # matching the platform convention; unsigned uses logical shift.
    return Value(lt, convert_value(x >> count, lt))


def _compare(op: str, a: Value, b: Value) -> Value:
    t = _common_type(a.type, b.type)
    x = convert_value(a.value, t)
    y = convert_value(b.value, t)
    result = {
        "<": x < y,
        ">": x > y,
        "<=": x <= y,
        ">=": x >= y,
        "==": x == y,
        "!=": x != y,
    }[op]
    return Value(INT, 1 if result else 0)


def _truthy(v: Value) -> bool:
    return v.value != 0


def _eval(node: Node) -> Value:
    kind = node.kind
    if kind == "num":
        value, t = _literal_type(node.text)
        return Value(t, value)
    if kind == "cast":
        target = type_from_name(node.ctype)
        operand = _eval(node.left)
        return Value(target, convert_value(operand.value, target))
    if kind == "unary":
        operand = _eval(node.left)
        t = integer_promote(operand.type)
        x = convert_value(operand.value, t)
        if node.op == "+":
            return Value(t, x)
        if node.op == "-":
            if t.signed:
                return Value(t, _signed_result(-x, t, "unary -"))
            return Value(t, (-x) & ((1 << t.bits) - 1))
        if node.op == "~":
            return Value(t, convert_value(~x, t))
        if node.op == "!":
            return Value(INT, 0 if x != 0 else 1)
        raise ValueError(f"unknown unary operator {node.op!r}")
    if kind == "binary":
        op = node.op
        if op == "&&":
            left = _eval(node.left)
            if not _truthy(left):
                return Value(INT, 0)
            return Value(INT, 1 if _truthy(_eval(node.right)) else 0)
        if op == "||":
            left = _eval(node.left)
            if _truthy(left):
                return Value(INT, 1)
            return Value(INT, 1 if _truthy(_eval(node.right)) else 0)
        left = _eval(node.left)
        right = _eval(node.right)
        if op in ("+", "-", "*", "/", "%", "&", "^", "|"):
            return _arith(op, left, right)
        if op in ("<<", ">>"):
            return _shift(op, left, right)
        if op in ("<", ">", "<=", ">=", "==", "!="):
            return _compare(op, left, right)
        raise ValueError(f"unknown binary operator {op!r}")
    if kind == "cond":
        cond = _eval(node.left)
        result_type = _common_type(_static_type(node.right), _static_type(node.third))
        selected = node.right if _truthy(cond) else node.third
        branch = _eval(selected)
        return Value(result_type, convert_value(branch.value, result_type))
    raise ValueError(f"unknown node kind {kind!r}")


def _static_type(node: Node) -> CIntType:
    """Type of an expression without evaluating it (no violations raised)."""
    kind = node.kind
    if kind == "num":
        return _literal_type(node.text)[1]
    if kind == "cast":
        return type_from_name(node.ctype)
    if kind == "unary":
        if node.op == "!":
            return INT
        return integer_promote(_static_type(node.left))
    if kind == "binary":
        op = node.op
        if op in ("&&", "||", "<", ">", "<=", ">=", "==", "!="):
            return INT
        if op in ("<<", ">>"):
            return integer_promote(_static_type(node.left))
        return _common_type(_static_type(node.left), _static_type(node.right))
    if kind == "cond":
        return _common_type(_static_type(node.right), _static_type(node.third))
    raise ValueError(f"unknown node kind {kind!r}")


def evaluate(node: Node) -> tuple[Value, List[Violation]]:
    try:
        return _eval(node), []
    except _ViolationError as exc:
        return None, [exc.violation]
