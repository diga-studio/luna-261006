"""对外 API：批量接收事件、查询事件所属旅程、查询前 50 转化路径。"""

from __future__ import annotations

from collections import Counter
from typing import List, Optional, Tuple

from .journeys import split_journeys
from .models import Event, Journey
from .store import EventStore

TOP_N = 50


class JourneyLibrary:
    def __init__(self, db_path: str) -> None:
        self._store = EventStore(db_path)

    def receive_batch(self, events: List[Event]) -> int:
        """批量接收事件，返回实际新增条数（重复 ID 忽略）。"""
        return self._store.insert_events(events)

    def journey_of_event(self, event_id: int) -> Optional[Journey]:
        """返回指定事件当前所属的旅程；事件不存在返回 None。"""
        customer_id = self._store.find_customer_of_event(event_id)
        if customer_id is None:
            return None
        events = self._store.events_for_customer(customer_id)
        for journey in split_journeys(events):
            if any(e.event_id == event_id for e in journey.events):
                return journey
        return None

    def top_paths(self, limit: int = TOP_N) -> List[Tuple[Tuple[str, ...], int]]:
        """全局转化路径榜单：[(路径, 次数), ...]，按规则排序取前 limit 条。"""
        counts: Counter = Counter()
        for customer_id in self._store.all_customer_ids():
            events = self._store.events_for_customer(customer_id)
            for journey in split_journeys(events):
                if journey.qualifies_for_leaderboard:
                    counts[journey.path] += 1
        ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
        return ranked[:limit]

    def close(self) -> None:
        self._store.close()
