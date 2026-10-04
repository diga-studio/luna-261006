"""静默窗口择时：计算不早于下限的最早合法 UTC 瞬间。

当地时分作为 UTC 的函数是分段线性的，只在时区偏移切换点出现跳变。
因此从下限出发：若当前在窗口内，先按当地朴素时间推算窗口结束点；
若区间内发生偏移切换（秋退回拨/春跳前跳），则定位切换点后重新判断，
保证秋季重复的当地时分被分别判断、春季不存在的时分不占真实时间。
"""
from __future__ import annotations

from datetime import datetime, timedelta, tzinfo
from zoneinfo import ZoneInfo

from .models import QuietWindow

_ONE_SECOND = timedelta(seconds=1)


def _tod(t) -> tuple[int, int, int]:
    return (t.hour, t.minute, t.second)


def _in_window(tod: tuple[int, int, int], window: QuietWindow) -> bool:
    start = _tod(window.start)
    end = _tod(window.end)
    if start < end:
        return start <= tod < end
    return tod >= start or tod < end


def _window_end_naive(local: datetime, window: QuietWindow) -> datetime:
    """local（aware）处于窗口内时，窗口结束时刻的当地朴素日期时间。"""
    end_date = local.date()
    if _tod(window.start) > _tod(window.end) and _tod(local) >= _tod(window.start):
        # 跨午夜窗口的晚间段：结束在次日
        end_date += timedelta(days=1)
    naive_end = datetime.combine(end_date, window.end)
    if naive_end <= local.replace(tzinfo=None):
        # 防御：结束点必须严格晚于当前当地朴素时间
        naive_end += timedelta(days=1)
    return naive_end


def _first_offset_change(begin: datetime, end: datetime, tz: tzinfo) -> datetime:
    """(begin, end] 内第一个 utcoffset 与 begin 处不同的 UTC 瞬间（秒精度）。"""
    base = begin.astimezone(tz).utcoffset()
    lo = begin
    hi = end
    while (hi - lo) > _ONE_SECOND:
        mid = lo + (hi - lo) / 2
        mid = mid.replace(microsecond=0)
        if mid <= lo:
            mid = lo + _ONE_SECOND
        if mid.astimezone(tz).utcoffset() == base:
            lo = mid
        else:
            hi = mid
    return hi


def next_legal_utc(lower: datetime, tz: ZoneInfo, window: QuietWindow) -> datetime:
    """返回不早于 lower 的最早合法 UTC 瞬间（当地时分落在静默窗口外）。"""
    t = lower.replace(microsecond=0)
    while True:
        local = t.astimezone(tz)
        if not _in_window(_tod(local), window):
            return t
        naive_end = _window_end_naive(local, window)
        candidate = t + (naive_end - local.replace(tzinfo=None))
        if candidate.astimezone(tz).utcoffset() == local.utcoffset():
            # 区间内无偏移切换，candidate 的当地时分恰为窗口结束（不含），合法
            return candidate
        # 区间内发生偏移切换，从切换点之后重新判断
        t = _first_offset_change(t, candidate, tz)
