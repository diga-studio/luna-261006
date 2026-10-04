"""对外接口：供上层扫描器调用，输入与结果只保存在内存中。"""

from __future__ import annotations

from dataclasses import dataclass, field

from .ctypes import CType
from .evaluator import EvalContext, Violation, evaluate
from .parser import ParseError, parse


@dataclass(frozen=True)
class CheckResult:
    """一次常量表达式检查的结果。

    ok 为 True 时 value/ctype 有效；为 False 时 violations 非空，
    违规表达式不会以正常值形式返回（value/ctype 为 None）。
    """

    ok: bool
    value: int | None = None
    ctype: CType | None = None
    violations: tuple[Violation, ...] = field(default_factory=tuple)


def check_expression(text: str) -> CheckResult:
    """检查一段 C 整数常量表达式文本是否存在整数运算违规。

    输入保证语法正确；若仍遇到无法解析的文本，以 ParseError 形式抛出，
    由上层扫描器决定如何处理。
    """
    node = parse(text)
    ctx = EvalContext()
    result = evaluate(node, ctx)
    if ctx.violations:
        return CheckResult(ok=False, violations=tuple(ctx.violations))
    return CheckResult(ok=True, value=result.value, ctype=result.ctype)


__all__ = ["CheckResult", "Violation", "ParseError", "check_expression"]
