"""基于 SQLite 的结构化内容唯一键管理库。"""

from __future__ import annotations

import json
import sqlite3
import threading
from dataclasses import dataclass

from .errors import ConflictError, NoCandidateRuleError, RuleError

Fields = dict[str, str]
Rule = tuple[str, ...]

_KEY_ACTIVE_RULE = "active_rule"
_KEY_CANDIDATE_RULE = "candidate_rule"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS entries (
    id     TEXT PRIMARY KEY,
    fields TEXT NOT NULL
);
"""


def _validate_rule(rule: Rule) -> Rule:
    rule = tuple(rule)
    if not rule:
        raise RuleError("unique key rule must select at least one field")
    if not all(isinstance(f, str) and f for f in rule):
        raise RuleError(f"rule fields must be non-empty strings: {rule!r}")
    if len(set(rule)) != len(rule):
        raise RuleError(f"rule contains duplicate fields: {rule!r}")
    return rule


def _key_of(fields: Fields, rule: Rule) -> tuple[str, ...]:
    """按规则逐项提取字段值组成唯一键；字段边界有意义（用元组而非拼接）。"""
    missing = [f for f in rule if f not in fields]
    if missing:
        raise RuleError(f"entry is missing rule fields: {missing!r}")
    return tuple(fields[f] for f in rule)


@dataclass(frozen=True)
class Entry:
    """一条内容条目：稳定 ID + 一组文本字段。"""

    id: str
    fields: Fields


class ContentStore:
    """管理单一内容类型的条目与唯一键规则。

    - 生效规则（active rule）：当前用于去重判定的字段组合。
    - 候选规则（candidate rule）：准备中的新规则，不影响保存判定。
    """

    def __init__(self, db_path: str, initial_rule: Rule) -> None:
        self._lock = threading.RLock()
        self._db = sqlite3.connect(db_path, check_same_thread=False)
        self._db.isolation_level = None  # 显式事务
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA busy_timeout=5000")
        self._db.execute("PRAGMA foreign_keys=ON")
        with self._lock:
            self._db.executescript(_SCHEMA)
            row = self._db.execute(
                "SELECT value FROM meta WHERE key = ?", (_KEY_ACTIVE_RULE,)
            ).fetchone()
            if row is None:
                self._set_meta(_KEY_ACTIVE_RULE, list(_validate_rule(initial_rule)))

    def close(self) -> None:
        with self._lock:
            self._db.close()

    def __enter__(self) -> "ContentStore":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # ---- 规则查询 ----

    def get_active_rule(self) -> Rule:
        with self._lock:
            return tuple(json.loads(self._get_meta(_KEY_ACTIVE_RULE)))

    def get_candidate_rule(self) -> Rule | None:
        with self._lock:
            raw = self._get_meta(_KEY_CANDIDATE_RULE)
            return None if raw is None else tuple(json.loads(raw))

    # ---- 条目读写 ----

    def save(self, entry_id: str, fields: Fields) -> None:
        """新增或完整替换同 ID 条目；与现存其他条目在生效规则下冲突则整体不生效。"""
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                rule = tuple(json.loads(self._get_meta(_KEY_ACTIVE_RULE)))
                new_key = _key_of(fields, rule)
                for other_id, other_fields in self._load_entries():
                    if other_id == entry_id:
                        continue
                    if _key_of(other_fields, rule) == new_key:
                        raise ConflictError(entry_id, other_id, rule)
                self._db.execute(
                    "INSERT INTO entries (id, fields) VALUES (?, ?) "
                    "ON CONFLICT(id) DO UPDATE SET fields = excluded.fields",
                    (entry_id, json.dumps(fields, ensure_ascii=False, sort_keys=True)),
                )
                self._db.execute("COMMIT")
            except BaseException:
                self._db.execute("ROLLBACK")
                raise

    def delete(self, entry_id: str) -> bool:
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                cur = self._db.execute("DELETE FROM entries WHERE id = ?", (entry_id,))
                self._db.execute("COMMIT")
                return cur.rowcount > 0
            except BaseException:
                self._db.execute("ROLLBACK")
                raise

    def get(self, entry_id: str) -> Entry | None:
        with self._lock:
            row = self._db.execute(
                "SELECT fields FROM entries WHERE id = ?", (entry_id,)
            ).fetchone()
            return None if row is None else Entry(entry_id, json.loads(row[0]))

    def list_entries(self) -> list[Entry]:
        with self._lock:
            return [Entry(i, f) for i, f in self._load_entries()]

    # ---- 规则切换 ----

    def prepare_switch(self, candidate: Rule) -> None:
        """登记候选规则；登记后旧规则继续生效。"""
        candidate = _validate_rule(candidate)
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                self._set_meta(_KEY_CANDIDATE_RULE, list(candidate))
                self._db.execute("COMMIT")
            except BaseException:
                self._db.execute("ROLLBACK")
                raise

    def cancel_switch(self) -> None:
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                self._db.execute(
                    "DELETE FROM meta WHERE key = ?", (_KEY_CANDIDATE_RULE,)
                )
                self._db.execute("COMMIT")
            except BaseException:
                self._db.execute("ROLLBACK")
                raise

    def apply_switch(self) -> bool:
        """原子判定：现存条目在候选规则下无冲突则整体生效，否则失败且旧规则不变。"""
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                raw = self._get_meta(_KEY_CANDIDATE_RULE)
                if raw is None:
                    raise NoCandidateRuleError("no candidate rule prepared")
                candidate = tuple(json.loads(raw))
                seen: dict[tuple[str, ...], str] = {}
                ok = True
                for entry_id, fields in self._load_entries():
                    key = _key_of(fields, candidate)
                    if key in seen:
                        ok = False
                        break
                    seen[key] = entry_id
                if ok:
                    self._set_meta(_KEY_ACTIVE_RULE, list(candidate))
                    self._db.execute(
                        "DELETE FROM meta WHERE key = ?", (_KEY_CANDIDATE_RULE,)
                    )
                self._db.execute("COMMIT")
                return ok
            except BaseException:
                self._db.execute("ROLLBACK")
                raise

    # ---- 内部 ----

    def _get_meta(self, key: str) -> str | None:
        row = self._db.execute(
            "SELECT value FROM meta WHERE key = ?", (key,)
        ).fetchone()
        return None if row is None else row[0]

    def _set_meta(self, key: str, value: object) -> None:
        self._db.execute(
            "INSERT INTO meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, json.dumps(value)),
        )

    def _load_entries(self) -> list[tuple[str, Fields]]:
        rows = self._db.execute("SELECT id, fields FROM entries ORDER BY id").fetchall()
        return [(row[0], json.loads(row[1])) for row in rows]
