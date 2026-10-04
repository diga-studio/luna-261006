"""异常类型定义。"""

from __future__ import annotations


class UniqueKeyError(Exception):
    """本库所有异常的基类。"""


class ConflictError(UniqueKeyError):
    """保存的内容与现存条目在生效规则下冲突，整次保存不生效。"""

    def __init__(self, entry_id: str, conflicting_id: str, rule: tuple[str, ...]) -> None:
        self.entry_id = entry_id
        self.conflicting_id = conflicting_id
        self.rule = rule
        super().__init__(
            f"entry {entry_id!r} conflicts with {conflicting_id!r} "
            f"under active rule {list(rule)!r}"
        )


class RuleError(UniqueKeyError):
    """唯一键规则本身不合法（如为空或含重复字段）。"""


class NoCandidateRuleError(UniqueKeyError):
    """请求应用切换时不存在准备中的候选规则。"""
