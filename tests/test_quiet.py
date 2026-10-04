"""择时正确性：DST 边界 + 与逐秒暴力扫描对照。"""
from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from quiet_scheduler.models import QuietWindow
from quiet_scheduler.quiet import _in_window, next_legal_utc

UTC = timezone.utc
NY = ZoneInfo("America/New_York")


def dt(y, mo, d, h, mi, s=0):
    return datetime(y, mo, d, h, mi, s, tzinfo=UTC)


def brute_force(lower, tz, window, limit_hours=48):
    """逐秒检查当地时分，返回最早合法 UTC 瞬间。"""
    t = lower
    end = lower + timedelta(hours=limit_hours)
    while t <= end:
        local = t.astimezone(tz)
        if not _in_window((local.hour, local.minute, local.second), window):
            return t
        t += timedelta(seconds=1)
    raise AssertionError("no legal instant found within limit")


class TestDstBoundaries:
    def test_fall_back_repeated_hour_judged_separately(self):
        # 2025-11-02 美国回拨：窗口 01:45-02:15，计划 05:50 UTC
        # 05:50 UTC = 01:50 EDT（窗口内），但 06:00 UTC = 01:00 EST（窗口外）
        window = QuietWindow(time(1, 45), time(2, 15))
        result = next_legal_utc(dt(2025, 11, 2, 5, 50), NY, window)
        assert result == dt(2025, 11, 2, 6, 0)

    def test_spring_forward_gap_not_real_time(self):
        # 2025-03-09 美国跳时：窗口 01:50-02:10，计划 06:55 UTC
        # 06:55 UTC = 01:55 EST（窗口内），02:10 不存在，07:00 UTC = 03:00 EDT
        window = QuietWindow(time(1, 50), time(2, 10))
        result = next_legal_utc(dt(2025, 3, 9, 6, 55), NY, window)
        assert result == dt(2025, 3, 9, 7, 0)

    def test_fall_back_second_quiet_pass_still_quiet(self):
        # 回拨后第二遍 01:45-02:15（EST）仍是静默：下限 06:50 UTC = 01:50 EST
        window = QuietWindow(time(1, 45), time(2, 15))
        result = next_legal_utc(dt(2025, 11, 2, 6, 50), NY, window)
        assert result == dt(2025, 11, 2, 7, 15)  # 02:15 EST


class TestAgainstBruteForce:
    """小规模随机场景与逐秒扫描对照。"""

    CASES = [
        (NY, QuietWindow(time(1, 45), time(2, 15)), dt(2025, 11, 1, 22, 0)),
        (NY, QuietWindow(time(1, 50), time(2, 10)), dt(2025, 3, 8, 22, 0)),
        (NY, QuietWindow(), dt(2025, 11, 2, 3, 0)),
        (NY, QuietWindow(), dt(2025, 3, 9, 3, 0)),
        (ZoneInfo("Europe/Berlin"), QuietWindow(), dt(2025, 10, 26, 0, 0)),
        (ZoneInfo("Australia/Sydney"), QuietWindow(time(23, 30), time(5, 45)), dt(2025, 10, 4, 12, 0)),
        (ZoneInfo("Asia/Shanghai"), QuietWindow(), dt(2025, 6, 1, 0, 0)),
    ]

    def test_matches_second_by_second_scan(self):
        for tz, window, start in self.CASES:
            # 在起点附近每 7 分钟取一个下限，分别对照
            for step in range(0, 3600 * 6, 420):
                lower = start + timedelta(seconds=step)
                expected = brute_force(lower, tz, window)
                actual = next_legal_utc(lower, tz, window)
                assert actual == expected, (tz, window, lower, expected, actual)
