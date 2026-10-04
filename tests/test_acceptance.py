"""端到端验收：通过 Scheduler 完整流程验证 DST 场景。"""
from datetime import datetime, time, timezone

from quiet_scheduler import Scheduler

UTC = timezone.utc


def dt(y, mo, d, h=0, mi=0, s=0):
    return datetime(y, mo, d, h, mi, s, tzinfo=UTC)


def run(tz_name, start_t, end_t, scheduled):
    fires = []
    sch = Scheduler(dt(2025, 1, 1), lambda d: (fires.append(d), True)[1])
    sch.update_recipient("guardian", tz_name=tz_name,
                         quiet_start=start_t, quiet_end=end_t)
    sch.register_notification("n1", "guardian", scheduled)
    sch.advance(dt(2025, 12, 31))
    return fires


def test_fall_back_end_to_end():
    # America/New_York 2025-11-02 回拨，窗口 01:45-02:15，计划 05:50 UTC
    fires = run("America/New_York", time(1, 45), time(2, 15), dt(2025, 11, 2, 5, 50))
    assert [d.fire_utc for d in fires] == [dt(2025, 11, 2, 6, 0)]


def test_spring_forward_end_to_end():
    # America/New_York 2025-03-09 跳时，窗口 01:50-02:10，计划 06:55 UTC
    fires = run("America/New_York", time(1, 50), time(2, 10), dt(2025, 3, 9, 6, 55))
    assert [d.fire_utc for d in fires] == [dt(2025, 3, 9, 7, 0)]
