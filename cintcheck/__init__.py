"""C integer constant-expression compliance checker (C11, fixed platform)."""

from .api import CheckResult, check_expression
from .evaluator import Violation

__all__ = ["CheckResult", "Violation", "check_expression"]
