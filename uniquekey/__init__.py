"""结构化内容唯一键管理库。"""
from .errors import ConflictError, RuleError, SwitchConflictError, UniqueKeyError
from .manager import UniqueKeyManager
from .models import Entry, UniqueKeyRule

__all__ = [
    "UniqueKeyManager",
    "Entry",
    "UniqueKeyRule",
    "UniqueKeyError",
    "ConflictError",
    "SwitchConflictError",
    "RuleError",
]
