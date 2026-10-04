"""对上层 CMS 暴露的管理接口。"""
from typing import Dict, List, Tuple

from .errors import ConflictError, RuleError
from .models import Entry, UniqueKeyRule
from .store import Store


class UniqueKeyManager:
    """结构化内容唯一键管理器（单内容类型）。

    - 保存/删除即时生效，冲突校验只依据当前生效规则。
    - request_switch 原子判定：候选规则下现存条目无冲突才整体切换。
    """

    def __init__(self, db_path: str, initial_fields: Tuple[str, ...]) -> None:
        if not initial_fields:
            raise RuleError("initial unique key fields must not be empty")
        self._store = Store(db_path)
        self._store.ensure_active_rule(tuple(initial_fields))

    def save_entry(self, entry_id: str, fields: Dict[str, str]) -> None:
        """新增或完整替换同 ID 条目；与现存条目冲突时整次保存不生效。"""
        rule = self._store.get_active_rule()
        missing = [f for f in rule if f not in fields]
        if missing:
            raise RuleError(f"missing unique key fields: {missing}")
        conflict_id = self._store.save_entry_atomic(entry_id, fields, rule)
        if conflict_id is not None:
            raise ConflictError(
                f"entry {entry_id!r} conflicts with {conflict_id!r} "
                f"under active rule {rule}"
            )

    def delete_entry(self, entry_id: str) -> None:
        """删除条目；其唯一键值立即可被其他条目使用。"""
        self._store.delete_entry(entry_id)

    def request_switch(self, fields: Tuple[str, ...]) -> bool:
        """请求切换到候选规则。原子判定，成功返回 True，失败返回 False。"""
        if not fields:
            raise RuleError("candidate unique key fields must not be empty")
        return self._store.atomic_switch(tuple(fields))

    def current_rule(self) -> UniqueKeyRule:
        return UniqueKeyRule(fields=self._store.get_active_rule())

    def list_entries(self) -> List[Entry]:
        return [Entry(entry_id=rid, fields=f) for rid, f in self._store.list_entries()]

    def close(self) -> None:
        self._store.close()
