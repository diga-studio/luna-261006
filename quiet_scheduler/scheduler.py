"""调度器：登记通知、修改收件人设置、推进时钟、查看投递轨迹。

内部用最小堆保存计划中的投递事件，按 (触发时刻, 序号) 排序；
设置变更通过递增通知的 generation 使堆中旧条目惰性失效。
"""
from __future__ import annotations

import heapq
import itertools
from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone
from typing import Callable
from zoneinfo import ZoneInfo

from .models import (
    MAX_ATTEMPTS,
    RETRY_DELAYS_SECONDS,
    Delivery,
    DeliveryRecord,
    QuietWindow,
    RecipientSettings,
)
from .quiet import next_legal_utc

_PENDING = "pending"
_DELIVERED = "delivered"
_FAILED = "failed"


def _as_utc(value: datetime, name: str) -> datetime:
    if value.tzinfo is None:
        raise ValueError(f"{name} must be timezone-aware")
    return value.astimezone(timezone.utc).replace(microsecond=0)


@dataclass
class _Notification:
    notification_id: str
    recipient: str
    urgent: bool
    status: str = _PENDING
    attempts: int = 0
    lower_bound: datetime | None = None  # 当前尝试未经静默推迟的计划下限
    generation: int = 0


class Scheduler:
    def __init__(self, start: datetime, deliver: Callable[[Delivery], bool]) -> None:
        self._now = _as_utc(start, "start")
        self._deliver = deliver
        self._recipients: dict[str, RecipientSettings] = {}
        self._tz_cache: dict[str, ZoneInfo] = {}
        self._notifications: dict[str, _Notification] = {}
        self._pending_by_recipient: dict[str, set[str]] = {}
        self._heap: list[tuple[datetime, int, str, int]] = []
        self._seq = itertools.count()
        self._records: list[DeliveryRecord] = []

    # ---- 内部 helpers ----

    def _tz(self, tz_name: str) -> ZoneInfo:
        tz = self._tz_cache.get(tz_name)
        if tz is None:
            tz = ZoneInfo(tz_name)
            self._tz_cache[tz_name] = tz
        return tz

    def _settings(self, recipient: str) -> RecipientSettings:
        settings = self._recipients.get(recipient)
        if settings is None:
            settings = RecipientSettings()
            self._recipients[recipient] = settings
        return settings

    def _schedule(self, notif: _Notification) -> None:
        """按当前设置计算触发时刻并压入堆；旧堆条目因 generation 失效。"""
        settings = self._settings(notif.recipient)
        lower = notif.lower_bound
        if notif.urgent:
            fire = lower
        else:
            fire = next_legal_utc(lower, self._tz(settings.tz_name), settings.window)
        notif.generation += 1
        heapq.heappush(
            self._heap, (fire, next(self._seq), notif.notification_id, notif.generation)
        )

    # ---- 公开 API ----

    def register_notification(
        self,
        notification_id: str,
        recipient: str,
        scheduled_utc: datetime,
        urgent: bool = False,
    ) -> None:
        if notification_id in self._notifications:
            raise ValueError(f"duplicate notification id: {notification_id}")
        scheduled = _as_utc(scheduled_utc, "scheduled_utc")
        notif = _Notification(
            notification_id=notification_id,
            recipient=recipient,
            urgent=urgent,
            lower_bound=max(scheduled, self._now),
        )
        self._notifications[notification_id] = notif
        self._pending_by_recipient.setdefault(recipient, set()).add(notification_id)
        self._settings(recipient)  # 确保收件人设置存在（默认 UTC + 默认窗口）
        self._schedule(notif)

    def update_recipient(
        self,
        recipient: str,
        tz_name: str | None = None,
        quiet_start: time | None = None,
        quiet_end: time | None = None,
    ) -> None:
        settings = self._settings(recipient)
        if tz_name is not None:
            self._tz(tz_name)  # 校验时区名合法
            settings.tz_name = tz_name
        if quiet_start is not None or quiet_end is not None:
            settings.window = QuietWindow(
                start=quiet_start if quiet_start is not None else settings.window.start,
                end=quiet_end if quiet_end is not None else settings.window.end,
            )
        for nid in self._pending_by_recipient.get(recipient, ()):
            notif = self._notifications[nid]
            # 保留本次尝试未经静默推迟的下限，与当前时刻取较晚者重新择时
            notif.lower_bound = max(notif.lower_bound, self._now)
            self._schedule(notif)

    def advance(self, to: datetime) -> None:
        target = _as_utc(to, "to")
        if target < self._now:
            raise ValueError("scheduler clock only moves forward")
        self._now = target
        heap = self._heap
        while heap and heap[0][0] <= target:
            fire, _, nid, generation = heapq.heappop(heap)
            notif = self._notifications[nid]
            if notif.status != _PENDING or notif.generation != generation:
                continue  # 旧条目或已终结
            notif.attempts += 1
            ok = bool(
                self._deliver(
                    Delivery(
                        notification_id=nid,
                        recipient=notif.recipient,
                        attempt=notif.attempts,
                        fire_utc=fire,
                    )
                )
            )
            self._records.append(
                DeliveryRecord(
                    notification_id=nid,
                    attempt=notif.attempts,
                    fire_utc=fire,
                    succeeded=ok,
                )
            )
            if ok:
                notif.status = _DELIVERED
                self._pending_by_recipient[notif.recipient].discard(nid)
            elif notif.attempts >= MAX_ATTEMPTS:
                notif.status = _FAILED
                self._pending_by_recipient[notif.recipient].discard(nid)
            else:
                notif.lower_bound = fire + timedelta(
                    seconds=RETRY_DELAYS_SECONDS[notif.attempts - 1]
                )
                self._schedule(notif)

    def trajectory(self, notification_id: str | None = None) -> list[DeliveryRecord]:
        if notification_id is None:
            return list(self._records)
        return [r for r in self._records if r.notification_id == notification_id]
