"""预检错误类型定义。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List


@dataclass
class PrecheckError:
    """单条预检错误。"""

    code: str
    message: str
    line: int = 0  # 1-based 文件行号，0 表示与具体行无关


@dataclass
class PrecheckResult:
    """预检结果：errors 为空即通过。"""

    errors: List[PrecheckError] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors

    def add(self, code: str, message: str, line: int = 0) -> None:
        self.errors.append(PrecheckError(code=code, message=message, line=line))
