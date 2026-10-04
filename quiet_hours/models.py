"""Data types for the quiet-hours notification scheduler."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, time
from enum import Enum

DEFAULT_TIMEZONE = "UTC"
DEFAULT_QUIET_START = time(21, 0)
DEFAULT_QUIET_END = time(7, 0)


@dataclass
class RecipientSettings:
    """Per-recipient delivery preferences."""

    timezone_name: str = DEFAULT_TIMEZONE
    quiet_start: time = DEFAULT_QUIET_START
    quiet_end: time = DEFAULT_QUIET_END


class NotificationStatus(Enum):
    PENDING = "pending"
    DELIVERED = "delivered"
    FAILED = "failed"


@dataclass
class Notification:
    notification_id: str
    recipient: str
    scheduled_at: datetime
    urgent: bool = False
    status: NotificationStatus = NotificationStatus.PENDING


@dataclass(frozen=True)
class DeliveryEvent:
    """Passed to the delivery callback; returns bool from the callback."""

    notification_id: str
    recipient: str
    attempt: int
    deliver_at: datetime
    urgent: bool


@dataclass(frozen=True)
class AttemptRecord:
    """One entry of the delivery trajectory."""

    notification_id: str
    recipient: str
    attempt: int
    lower_bound: datetime
    deliver_at: datetime
    succeeded: bool
