"""调度器行为：重试、紧急、设置变更重新择时、大小步推进一致。"""
from datetime import datetime, time, timedelta, timezone

import pytest

from quiet_scheduler import Scheduler

UTC = timezone.utc


def dt(y, mo, d, h=0, mi=0, s=0):
    return datetime(y, mo, d, h, mi, s, tzinfo=UTC)


def make(start=None, results=()):
    """results: 可迭代布尔，按投递顺序依次消费；缺省成功。"""
    it = iter(results)
    fires = []

    def deliver(d):
        fires.append(d)
        return next(it, True)

    sch = Scheduler(start or dt(2025, 1, 1), deliver)
    return sch, fires


class TestBasicScheduling:
    def test_register_and_advance_delivers_at_scheduled_time(self):
        sch, fires = make()
        sch.register_notification("n1", "alice", dt(2025, 1, 1, 8, 0))
        sch.advance(dt(2025, 1, 2))
        assert [d.fire_utc for d in fires] == [dt(2025, 1, 1, 8, 0)]

    def test_past_scheduled_time_uses_now_as_lower_bound(self):
        sch, fires = make(start=dt(2025, 1, 1, 12, 0))
        sch.register_notification("n1", "alice", dt(2025, 1, 1, 8, 0))
        sch.advance(dt(2025, 1, 1, 12, 0))
        assert [d.fire_utc for d in fires] == [dt(2025, 1, 1, 12, 0)]

    def test_quiet_window_defers_normal_notification(self):
        # 默认窗口 UTC 21:00-07:00；计划 22:00 -> 次日 07:00
        sch, fires = make()
        sch.register_notification("n1", "alice", dt(2025, 1, 1, 22, 0))
        sch.advance(dt(2025, 1, 3))
        assert [d.fire_utc for d in fires] == [dt(2025, 1, 2, 7, 0)]

    def test_urgent_ignores_quiet_window(self):
        sch, fires = make()
        sch.register_notification("n1", "alice", dt(2025, 1, 1, 22, 0), urgent=True)
        sch.advance(dt(2025, 1, 2))
        assert [d.fire_utc for d in fires] == [dt(2025, 1, 1, 22, 0)]

    def test_no_delivery_before_advance(self):
        sch, fires = make()
        sch.register_notification("n1", "alice", dt(2025, 1, 1, 8, 0))
        assert fires == []

    def test_readvance_to_same_time_does_not_repeat(self):
        sch, fires = make()
        sch.register_notification("n1", "alice", dt(2025, 1, 1, 8, 0))
        sch.advance(dt(2025, 1, 1, 9, 0))
        sch.advance(dt(2025, 1, 1, 9, 0))
        assert len(fires) == 1

    def test_clock_cannot_go_backward(self):
        sch, _ = make()
        with pytest.raises(ValueError):
            sch.advance(dt(2024, 12, 31))


class TestRetries:
    def test_retry_lower_bounds_30_120_600(self):
        sch, fires = make(results=[False, False, False, True])
        sch.register_notification("n1", "alice", dt(2025, 1, 1, 8, 0))
        sch.advance(dt(2025, 1, 2))
        assert [d.fire_utc for d in fires] == [
            dt(2025, 1, 1, 8, 0),
            dt(2025, 1, 1, 8, 0, 30),
            dt(2025, 1, 1, 8, 2, 30),
            dt(2025, 1, 1, 8, 12, 30),
        ]
        assert [d.attempt for d in fires] == [1, 2, 3, 4]

    def test_fourth_failure_is_permanent(self):
        sch, fires = make(results=[False] * 10)
        sch.register_notification("n1", "alice", dt(2025, 1, 1, 8, 0))
        sch.advance(dt(2025, 1, 10))
        assert len(fires) == 4
        assert [r.succeeded for r in sch.trajectory("n1")] == [False] * 4

    def test_retry_also_respects_quiet_window(self):
        # 初次 06:59:30 UTC 失败，+30s = 07:00:00 仍在默认窗口（至 07:00 不含）
        # 恰好在窗口结束点，合法；改用 06:00 失败则 +30s 仍静默 -> 07:00
        sch, fires = make(results=[False, True])
        sch.register_notification("n1", "alice", dt(2025, 1, 1, 6, 0))
        sch.advance(dt(2025, 1, 2))
        assert [d.fire_utc for d in fires] == [
            dt(2025, 1, 1, 7, 0),   # 初次 06:00 在窗口内，推迟到 07:00
            dt(2025, 1, 1, 7, 0, 30),
        ]

    def test_urgent_retries_without_quiet_deferral(self):
        sch, fires = make(results=[False, True])
        sch.register_notification("n1", "alice", dt(2025, 1, 1, 22, 0), urgent=True)
        sch.advance(dt(2025, 1, 2))
        assert [d.fire_utc for d in fires] == [
            dt(2025, 1, 1, 22, 0),
            dt(2025, 1, 1, 22, 0, 30),
        ]


class TestSettingsChange:
    def test_delayed_retry_moved_earlier_by_window_change(self):
        # 初次失败后重试下限 08:30，被默认窗口（至 07:00）不影响；
        # 改为窗口 08:00-09:00 使重试推迟到 09:00，再改回无窗口冲突应提前。
        sch, fires = make(results=[False, True])
        sch.register_notification("n1", "alice", dt(2025, 1, 1, 8, 0))
        sch.advance(dt(2025, 1, 1, 8, 0))  # 初次失败于 08:00，重试下限 08:00:30
        assert [d.fire_utc for d in fires] == [dt(2025, 1, 1, 8, 0)]

        # 设置窗口 07:30-12:00，重试被推迟到 12:00
        sch.update_recipient("alice", quiet_start=time(7, 30), quiet_end=time(12, 0))
        sch.advance(dt(2025, 1, 1, 11, 0))
        assert len(fires) == 1  # 尚未到 12:00

        # 修改窗口为 07:30-08:00：重试下限仍是 08:00:30（未经静默推迟），
        # 与当前时刻 11:00 取较晚者 -> 11:00 即投，不能沿用旧的 12:00
        sch.update_recipient("alice", quiet_start=time(7, 30), quiet_end=time(8, 0))
        sch.advance(dt(2025, 1, 1, 11, 0))
        assert [d.fire_utc for d in fires] == [
            dt(2025, 1, 1, 8, 0),
            dt(2025, 1, 1, 11, 0),
        ]

    def test_settings_change_does_not_consume_attempts(self):
        sch, fires = make(results=[False, True])
        sch.register_notification("n1", "alice", dt(2025, 1, 1, 8, 0))
        sch.advance(dt(2025, 1, 1, 8, 0))
        sch.update_recipient("alice", quiet_start=time(0, 0), quiet_end=time(1, 0))
        sch.update_recipient("alice", tz_name="Asia/Shanghai")
        sch.advance(dt(2025, 1, 2))
        assert [d.attempt for d in fires] == [1, 2]

    def test_settings_change_does_not_backfill_past(self):
        sch, fires = make(start=dt(2025, 1, 1, 12, 0))
        sch.register_notification("n1", "alice", dt(2025, 1, 1, 8, 0))
        # 此刻计划触发为 12:00（下限=now）；推进前改设置不应在过去补发
        sch.update_recipient("alice", quiet_start=time(0, 0), quiet_end=time(0, 1))
        sch.advance(dt(2025, 1, 1, 12, 0))
        assert [d.fire_utc for d in fires] == [dt(2025, 1, 1, 12, 0)]


class TestStepEquivalence:
    def test_big_jump_equals_small_steps(self):
        results = [False, True, False, False, True, True]

        def run(step):
            it = iter(results)
            fires = []
            sch = Scheduler(dt(2025, 1, 1), lambda d: (fires.append(d), next(it, True))[1])
            sch.register_notification("a", "alice", dt(2025, 1, 1, 8, 0))
            sch.register_notification("b", "bob", dt(2025, 1, 1, 8, 0, 10), urgent=True)
            sch.register_notification("c", "alice", dt(2025, 1, 1, 9, 0))
            end = dt(2025, 1, 3)
            t = sch._now
            while t < end:
                t = min(t + step, end)
                sch.advance(t)
            return [(d.notification_id, d.attempt, d.fire_utc) for d in fires]

        big = run(timedelta(days=2))
        small = run(timedelta(seconds=7))
        assert big == small
        # 轨迹按时间顺序且包含重试
        assert [f[2] for f in big] == sorted(f[2] for f in big)
