"""SQLite 持久化层。

条目字段以 JSON 整体存储，唯一键冲突判定在事务内基于全量快照完成，
保证切换判定与规则写入处于同一原子事务中。
"""
import json
import sqlite3
from typing import Dict, List, Optional, Tuple


class Store:
    """封装条目与规则的 SQLite 存取。所有方法均在单连接上执行。"""

    def __init__(self, db_path: str) -> None:
        self._conn = sqlite3.connect(db_path)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._init_schema()

    def _init_schema(self) -> None:
        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS entries (
                entry_id TEXT PRIMARY KEY,
                fields TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS rules (
                kind TEXT PRIMARY KEY,
                fields TEXT NOT NULL
            );
            """
        )
        self._conn.commit()

    def ensure_active_rule(self, fields: Tuple[str, ...]) -> None:
        """仅当不存在生效规则时写入初始规则。"""
        row = self._conn.execute(
            "SELECT fields FROM rules WHERE kind = 'active'"
        ).fetchone()
        if row is None:
            self._conn.execute(
                "INSERT INTO rules (kind, fields) VALUES ('active', ?)",
                (json.dumps(list(fields)),),
            )
            self._conn.commit()

    def get_active_rule(self) -> Tuple[str, ...]:
        row = self._conn.execute(
            "SELECT fields FROM rules WHERE kind = 'active'"
        ).fetchone()
        if row is None:
            raise RuntimeError("active rule missing")
        return tuple(json.loads(row[0]))

    def upsert_entry(self, entry_id: str, fields: Dict[str, str]) -> None:
        with self._conn:
            self._conn.execute(
                "INSERT INTO entries (entry_id, fields) VALUES (?, ?) "
                "ON CONFLICT(entry_id) DO UPDATE SET fields = excluded.fields",
                (entry_id, json.dumps(fields)),
            )

    def save_entry_atomic(
        self, entry_id: str, fields: Dict[str, str], rule: Tuple[str, ...]
    ) -> Optional[str]:
        """在单个事务内校验生效规则并写入；返回冲突条目 ID 或 None。"""
        cur = self._conn.cursor()
        cur.execute("BEGIN IMMEDIATE")
        try:
            new_key = tuple(fields[f] for f in rule)
            rows = cur.execute(
                "SELECT entry_id, fields FROM entries"
            ).fetchall()
            for other_id, payload in rows:
                if other_id == entry_id:
                    continue
                other = json.loads(payload)
                if tuple(other[f] for f in rule) == new_key:
                    cur.execute("ROLLBACK")
                    return other_id
            cur.execute(
                "INSERT INTO entries (entry_id, fields) VALUES (?, ?) "
                "ON CONFLICT(entry_id) DO UPDATE SET fields = excluded.fields",
                (entry_id, json.dumps(fields)),
            )
            cur.execute("COMMIT")
            return None
        except Exception:
            cur.execute("ROLLBACK")
            raise

    def delete_entry(self, entry_id: str) -> None:
        with self._conn:
            self._conn.execute(
                "DELETE FROM entries WHERE entry_id = ?", (entry_id,)
            )

    def get_entry(self, entry_id: str) -> Optional[Dict[str, str]]:
        row = self._conn.execute(
            "SELECT fields FROM entries WHERE entry_id = ?", (entry_id,)
        ).fetchone()
        return None if row is None else json.loads(row[0])

    def list_entries(self) -> List[Tuple[str, Dict[str, str]]]:
        rows = self._conn.execute(
            "SELECT entry_id, fields FROM entries ORDER BY entry_id"
        ).fetchall()
        return [(rid, json.loads(f)) for rid, f in rows]

    def atomic_switch(self, candidate_fields: Tuple[str, ...]) -> bool:
        """原子判定并切换：候选规则下无冲突则生效，返回是否成功。

        BEGIN IMMEDIATE 保证判定快照与规则写入之间无其他写事务插入，
        因此不会遗漏准备期间新增的冲突，也不会依据过时内容误判。
        """
        cur = self._conn.cursor()
        cur.execute("BEGIN IMMEDIATE")
        try:
            rows = cur.execute("SELECT fields FROM entries").fetchall()
            seen = set()
            for (payload,) in rows:
                fields = json.loads(payload)
                key = tuple(fields[f] for f in candidate_fields)
                if key in seen:
                    cur.execute("ROLLBACK")
                    return False
                seen.add(key)
            cur.execute(
                "INSERT INTO rules (kind, fields) VALUES ('active', ?) "
                "ON CONFLICT(kind) DO UPDATE SET fields = excluded.fields",
                (json.dumps(list(candidate_fields)),),
            )
            cur.execute("COMMIT")
            return True
        except Exception:
            cur.execute("ROLLBACK")
            raise

    def close(self) -> None:
        self._conn.close()
