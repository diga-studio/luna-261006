"""数据模型定义。"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Event:
    """客户旅程事件。

    event_id: 全局唯一整数 ID。
    customer_id: 客户 ID。
    occurred_at: 发生时间，Unix 秒。
    channel: 渠道名。
    is_conversion: 是否转化事件。
    """

    event_id: int
    customer_id: str
    occurred_at: float
    channel: str
    is_conversion: bool
