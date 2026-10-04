"""旅程切分逻辑（纯函数，无状态）。"""

from __future__ import annotations

from datetime import timedelta
from typing import List

from .models import Event, Journey

MAX_GAP = timedelta(days=90)


def split_journeys(events: List[Event]) -> List[Journey]:
    """把某客户已排序的事件切分为旅程。

    规则：
    - 相邻事件间隔严格大于 90 天（90*24h）时断开；恰好 90 天不断开。
    - 每个转化事件结束当前旅程，下一事件另起旅程。
    """
    journeys: List[Journey] = []
    current: List[Event] = []
    previous: Event | None = None

    for event in events:
        if current and (
            previous.is_conversion
            or event.occurred_at - previous.occurred_at > MAX_GAP
        ):
            journeys.append(Journey(customer_id=event.customer_id, events=current))
            current = []
        current.append(event)
        previous = event

    if current:
        journeys.append(Journey(customer_id=events[0].customer_id, events=current))
    return journeys
