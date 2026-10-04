"""C 整数常量表达式合规检查库。"""

from .api import CheckResult, check_expression
from .evaluator import Violation

__all__ = ["CheckResult", "Violation", "check_expression"]
