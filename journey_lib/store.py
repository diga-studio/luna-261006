"""SQLite 持久化层。"""
from __future__ import annotations

import json
import sqlite3

from .models import Event


class EventStore:
    """事件与旅程结果的 SQLite 存储。"""

    def __init__(self, db_path: str) -> None:
        self._conn = sqlite3.connect(db_path)
        self._init_schema()

    def _init_schema(self) -> None:
        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS events (
                event_id INTEGER PRIMARY KEY,
                customer_id TEXT NOT NULL,
                occurred_at REAL NOT NULL,
                channel TEXT NOT NULL,
                is_conversion INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS journey_events (
                customer_id TEXT NOT NULL,
                journey_idx INTEGER NOT NULL,
                position INTEGER NOT NULL,
                event_id INTEGER NOT NULL,
                PRIMARY KEY (customer_id, journey_idx, position)
            );
            CREATE INDEX IF NOT EXISTS idx_journey_events_event
                ON journey_events (event_id);
            CREATE TABLE IF NOT EXISTS leaderboard (
                path TEXT PRIMARY KEY,
                count INTEGER NOT NULL
            );
            """
        )
        self._conn.commit()

    def close(self) -> None:
        self._conn.close()

    def upsert_events(self, events: list[Event]) -> set[str]:
        """写入事件（同 ID 重传只计一次），返回受影响的客户 ID 集合。"""
        with self._conn:
            self._conn.executemany(
                "INSERT OR IGNORE INTO events VALUES (?, ?, ?, ?, ?)",
                [
                    (e.event_id, e.customer_id, e.occurred_at, e.channel,
                     int(e.is_conversion))
                    for e in events
                ],
            )
        return {e.customer_id for e in events}

    def events_of_customer(self, customer_id: str) -> list[Event]:
        """按发生时间升序、同时刻按事件 ID 升序返回客户全部事件。"""
        rows = self._conn.execute(
            "SELECT event_id, customer_id, occurred_at, channel, is_conversion "
            "FROM events WHERE customer_id = ? ORDER BY occurred_at, event_id",
            (customer_id,),
        ).fetchall()
        return [self._to_event(r) for r in rows]

    def replace_journeys(self, customer_id: str, journeys: list[list[int]]) -> None:
        """用最新计算结果整体替换某客户的旅程（事件 ID 序列列表）。"""
        with self._conn:
            self._conn.execute(
                "DELETE FROM journey_events WHERE customer_id = ?", (customer_id,)
            )
            self._conn.executemany(
                "INSERT INTO journey_events VALUES (?, ?, ?, ?)",
                [
                    (customer_id, idx, pos, event_id)
                    for idx, journey in enumerate(journeys)
                    for pos, event_id in enumerate(journey)
                ],
            )

    def journey_of_event(self, event_id: int) -> list[Event] | None:
        """返回指定事件所属的旅程（事件序列），不存在返回 None。"""
        row = self._conn.execute(
            "SELECT customer_id, journey_idx FROM journey_events WHERE event_id = ?",
            (event_id,),
        ).fetchone()
        if row is None:
            return None
        rows = self._conn.execute(
            "SELECT e.event_id, e.customer_id, e.occurred_at, e.channel, "
            "e.is_conversion FROM journey_events j JOIN events e "
            "ON e.event_id = j.event_id "
            "WHERE j.customer_id = ? AND j.journey_idx = ? ORDER BY j.position",
            row,
        ).fetchall()
        return [self._to_event(r) for r in rows]

    def all_journeys(self) -> list[list[Event]]:
        """返回全部旅程（用于重建榜单）。"""
        rows = self._conn.execute(
            "SELECT j.customer_id, j.journey_idx, e.event_id, e.occurred_at, "
            "e.channel, e.is_conversion FROM journey_events j JOIN events e "
            "ON e.event_id = j.event_id "
            "ORDER BY j.customer_id, j.journey_idx, j.position"
        ).fetchall()
        journeys: list[list[Event]] = []
        last_key: tuple[str, int] | None = None
        for customer_id, journey_idx, event_id, occurred_at, channel, conv in rows:
            key = (customer_id, journey_idx)
            if key != last_key:
                journeys.append([])
                last_key = key
            journeys[-1].append(
                Event(event_id, customer_id, occurred_at, channel, bool(conv))
            )
        return journeys

    def rebuild_leaderboard(self, entries: list[tuple[tuple[str, ...], int]]) -> None:
        """整体重建榜单。"""
        with self._conn:
            self._conn.execute("DELETE FROM leaderboard")
            self._conn.executemany(
                "INSERT INTO leaderboard VALUES (?, ?)",
                [(json.dumps(list(path), ensure_ascii=False), count)
                 for path, count in entries],
            )

    def top_paths(self, limit: int = 50) -> list[tuple[list[str], int]]:
        """返回榜单前 limit 条：(路径渠道序列, 次数)。"""
        rows = self._conn.execute("SELECT path, count FROM leaderboard").fetchall()
        entries = [(tuple(json.loads(path)), count) for path, count in rows]
        entries.sort(key=lambda item: (-item[1], item[0]))
        return [(list(path), count) for path, count in entries[:limit]]

    @staticmethod
    def _to_event(row: tuple) -> Event:
        event_id, customer_id, occurred_at, channel, is_conversion = row
        return Event(event_id, customer_id, occurred_at, channel,
                     bool(is_conversion))
