"""Quiet-window logic: DST acceptance cases and brute-force comparison."""

from datetime import datetime, time, timedelta, timezone

import pytest

from quiet_hours import RecipientSettings, is_quiet, next_legal_instant

UTC = timezone.utc
NY = "America/New_York"


def dt(y, mo, d, h, mi, s=0):
    return datetime(y, mo, d, h, mi, s, tzinfo=UTC)


def test_default_window_crosses_midnight():
    s = RecipientSettings("UTC")  # 21:00 - 07:00
    assert not is_quiet(dt(2025, 6, 1, 20, 59, 59), s)
    assert is_quiet(dt(2025, 6, 1, 21, 0, 0), s)  # start inclusive
    assert is_quiet(dt(2025, 6, 2, 6, 59, 59), s)
    assert not is_quiet(dt(2025, 6, 2, 7, 0, 0), s)  # end exclusive
    assert not is_quiet(dt(2025, 6, 1, 12, 0, 0), s)


def test_same_day_window():
    s = RecipientSettings("UTC", time(12, 0), time(13, 30))
    assert is_quiet(dt(2025, 6, 1, 12, 0, 0), s)
    assert is_quiet(dt(2025, 6, 1, 13, 29, 59), s)
    assert not is_quiet(dt(2025, 6, 1, 13, 30, 0), s)
    assert not is_quiet(dt(2025, 6, 1, 11, 59, 59), s)


def test_fall_back_repeated_local_times_judged_separately():
    # 2025-11-02 America/New_York: 01:00-02:00 occurs twice (EDT then EST).
    s = RecipientSettings(NY, time(1, 45), time(2, 15))
    # 05:50 UTC = 01:50 EDT (first pass) -> inside window.
    assert is_quiet(dt(2025, 11, 2, 5, 50), s)
    # 06:00 UTC = 01:00 EST (second pass) -> outside window.
    assert not is_quiet(dt(2025, 11, 2, 6, 0), s)
    # 06:30 UTC = 01:30 EST -> still outside (before 01:45).
    assert not is_quiet(dt(2025, 11, 2, 6, 30), s)
    # 06:45 UTC = 01:45 EST -> inside again.
    assert is_quiet(dt(2025, 11, 2, 6, 45), s)
    # Planned 05:50 UTC must be delivered at 06:00 UTC, not local 02:15.
    assert next_legal_instant(dt(2025, 11, 2, 5, 50), s, False) == dt(2025, 11, 2, 6, 0)


def test_spring_forward_nonexistent_local_times():
    # 2025-03-09 America/New_York: 02:00-03:00 never happens.
    s = RecipientSettings(NY, time(1, 50), time(2, 10))
    # 06:55 UTC = 01:55 EST -> inside window.
    assert is_quiet(dt(2025, 3, 9, 6, 55), s)
    # 07:00 UTC = 03:00 EDT -> window end 02:10 never occurs; quiet ends at the jump.
    assert next_legal_instant(dt(2025, 3, 9, 6, 55), s, False) == dt(2025, 3, 9, 7, 0)


def test_urgent_never_deferred():
    s = RecipientSettings("UTC")
    lower = dt(2025, 6, 1, 23, 0)
    assert is_quiet(lower, s)
    assert next_legal_instant(lower, s, True) == lower


def test_lower_bound_outside_window_returned_as_is():
    s = RecipientSettings("UTC")
    lower = dt(2025, 6, 1, 12, 34, 56)
    assert next_legal_instant(lower, s, False) == lower


def test_deferral_to_window_end():
    s = RecipientSettings("UTC")  # 21:00 - 07:00
    assert next_legal_instant(dt(2025, 6, 1, 22, 30), s, False) == dt(2025, 6, 2, 7, 0)
    assert next_legal_instant(dt(2025, 6, 2, 3, 0), s, False) == dt(2025, 6, 2, 7, 0)


BRUTE_FORCE_CASES = [
    (RecipientSettings("UTC"), dt(2025, 6, 1, 22, 30)),
    (RecipientSettings("UTC", time(0, 0), time(23, 59)), dt(2025, 6, 1, 5, 0)),
    (RecipientSettings(NY, time(1, 45), time(2, 15)), dt(2025, 11, 2, 5, 50)),
    (RecipientSettings(NY, time(0, 30), time(1, 30)), dt(2025, 11, 2, 4, 0)),
    (RecipientSettings(NY, time(1, 50), time(2, 10)), dt(2025, 3, 9, 6, 55)),
    (RecipientSettings(NY, time(2, 30), time(3, 30)), dt(2025, 3, 9, 5, 0)),
    (RecipientSettings("Australia/Sydney"), dt(2025, 4, 5, 15, 0)),
    (RecipientSettings("Pacific/Auckland", time(22, 15), time(6, 45)), dt(2025, 9, 27, 10, 0)),
    (RecipientSettings("Asia/Tokyo"), dt(2025, 1, 15, 14, 0)),
    (RecipientSettings("Europe/Berlin", time(23, 30), time(5, 45)), dt(2030, 10, 26, 20, 0)),
]


@pytest.mark.parametrize("settings,lower", BRUTE_FORCE_CASES)
def test_matches_second_by_second_scan(settings, lower):
    """next_legal_instant must equal the first non-quiet second >= lower."""
    expected = None
    moment = lower
    for _ in range(48 * 3600):
        if not is_quiet(moment, settings):
            expected = moment
            break
        moment += timedelta(seconds=1)
    assert expected is not None
    assert next_legal_instant(lower, settings, False) == expected
