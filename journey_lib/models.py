"""数据类型定义。"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import List, Optional, Tuple


@dataclass(frozen=True)
class Event:
    """一条客户事件。

    event_id: 全局唯一整数 ID
    customer_id: 客户 ID
    occurred_at: 发生时间（naive datetime，按绝对时间比较）
    channel: 渠道名
    is_conversion: 是否转化事件
    """

    event_id: int
    customer_id: str
    occurred_at: datetime
    channel: str
    is_conversion: bool


@dataclass
class Journey:
    """一段旅程：按规则切分后属于同一客户的一段连续事件。"""

    customer_id: str
    events: List[Event] = field(default_factory=list)

    @property
    def ends_with_conversion(self) -> bool:
        return bool(self.events) and self.events[-1].is_conversion

    @property
    def path(self) -> Tuple[str, ...]:
        """转化路径：非转化事件的渠道序列，保留顺序与重复。"""
        return tuple(e.channel for e in self.events if not e.is_conversion)

    @property
    def qualifies_for_leaderboard(self) -> bool:
        """只有以转化结束且含非转化事件的旅程才贡献榜单。"""
        return self.ends_with_conversion and bool(self.path)
