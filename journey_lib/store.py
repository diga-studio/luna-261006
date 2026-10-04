"""SQLite 持久化：事件表与去重写入。"""

from __future__ import annotations

import sqlite3
from datetime import datetime
from typing import List, Optional

from .models import Event

_TS_FORMAT = "%Y-%m-%d %H:%M:%S.%f"


class EventStore:
    def __init__(self, db_path: str) -> None:
        self._conn = sqlite3.connect(db_path)
        self._create_schema()

    def _create_schema(self) -> None:
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS events (
                event_id INTEGER PRIMARY KEY,
                customer_id TEXT NOT NULL,
                occurred_at TEXT NOT NULL,
                channel TEXT NOT NULL,
                is_conversion INTEGER NOT NULL
            )
            """
        )
        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_events_customer "
            "ON events (customer_id, occurred_at, event_id)"
        )
        self._conn.commit()

    def insert_events(self, events: List[Event]) -> int:
        """批量写入事件，按 event_id 去重。返回实际新增条数。"""
        rows = [
            (
                e.event_id,
                e.customer_id,
                e.occurred_at.strftime(_TS_FORMAT),
                e.channel,
                1 if e.is_conversion else 0,
            )
            for e in events
        ]
        cursor = self._conn.executemany(
            "INSERT OR IGNORE INTO events "
            "(event_id, customer_id, occurred_at, channel, is_conversion) "
            "VALUES (?, ?, ?, ?, ?)",
            rows,
        )
        self._conn.commit()
        return cursor.rowcount

    def events_for_customer(self, customer_id: str) -> List[Event]:
        """按发生时间升序、同刻按 event_id 升序返回某客户全部事件。"""
        rows = self._conn.execute(
            "SELECT event_id, customer_id, occurred_at, channel, is_conversion "
            "FROM events WHERE customer_id = ? "
            "ORDER BY occurred_at, event_id",
            (customer_id,),
        ).fetchall()
        return [self._row_to_event(r) for r in rows]

    def all_customer_ids(self) -> List[str]:
        rows = self._conn.execute(
            "SELECT DISTINCT customer_id FROM events"
        ).fetchall()
        return [r[0] for r in rows]

    def find_customer_of_event(self, event_id: int) -> Optional[str]:
        row = self._conn.execute(
            "SELECT customer_id FROM events WHERE event_id = ?", (event_id,)
        ).fetchone()
        return row[0] if row else None

    @staticmethod
    def _row_to_event(row) -> Event:
        return Event(
            event_id=row[0],
            customer_id=row[1],
            occurred_at=datetime.strptime(row[2], _TS_FORMAT),
            channel=row[3],
            is_conversion=bool(row[4]),
        )

    def close(self) -> None:
        self._conn.close()
