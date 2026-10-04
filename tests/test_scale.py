"""规模测试：2 万条待发通知、100 个时区、30 天推进、秒级完成。"""
import random
import time as time_mod
from datetime import datetime, timedelta, timezone
from zoneinfo import available_timezones

from quiet_scheduler import Scheduler

UTC = timezone.utc
START = datetime(2025, 1, 1, tzinfo=UTC)
END = START + timedelta(days=30)


def _zones():
    zones = sorted(z for z in available_timezones() if "/" in z and not z.startswith("Etc/"))
    return zones[:100]


def _build(notify_count=20_000):
    rng = random.Random(20250101)
    zones = _zones()
    deliveries = []

    def deliver(d):
        deliveries.append(d)
        # 确定性失败模式：全部首次失败，半数二次失败，四分之一三次失败
        h = hash(d.notification_id) & 0xFFFF
        if d.attempt == 1:
            return False
        if d.attempt == 2:
            return h % 2 == 0
        if d.attempt == 3:
            return h % 4 == 0
        return True

    sch = Scheduler(START, deliver)
    for i in range(notify_count):
        sch.register_notification(
            f"n{i}",
            f"r{i % 2000}",
            START + timedelta(seconds=rng.randrange(0, 30 * 24 * 3600)),
            urgent=(i % 17 == 0),
        )
    # 为 2000 个收件人分配 100 个时区（含默认静默窗口）
    for r in range(2000):
        sch.update_recipient(f"r{r}", tz_name=zones[r % len(zones)])
    return sch, deliveries


def test_scale_30_day_advance_under_10_seconds():
    sch, deliveries = _build()
    t0 = time_mod.monotonic()
    sch.advance(END)
    elapsed = time_mod.monotonic() - t0
    assert len(deliveries) <= 80_000
    assert len(deliveries) > 20_000  # 确实发生了大量重试
    assert elapsed < 10, f"advance took {elapsed:.2f}s"
    # 回调收到的时刻按时间顺序
    fires = [d.fire_utc for d in deliveries]
    assert fires == sorted(fires)


def test_scale_big_jump_equals_small_steps():
    sch_big, fires_big = _build(notify_count=2_000)
    sch_small, fires_small = _build(notify_count=2_000)
    sch_big.advance(END)
    t = START
    while t < END:
        t = min(t + timedelta(hours=3, minutes=17), END)
        sch_small.advance(t)
    key = lambda d: (d.notification_id, d.attempt, d.fire_utc)
    assert [key(d) for d in fires_big] == [key(d) for d in fires_small]
