"""数据类型定义：通知、收件人设置、投递记录。"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, time


DEFAULT_QUIET_START = time(21, 0)
DEFAULT_QUIET_END = time(7, 0)
DEFAULT_TZ = "UTC"

RETRY_DELAYS_SECONDS = (30, 120, 600)
MAX_ATTEMPTS = 1 + len(RETRY_DELAYS_SECONDS)


@dataclass(frozen=True)
class QuietWindow:
    """每日静默窗口 [start, end)，允许跨午夜，start != end。"""
    start: time = DEFAULT_QUIET_START
    end: time = DEFAULT_QUIET_END

    def __post_init__(self) -> None:
        if self.start == self.end:
            raise ValueError("quiet window start and end must differ")


@dataclass
class RecipientSettings:
    tz_name: str = DEFAULT_TZ
    window: QuietWindow = field(default_factory=QuietWindow)


@dataclass(frozen=True)
class Delivery:
    """一次投递事件，回调收到的对象。"""
    notification_id: str
    recipient: str
    attempt: int  # 1..MAX_ATTEMPTS
    fire_utc: datetime


@dataclass(frozen=True)
class DeliveryRecord:
    """投递轨迹中的一条记录。"""
    notification_id: str
    attempt: int
    fire_utc: datetime
    succeeded: bool
