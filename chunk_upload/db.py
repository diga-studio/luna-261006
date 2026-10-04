"""SQLite-backed session metadata.

A single table tracks every session. All mutations are committed
immediately so a process kill never loses a confirmed state change.
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path
from typing import List, Optional, Tuple

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    session_id      TEXT PRIMARY KEY,
    confirmed_bytes INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'completed')),
    object_digest   TEXT,
    created_at      REAL NOT NULL
);
"""

# session_id, confirmed_bytes, status, object_digest
Row = Tuple[str, int, str, Optional[str]]


class MetaDB:
    """Session metadata store backed by a single SQLite database."""

    def __init__(self, db_path: Path) -> None:
        self._conn = sqlite3.connect(str(db_path))
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=FULL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        with self._conn:
            self._conn.executescript(SCHEMA)

    def create_session(self, session_id: str) -> None:
        with self._conn:
            self._conn.execute(
                "INSERT INTO sessions (session_id, created_at) VALUES (?, ?)",
                (session_id, time.time()),
            )

    def get_session(self, session_id: str) -> Optional[Row]:
        cur = self._conn.execute(
            "SELECT session_id, confirmed_bytes, status, object_digest "
            "FROM sessions WHERE session_id = ?",
            (session_id,),
        )
        row = cur.fetchone()
        return (row[0], row[1], row[2], row[3]) if row else None

    def set_confirmed(self, session_id: str, confirmed: int) -> None:
        with self._conn:
            self._conn.execute(
                "UPDATE sessions SET confirmed_bytes = ? WHERE session_id = ?",
                (confirmed, session_id),
            )

    def mark_completed(self, session_id: str, digest: str) -> None:
        with self._conn:
            self._conn.execute(
                "UPDATE sessions SET status = 'completed', object_digest = ? "
                "WHERE session_id = ?",
                (digest, session_id),
            )

    def all_sessions(self) -> List[Row]:
        cur = self._conn.execute(
            "SELECT session_id, confirmed_bytes, status, object_digest "
            "FROM sessions"
        )
        return [(r[0], r[1], r[2], r[3]) for r in cur.fetchall()]

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None  # type: ignore[assignment]
