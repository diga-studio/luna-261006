"""Quiet-window evaluation and legal-instant search."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from .models import RecipientSettings

UTC = timezone.utc
_STEP = timedelta(hours=6)
_SEARCH_HORIZON_STEPS = 8  # 8 * 6h = 48h of transition lookahead


def is_quiet(moment: datetime, settings: RecipientSettings) -> bool:
    """Return True if the UTC instant falls inside the recipient's quiet window."""
    start = settings.quiet_start
    end = settings.quiet_end
    if start == end:
        return False
    tod = moment.astimezone(ZoneInfo(settings.timezone_name)).time()
    if start < end:
        return start <= tod < end
    return tod >= start or tod < end


def _quiet_end_local(moment: datetime, tz: ZoneInfo, settings: RecipientSettings) -> datetime:
    """Naive local datetime of the end of the quiet window containing moment."""
    local = moment.astimezone(tz)
    end = settings.quiet_end
    if settings.quiet_start < end:
        end_date = local.date()
    elif local.time() < end:
        end_date = local.date()
    else:
        end_date = local.date() + timedelta(days=1)
    return datetime.combine(end_date, end)


def _next_transition(moment: datetime, tz: ZoneInfo) -> datetime | None:
    """First UTC instant after moment where the UTC offset changes, or None."""
    offset = moment.astimezone(tz).utcoffset()
    lo = moment
    for _ in range(_SEARCH_HORIZON_STEPS):
        hi = lo + _STEP
        if hi.astimezone(tz).utcoffset() != offset:
            while hi - lo > timedelta(seconds=1):
                mid = lo + (hi - lo) / 2
                if mid.astimezone(tz).utcoffset() == offset:
                    lo = mid
                else:
                    hi = mid
            sec = lo.replace(microsecond=0)
            while sec.astimezone(tz).utcoffset() == offset:
                sec += timedelta(seconds=1)
            return sec
        lo = hi
    return None


def next_legal_instant(lower: datetime, settings: RecipientSettings, urgent: bool) -> datetime:
    """Earliest UTC instant >= lower at which delivery is allowed."""
    if urgent or not is_quiet(lower, settings):
        return lower
    tz = ZoneInfo(settings.timezone_name)
    moment = lower
    for _ in range(64):
        end_local = _quiet_end_local(moment, tz, settings)
        candidates: list[datetime] = []
        for fold in (0, 1):
            aware = end_local.replace(tzinfo=tz, fold=fold)
            utc = aware.astimezone(UTC)
            if utc > moment and utc.astimezone(tz).replace(tzinfo=None) == end_local:
                candidates.append(utc)
        transition = _next_transition(moment, tz)
        if transition is not None:
            candidates.append(transition)
        nxt = min(candidates)
        if not is_quiet(nxt, settings):
            return nxt
        moment = nxt
    raise RuntimeError("no legal delivery instant found")
