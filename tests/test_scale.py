"""Scale test: 20k notifications across 100 timezones, ~80k deliveries in <10s."""

import time as time_mod
from datetime import datetime, timedelta, timezone
from zoneinfo import available_timezones

from quiet_hours import NotificationStatus, Scheduler

UTC = timezone.utc


def _timezones(count=100):
    names = sorted(available_timezones())
    step = max(1, len(names) // count)
    return [names[i] for i in range(0, len(names), step)][:count]


def test_scale_20k_notifications_30_day_advance():
    start = datetime(2025, 6, 1, 0, 0, tzinfo=UTC)
    tzs = _timezones(100)
    total = 20_000

    scheduler = Scheduler(start, lambda event: False)  # everything fails 4 times
    for i in range(total):
        scheduler.set_recipient_settings(f"user-{i}", timezone_name=tzs[i % len(tzs)])
        plan = start + timedelta(seconds=(i * 86_400 * 28) // total + (i % 97))
        scheduler.register_notification(f"n{i}", f"user-{i}", plan, urgent=(i % 11 == 0))

    t0 = time_mod.perf_counter()
    scheduler.advance(start + timedelta(days=30))
    elapsed = time_mod.perf_counter() - t0

    log = scheduler.delivery_log()
    assert 75_000 <= len(log) <= 80_000
    assert elapsed < 10.0, f"advance took {elapsed:.2f}s"
    assert all(log[i].deliver_at <= log[i + 1].deliver_at for i in range(len(log) - 1))
    assert all(
        scheduler.notification_status(f"n{i}") is NotificationStatus.FAILED
        for i in range(total)
    )


def test_scale_big_jump_equals_small_steps():
    start = datetime(2025, 6, 1, 0, 0, tzinfo=UTC)
    tzs = _timezones(100)

    def callback(event):
        return (hash((event.notification_id, event.attempt)) % 4) != 0

    def build():
        s = Scheduler(start, callback)
        for i in range(2_000):
            s.set_recipient_settings(f"user-{i}", timezone_name=tzs[i % len(tzs)])
            plan = start + timedelta(seconds=(i * 86_400 * 29) // 2_000 + (i % 31))
            s.register_notification(f"n{i}", f"user-{i}", plan, urgent=(i % 9 == 0))
        return s

    end = start + timedelta(days=30)
    big = build()
    big.advance(end)

    small = build()
    moment = start
    while moment < end:
        moment = min(moment + timedelta(hours=7, seconds=43), end)
        small.advance(moment)

    assert big.delivery_log() == small.delivery_log()
