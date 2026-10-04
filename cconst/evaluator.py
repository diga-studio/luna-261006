"""求值器：按 C11 整数语义求值并检测违规。

违规检测规则（按任务约定）：
- 有符号算术结果越界为违规；无符号运算按位宽取模，不算违规。
- 除数/取余除数为零、最小有符号数除以或取余 -1 为违规。
- 移位量为负或不小于提升后左操作数位宽为违规；有符号负数左移、
  有符号非负数左移后无法由结果类型表示，均为违规。
- 转换（含强制转换与条件运算结果转换）按位宽保留低位解释，不算违规。
- 短路逻辑与条件运算只求值实际选中的操作数。
"""

from __future__ import annotations

from dataclasses import dataclass, field

from . import ctypes
from .ctypes import CType
from .parser import Binary, Cast, Conditional, Literal, Node, Unary


@dataclass(frozen=True)
class Violation:
    """一次整数运算违规。"""

    kind: str       # 违规类别，如 'signed-overflow'、'division-by-zero'
    detail: str     # 人类可读描述


@dataclass
class EvalContext:
    """收集求值过程中实际发生的违规。"""

    violations: list[Violation] = field(default_factory=list)

    def report(self, kind: str, detail: str) -> None:
        self.violations.append(Violation(kind, detail))


@dataclass(frozen=True)
class Value:
    """带类型的求值结果，value 已按 ctype 表示范围规范化。"""

    ctype: CType
    value: int


def static_type(node: Node) -> CType:
    """不求值地推断表达式类型（用于条件运算未选中分支的结果类型判断）。"""
    if isinstance(node, Literal):
        return node.ctype
    if isinstance(node, Cast):
        return node.target
    if isinstance(node, Unary):
        if node.op == "!":
            return ctypes.INT
        return ctypes.integer_promote(static_type(node.operand))
    if isinstance(node, Binary):
        if node.op in ("<<", ">>"):
            return ctypes.integer_promote(static_type(node.left))
        if node.op in ("<", ">", "<=", ">=", "==", "!=", "&&", "||"):
            return ctypes.INT
        return ctypes.usual_arithmetic_conversion(
            ctypes.integer_promote(static_type(node.left)),
            ctypes.integer_promote(static_type(node.right)),
        )
    if isinstance(node, Conditional):
        return ctypes.usual_arithmetic_conversion(
            ctypes.integer_promote(static_type(node.then)),
            ctypes.integer_promote(static_type(node.otherwise)),
        )
    raise TypeError(f"unknown node: {node!r}")  # pragma: no cover


def _wrap(value: int, ctype: CType) -> int:
    """无符号取模/有符号保留低位解释（用于违规后继续传播的占位值）。"""
    return ctypes.convert_value(value, ctype)


def _check_signed_result(ctx: EvalContext, result: int, ctype: CType, what: str) -> int:
    """检查有符号结果是否越界；无符号直接取模。返回规范化后的值。"""
    if ctype.signed:
        if not (ctype.min_value <= result <= ctype.max_value):
            ctx.report(
                "signed-overflow",
                f"{what} result {result} out of range for {ctype}",
            )
            return _wrap(result, ctype)
        return result
    return result & ((1 << ctype.width) - 1)


def _eval_arithmetic(ctx: EvalContext, op: str, left: Value, right: Value) -> Value:
    common = ctypes.usual_arithmetic_conversion(
        ctypes.integer_promote(left.ctype), ctypes.integer_promote(right.ctype)
    )
    a = ctypes.convert_value(left.value, common)
    b = ctypes.convert_value(right.value, common)
    if op == "+":
        result = a + b
    elif op == "-":
        result = a - b
    elif op == "*":
        result = a * b
    elif op in ("/", "%"):
        if b == 0:
            ctx.report("division-by-zero", f"{op} with zero divisor")
            return Value(common, 0)
        if common.signed and a == common.min_value and b == -1:
            ctx.report(
                "signed-overflow",
                f"{common} minimum {a} {op} -1 overflows",
            )
            return Value(common, 0)
        quotient = (abs(a) // abs(b)) * (1 if (a < 0) == (b < 0) else -1)
        result = quotient if op == "/" else a - quotient * b
    elif op == "&":
        result = a & b
    elif op == "^":
        result = a ^ b
    elif op == "|":
        result = a | b
    else:  # pragma: no cover - parser 已限定运算符
        raise ValueError(f"unknown arithmetic op {op!r}")
    return Value(common, _check_signed_result(ctx, result, common, f"'{a} {op} {b}'"))


def _eval_shift(ctx: EvalContext, op: str, left: Value, right: Value) -> Value:
    result_type = ctypes.integer_promote(left.ctype)
    amount_type = ctypes.integer_promote(right.ctype)
    a = ctypes.convert_value(left.value, result_type)
    n = ctypes.convert_value(right.value, amount_type)
    if n < 0 or n >= result_type.width:
        ctx.report(
            "invalid-shift-amount",
            f"shift amount {n} not in [0, {result_type.width}) for {result_type}",
        )
        return Value(result_type, 0)
    if op == "<<":
        if result_type.signed:
            if a < 0:
                ctx.report(
                    "signed-overflow",
                    f"left shift of negative value {a} ({result_type})",
                )
                return Value(result_type, _wrap(a << n, result_type))
            result = a << n
            if result > result_type.max_value:
                ctx.report(
                    "signed-overflow",
                    f"left shift result {result} not representable in {result_type}",
                )
                return Value(result_type, _wrap(result, result_type))
            return Value(result_type, result)
        return Value(result_type, (a << n) & ((1 << result_type.width) - 1))
    # 右移：有符号负数补符号位（Python >> 即算术右移），结果总可表示。
    return Value(result_type, a >> n)


def _eval_comparison(op: str, left: Value, right: Value) -> Value:
    common = ctypes.usual_arithmetic_conversion(
        ctypes.integer_promote(left.ctype), ctypes.integer_promote(right.ctype)
    )
    a = ctypes.convert_value(left.value, common)
    b = ctypes.convert_value(right.value, common)
    outcome = {
        "<": a < b,
        ">": a > b,
        "<=": a <= b,
        ">=": a >= b,
        "==": a == b,
        "!=": a != b,
    }[op]
    return Value(ctypes.INT, 1 if outcome else 0)


def evaluate(node: Node, ctx: EvalContext) -> Value:
    if isinstance(node, Literal):
        return Value(node.ctype, node.value)
    if isinstance(node, Cast):
        operand = evaluate(node.operand, ctx)
        return Value(node.target, ctypes.convert_value(operand.value, node.target))
    if isinstance(node, Unary):
        operand = evaluate(node.operand, ctx)
        if node.op == "!":
            return Value(ctypes.INT, 0 if operand.value else 1)
        promoted = ctypes.integer_promote(operand.ctype)
        v = ctypes.convert_value(operand.value, promoted)
        if node.op == "+":
            return Value(promoted, v)
        if node.op == "-":
            return Value(promoted, _check_signed_result(ctx, -v, promoted, f"unary minus of {v}"))
        if node.op == "~":
            return Value(promoted, _wrap(~v, promoted))
        raise ValueError(f"unknown unary op {node.op!r}")  # pragma: no cover
    if isinstance(node, Binary):
        if node.op == "&&":
            left = evaluate(node.left, ctx)
            if not left.value:
                return Value(ctypes.INT, 0)
            right = evaluate(node.right, ctx)
            return Value(ctypes.INT, 1 if right.value else 0)
        if node.op == "||":
            left = evaluate(node.left, ctx)
            if left.value:
                return Value(ctypes.INT, 1)
            right = evaluate(node.right, ctx)
            return Value(ctypes.INT, 1 if right.value else 0)
        left = evaluate(node.left, ctx)
        right = evaluate(node.right, ctx)
        if node.op in ("<<", ">>"):
            return _eval_shift(ctx, node.op, left, right)
        if node.op in ("<", ">", "<=", ">=", "==", "!="):
            return _eval_comparison(node.op, left, right)
        return _eval_arithmetic(ctx, node.op, left, right)
    if isinstance(node, Conditional):
        cond = evaluate(node.cond, ctx)
        result_type = ctypes.usual_arithmetic_conversion(
            ctypes.integer_promote(static_type(node.then)),
            ctypes.integer_promote(static_type(node.otherwise)),
        )
        selected = node.then if cond.value else node.otherwise
        branch = evaluate(selected, ctx)
        return Value(result_type, ctypes.convert_value(branch.value, result_type))
    raise TypeError(f"unknown node: {node!r}")  # pragma: no cover
