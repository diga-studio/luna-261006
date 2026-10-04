"""In-memory quiet-hours notification scheduler."""

from __future__ import annotations

import heapq
from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone
from typing import Callable, Optional
from zoneinfo import ZoneInfo

from .models import (
    AttemptRecord,
    DeliveryEvent,
    Notification,
    NotificationStatus,
    RecipientSettings,
)
from .quiet import next_legal_instant

RETRY_BACKOFFS_SECONDS = (30, 120, 600)
MAX_ATTEMPTS = 1 + len(RETRY_BACKOFFS_SECONDS)


def _norm(moment: datetime) -> datetime:
    if moment.tzinfo is None:
        raise ValueError("datetime must be timezone-aware")
    return moment.astimezone(timezone.utc).replace(microsecond=0)


@dataclass
class _AttemptState:
    notification: Notification
    attempt: int
    lower_bound: datetime
    deliver_at: datetime
    version: int


class Scheduler:
    def __init__(self, start: datetime, on_delivery: Callable[[DeliveryEvent], bool]) -> None:
        self._now = _norm(start)
        self._on_delivery = on_delivery
        self._settings: dict[str, RecipientSettings] = {}
        self._notifications: dict[str, Notification] = {}
        self._pending: dict[str, _AttemptState] = {}
        self._heap: list[tuple[datetime, int, str, int]] = []
        self._seq = 0
        self._log: list[AttemptRecord] = []

    @property
    def now(self) -> datetime:
        return self._now

    def _recipient_settings(self, recipient: str) -> RecipientSettings:
        return self._settings.setdefault(recipient, RecipientSettings())

    def _schedule(self, state: _AttemptState) -> None:
        settings = self._recipient_settings(state.notification.recipient)
        lower = max(state.lower_bound, self._now)
        state.deliver_at = next_legal_instant(lower, settings, state.notification.urgent)
        state.version += 1
        self._seq += 1
        heapq.heappush(
            self._heap, (state.deliver_at, self._seq, state.notification.notification_id, state.version)
        )

    def register_notification(
        self,
        notification_id: str,
        recipient: str,
        scheduled_at: datetime,
        urgent: bool = False,
    ) -> None:
        if notification_id in self._notifications:
            raise ValueError(f"duplicate notification id: {notification_id}")
        notification = Notification(
            notification_id=notification_id,
            recipient=recipient,
            scheduled_at=_norm(scheduled_at),
            urgent=urgent,
        )
        self._notifications[notification_id] = notification
        lower = max(notification.scheduled_at, self._now)
        state = _AttemptState(notification, 1, lower, lower, 0)
        self._pending[notification_id] = state
        self._schedule(state)

    def set_recipient_settings(
        self,
        recipient: str,
        timezone_name: Optional[str] = None,
        quiet_start: Optional[time] = None,
        quiet_end: Optional[time] = None,
    ) -> None:
        settings = self._recipient_settings(recipient)
        new_tz = timezone_name if timezone_name is not None else settings.timezone_name
        new_start = quiet_start if quiet_start is not None else settings.quiet_start
        new_end = quiet_end if quiet_end is not None else settings.quiet_end
        if new_start == new_end:
            raise ValueError("quiet_start and quiet_end must differ")
        ZoneInfo(new_tz)  # validate timezone name
        self._settings[recipient] = RecipientSettings(new_tz, new_start, new_end)
        for state in self._pending.values():
            if state.notification.recipient != recipient:
                continue
            self._schedule(state)

    def advance(self, to: datetime) -> None:
        target = _norm(to)
        if target < self._now:
            raise ValueError("scheduler clock only moves forward")
        while self._heap and self._heap[0][0] <= target:
            deliver_at, _, nid, version = heapq.heappop(self._heap)
            state = self._pending.get(nid)
            if state is None or state.version != version:
                continue
            notification = state.notification
            event = DeliveryEvent(
                notification_id=nid,
                recipient=notification.recipient,
                attempt=state.attempt,
                deliver_at=deliver_at,
                urgent=notification.urgent,
            )
            succeeded = bool(self._on_delivery(event))
            self._log.append(
                AttemptRecord(
                    notification_id=nid,
                    recipient=notification.recipient,
                    attempt=state.attempt,
                    lower_bound=state.lower_bound,
                    deliver_at=deliver_at,
                    succeeded=succeeded,
                )
            )
            if succeeded:
                notification.status = NotificationStatus.DELIVERED
                del self._pending[nid]
            elif state.attempt >= MAX_ATTEMPTS:
                notification.status = NotificationStatus.FAILED
                del self._pending[nid]
            else:
                backoff = RETRY_BACKOFFS_SECONDS[state.attempt - 1]
                state.lower_bound = deliver_at + timedelta(seconds=backoff)
                state.attempt += 1
                self._schedule(state)
        self._now = target

    def delivery_log(self) -> list[AttemptRecord]:
        return list(self._log)

    def notification_status(self, notification_id: str) -> NotificationStatus:
        return self._notifications[notification_id].status
