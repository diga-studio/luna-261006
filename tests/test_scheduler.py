"""Scheduler behaviour: retries, settings changes, clock semantics, equivalence."""

from datetime import datetime, time, timedelta, timezone

import pytest

from quiet_hours import NotificationStatus, Scheduler

UTC = timezone.utc


def dt(y, mo, d, h, mi, s=0):
    return datetime(y, mo, d, h, mi, s, tzinfo=UTC)


def make_scheduler(start, results=()):
    """results: iterable of booleans consumed per delivery; default success."""
    remaining = list(results)

    def callback(event):
        return remaining.pop(0) if remaining else True

    return Scheduler(start, callback)


def test_register_defers_into_future_and_delivers_on_advance():
    s = make_scheduler(dt(2025, 6, 1, 0, 0))
    s.register_notification("n1", "alice", dt(2025, 6, 1, 12, 0))
    s.advance(dt(2025, 6, 1, 11, 59, 59))
    assert s.delivery_log() == []
    s.advance(dt(2025, 6, 1, 12, 0))
    log = s.delivery_log()
    assert [(r.notification_id, r.attempt, r.deliver_at) for r in log] == [
        ("n1", 1, dt(2025, 6, 1, 12, 0))
    ]
    assert s.notification_status("n1") is NotificationStatus.DELIVERED


def test_past_scheduled_time_uses_registration_moment_as_lower_bound():
    s = make_scheduler(dt(2025, 6, 1, 10, 0))
    s.register_notification("n1", "alice", dt(2025, 5, 31, 8, 0))
    s.advance(dt(2025, 6, 1, 10, 0))
    log = s.delivery_log()
    assert log[0].lower_bound == dt(2025, 6, 1, 10, 0)
    assert log[0].deliver_at == dt(2025, 6, 1, 10, 0)


def test_registration_does_not_deliver_immediately():
    s = make_scheduler(dt(2025, 6, 1, 10, 0))
    s.register_notification("n1", "alice", dt(2025, 6, 1, 9, 0))
    assert s.delivery_log() == []


def test_duplicate_id_rejected():
    s = make_scheduler(dt(2025, 6, 1, 0, 0))
    s.register_notification("n1", "alice", dt(2025, 6, 1, 1, 0))
    with pytest.raises(ValueError):
        s.register_notification("n1", "bob", dt(2025, 6, 1, 1, 0))


def test_retry_backoffs_and_permanent_failure():
    s = make_scheduler(dt(2025, 6, 1, 12, 0), results=[False, False, False, False])
    s.register_notification("n1", "alice", dt(2025, 6, 1, 12, 0))
    s.advance(dt(2025, 6, 1, 13, 0))
    log = s.delivery_log()
    assert [(r.attempt, r.deliver_at) for r in log] == [
        (1, dt(2025, 6, 1, 12, 0)),
        (2, dt(2025, 6, 1, 12, 0, 30)),
        (3, dt(2025, 6, 1, 12, 2, 30)),
        (4, dt(2025, 6, 1, 12, 12, 30)),
    ]
    assert all(not r.succeeded for r in log)
    assert s.notification_status("n1") is NotificationStatus.FAILED
    s.advance(dt(2025, 6, 2, 0, 0))
    assert len(s.delivery_log()) == 4  # no fifth attempt


def test_success_stops_retries():
    s = make_scheduler(dt(2025, 6, 1, 12, 0), results=[False, True])
    s.register_notification("n1", "alice", dt(2025, 6, 1, 12, 0))
    s.advance(dt(2025, 6, 2, 0, 0))
    assert len(s.delivery_log()) == 2
    assert s.notification_status("n1") is NotificationStatus.DELIVERED


def test_retry_deferred_by_quiet_window():
    s = make_scheduler(dt(2025, 6, 1, 0, 0), results=[False, True])
    s.register_notification("n1", "alice", dt(2025, 6, 1, 20, 59, 50))
    s.advance(dt(2025, 6, 3, 0, 0))
    log = s.delivery_log()
    # First attempt 20:59:50 UTC; retry lower 21:00:20 is quiet (UTC 21:00-07:00)
    # so the retry happens at 07:00 next day, not 21:00:20.
    assert [(r.attempt, r.deliver_at) for r in log] == [
        (1, dt(2025, 6, 1, 20, 59, 50)),
        (2, dt(2025, 6, 2, 7, 0)),
    ]


def test_urgent_ignores_quiet_window_but_keeps_retry_rules():
    s = make_scheduler(dt(2025, 6, 1, 0, 0), results=[False, True])
    s.register_notification("n1", "alice", dt(2025, 6, 1, 23, 0), urgent=True)
    s.advance(dt(2025, 6, 2, 0, 0))
    log = s.delivery_log()
    assert [(r.attempt, r.deliver_at) for r in log] == [
        (1, dt(2025, 6, 1, 23, 0)),
        (2, dt(2025, 6, 1, 23, 0, 30)),
    ]


def test_settings_change_pulls_deferred_retry_earlier():
    s = make_scheduler(dt(2025, 6, 1, 0, 0), results=[False, True])
    s.register_notification("n1", "alice", dt(2025, 6, 1, 20, 59, 50))
    s.advance(dt(2025, 6, 1, 21, 0))  # attempt 1 fails; retry deferred to 07:00 next day
    assert len(s.delivery_log()) == 1
    # At 22:00 the recipient narrows the window so the retry is no longer quiet.
    s.advance(dt(2025, 6, 1, 22, 0))
    s.set_recipient_settings("alice", quiet_start=time(22, 30), quiet_end=time(6, 0))
    s.advance(dt(2025, 6, 1, 22, 0))
    log = s.delivery_log()
    assert [(r.attempt, r.deliver_at) for r in log] == [
        (1, dt(2025, 6, 1, 20, 59, 50)),
        (2, dt(2025, 6, 1, 22, 0)),  # max(preserved lower 21:00:20, now 22:00)
    ]
    assert log[1].lower_bound == dt(2025, 6, 1, 21, 0, 20)


def test_settings_change_does_not_reset_retry_count():
    s = make_scheduler(dt(2025, 6, 1, 0, 0), results=[False, False, True])
    s.register_notification("n1", "alice", dt(2025, 6, 1, 20, 59, 50))
    s.advance(dt(2025, 6, 1, 21, 0))
    s.advance(dt(2025, 6, 1, 22, 0))
    s.set_recipient_settings("alice", quiet_start=time(22, 30), quiet_end=time(6, 0))
    s.advance(dt(2025, 6, 2, 0, 0))
    log = s.delivery_log()
    # Attempt 2 at 22:00 fails; attempt 3 uses the 120s backoff (not reset to 30s).
    assert [(r.attempt, r.deliver_at) for r in log] == [
        (1, dt(2025, 6, 1, 20, 59, 50)),
        (2, dt(2025, 6, 1, 22, 0)),
        (3, dt(2025, 6, 1, 22, 2)),
    ]


def test_settings_change_never_backfills_the_past():
    s = make_scheduler(dt(2025, 6, 1, 0, 0))
    s.register_notification("n1", "alice", dt(2025, 6, 1, 21, 30))
    s.advance(dt(2025, 6, 1, 22, 0))
    assert s.delivery_log() == []  # deferred by default 21:00-07:00 window
    # New window ends 21:30, already in the past: delivery must happen at >= now.
    s.set_recipient_settings("alice", quiet_start=time(12, 0), quiet_end=time(21, 30))
    s.advance(dt(2025, 6, 1, 22, 0))
    log = s.delivery_log()
    assert log[0].deliver_at == dt(2025, 6, 1, 22, 0)


def test_timezone_change_reschedules_pending():
    s = make_scheduler(dt(2025, 6, 1, 0, 0))
    s.register_notification("n1", "alice", dt(2025, 6, 1, 12, 0))
    # Tokyo: 12:00 UTC = 21:00 JST -> quiet under default window, moves to 07:00 JST.
    s.set_recipient_settings("alice", timezone_name="Asia/Tokyo")
    s.advance(dt(2025, 6, 2, 0, 0))
    log = s.delivery_log()
    assert log[0].deliver_at == dt(2025, 6, 1, 22, 0)  # 07:00 JST


def test_clock_cannot_move_backwards():
    s = make_scheduler(dt(2025, 6, 1, 12, 0))
    with pytest.raises(ValueError):
        s.advance(dt(2025, 6, 1, 11, 59, 59))


def test_repeated_advance_to_same_time_does_not_redeliver():
    s = make_scheduler(dt(2025, 6, 1, 0, 0))
    s.register_notification("n1", "alice", dt(2025, 6, 1, 12, 0))
    s.advance(dt(2025, 6, 1, 13, 0))
    s.advance(dt(2025, 6, 1, 13, 0))
    s.advance(dt(2025, 6, 1, 13, 0))
    assert len(s.delivery_log()) == 1


def test_delivery_event_carries_event_time_not_advance_target():
    seen = []
    s = Scheduler(dt(2025, 6, 1, 0, 0), lambda e: seen.append(e) or True)
    s.register_notification("n1", "alice", dt(2025, 6, 1, 12, 0))
    s.advance(dt(2025, 6, 5, 0, 0))
    assert seen[0].deliver_at == dt(2025, 6, 1, 12, 0)


def test_delivery_order_is_chronological_across_notifications():
    s = make_scheduler(dt(2025, 6, 1, 0, 0))
    s.register_notification("late", "alice", dt(2025, 6, 1, 12, 0))
    s.register_notification("early", "bob", dt(2025, 6, 1, 6, 0))
    s.advance(dt(2025, 6, 2, 0, 0))
    assert [r.notification_id for r in s.delivery_log()] == ["early", "late"]


def test_invalid_quiet_window_rejected():
    s = make_scheduler(dt(2025, 6, 1, 0, 0))
    with pytest.raises(ValueError):
        s.set_recipient_settings("alice", quiet_start=time(7, 0), quiet_end=time(7, 0))
    with pytest.raises(Exception):
        s.set_recipient_settings("alice", timezone_name="Not/AZone")


def _scenario(seed_offset=0):
    """Deterministic mix of notifications, failures and settings changes."""
    start = dt(2025, 3, 8, 0, 0)
    results = {}

    def callback(event):
        # Deterministic per (id, attempt): fail roughly every third attempt.
        return (hash((event.notification_id, event.attempt)) % 3) != 0

    def build():
        s = Scheduler(start, callback)
        tzs = ["UTC", "America/New_York", "Asia/Tokyo", "Australia/Sydney"]
        for i in range(60):
            recipient = f"r{i % 12}"
            plan = start + timedelta(seconds=3600 * i + 7 * i * i)
            s.register_notification(f"n{i}", recipient, plan, urgent=(i % 7 == 0))
        return s

    return start, build


def test_big_jump_equals_many_small_steps():
    start, build = _scenario()
    end = start + timedelta(days=45)

    big = build()
    big.set_recipient_settings("r1", timezone_name="America/New_York")
    big.advance(end)

    small = build()
    small.set_recipient_settings("r1", timezone_name="America/New_York")
    moment = start
    while moment < end:
        moment = min(moment + timedelta(hours=3, seconds=17), end)
        small.advance(moment)

    assert big.delivery_log() == small.delivery_log()
    assert len(big.delivery_log()) > 60  # retries happened too
