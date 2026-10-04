"""旅程切分与榜单排序的纯函数逻辑。"""
from __future__ import annotations

from .models import Event

DAY_SECONDS = 24 * 3600
MAX_GAP_SECONDS = 90 * DAY_SECONDS


def split_journeys(events: list[Event]) -> list[list[Event]]:
    """按规则把一名客户的有序事件切成旅程。"""
    journeys: list[list[Event]] = []
    current: list[Event] = []
    for event in events:
        if current:
            gap = event.occurred_at - current[-1].occurred_at
            if gap > MAX_GAP_SECONDS or current[-1].is_conversion:
                journeys.append(current)
                current = []
        current.append(event)
    if current:
        journeys.append(current)
    return journeys


def journey_path(journey: list[Event]) -> tuple[str, ...] | None:
    """合格旅程返回非转化事件渠道序列，否则返回 None。"""
    if not journey or not journey[-1].is_conversion:
        return None
    path = tuple(e.channel for e in journey if not e.is_conversion)
    return path or None
