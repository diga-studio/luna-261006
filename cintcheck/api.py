"""Public API for the constant-expression compliance checker."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional

from .ctypes import CIntType
from .evaluator import Violation, evaluate
from .lexer import tokenize
from .parser import parse


@dataclass(frozen=True)
class CheckResult:
    """Result of checking one constant expression."""

    ok: bool  # True when no violation occurred
    value: Optional[int]  # value in the result type, None if a violation occurred
    type: Optional[CIntType]  # result type, None if a violation occurred
    violations: List[Violation] = field(default_factory=list)


def check_expression(text: str) -> CheckResult:
    """Check a C integer constant expression for integer-operation violations.

    Returns a CheckResult with the typed value when the expression evaluates
    cleanly, or with the detected violations otherwise.
    """
    node = parse(tokenize(text))
    value, violations = evaluate(node)
    if violations:
        return CheckResult(ok=False, value=None, type=None, violations=violations)
    return CheckResult(ok=True, value=value.value, type=value.type, violations=[])
