"""对外 API：批量接收事件、查询事件所属旅程、查询榜单。"""
from __future__ import annotations

from collections import Counter

from .core import journey_path, split_journeys
from .models import Event
from .store import EventStore


class JourneyLibrary:
    """客户旅程修订库。"""

    def __init__(self, db_path: str) -> None:
        self._store = EventStore(db_path)

    def close(self) -> None:
        self._store.close()

    def ingest_batch(self, events: list[Event]) -> None:
        """批量接收事件，完成后旅程与榜单同步更新。"""
        if not events:
            return
        affected = self._store.upsert_events(events)
        for customer_id in affected:
            ordered = self._store.events_of_customer(customer_id)
            journeys = split_journeys(ordered)
            self._store.replace_journeys(
                customer_id, [[e.event_id for e in j] for j in journeys]
            )
        self._refresh_leaderboard()

    def _refresh_leaderboard(self) -> None:
        """从当前全部旅程整体重建榜单，撤销旧贡献、计入新贡献。"""
        counts: Counter[tuple[str, ...]] = Counter()
        for journey in self._store.all_journeys():
            path = journey_path(journey)
            if path is not None:
                counts[path] += 1
        self._store.rebuild_leaderboard(list(counts.items()))

    def journey_of_event(self, event_id: int) -> list[Event] | None:
        """查看指定事件所属的旅程。"""
        return self._store.journey_of_event(event_id)

    def top_conversion_paths(self, limit: int = 50) -> list[tuple[list[str], int]]:
        """查询全局前 limit 条转化路径。"""
        return self._store.top_paths(limit)
