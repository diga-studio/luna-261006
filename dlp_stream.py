"""Offline streaming DLP scanner: detects and redacts SSN, bank card
numbers, and US phone numbers in a chunked UTF-8 byte stream.

Usage:
    from dlp_stream import Scanner

    scanner = Scanner()
    out = b""
    for chunk in chunks:            # chunks: arbitrary bytes, may be empty
        out += scanner.feed(chunk)  # determined, redacted bytes
    tail, counts = scanner.finish()  # drain remainder + hit totals
    result = out + tail             # same length as the original input
"""

from __future__ import annotations

import re
from typing import NamedTuple


class Counts(NamedTuple):
    """Hit totals for the three categories."""

    ssn: int
    card: int
    phone: int


# Maximum byte length of a card candidate: 19 digits + 18 separators.
CARD_MAX_SPAN = 37
# Maximum bytes any category may need beyond a candidate start to decide it
# (card span plus one right-boundary byte).
HOLD_BACK = CARD_MAX_SPAN + 1


def _is_alnum(byte: int) -> bool:
    """ASCII letter or digit only; non-ASCII bytes are never alnum."""
    return 48 <= byte <= 57 or 65 <= byte <= 90 or 97 <= byte <= 122


def _luhn_ok(digits: list[int]) -> bool:
    """Luhn checksum over a list of integer digit values."""
    total = 0
    for i, value in enumerate(reversed(digits)):
        if i % 2 == 1:
            value *= 2
            if value > 9:
                value -= 9
        total += value
    return total % 10 == 0


# A card "token": a digit followed by digits, each optionally preceded by a
# single ASCII space or hyphen.  Maximal run per the candidate grammar.
_TOKEN_RE = re.compile(rb"[0-9](?:[ -]?[0-9])*")

# SSN / phone candidate shapes (boundaries checked separately).
_SSN_RE = re.compile(rb"[0-9]{3}-[0-9]{2}-[0-9]{4}")
_PHONE_RE = re.compile(rb"\([0-9]{3}\) [0-9]{3}-[0-9]{4}|[0-9]{3}-[0-9]{3}-[0-9]{4}")


def _left_ok(buf: bytes | bytearray, start: int, prev_alnum: bool) -> bool:
    if start == 0:
        return not prev_alnum
    return not _is_alnum(buf[start - 1])


def _right_ok(buf: bytes | bytearray, end: int, final: bool) -> bool | None:
    """Right boundary at ``end``: True/False, or None if not yet decidable."""
    if end < len(buf):
        return not _is_alnum(buf[end])
    return True if final else None


def _ssn_groups_ok(m: re.Match) -> bool:
    area = m.group(0)[:3]
    if area == b"000" or area == b"666" or area >= b"900":
        return False
    return m.group(0)[4:6] != b"00" and m.group(0)[7:11] != b"0000"


def _scan_fixed(buf, prev_alnum, final, regex, span, validator):
    """Greedy left-to-right scan for a fixed-length regex category.

    Returns (matches, confirmed_upto): matches as (start, end) pairs, and
    the buffer offset before which every start position is fully decided.
    """
    matches = []
    n = len(buf)
    pos = 0
    while True:
        m = regex.search(buf, pos)
        if m is None:
            # Starts with fewer than ``span`` bytes left may still grow into
            # a candidate, so they are undecidable unless input is final.
            return matches, n if final else max(pos, n - span)
        s, e = m.start(), m.end()
        if not _left_ok(buf, s, prev_alnum):
            pos = s + 1
            continue
        right = _right_ok(buf, e, final)
        if right is None:
            return matches, s
        if right and validator(m):
            matches.append((s, e))
            pos = e
        else:
            pos = s + 1


def _scan_ssn(buf, prev_alnum, final):
    return _scan_fixed(buf, prev_alnum, final, _SSN_RE, 11, _ssn_groups_ok)


def _scan_phone(buf, prev_alnum, final):
    return _scan_fixed(buf, prev_alnum, final, _PHONE_RE, 13, lambda m: True)


# Doubled-and-folded digit values for Luhn.
_DBL = tuple(2 * v - 9 if v >= 5 else 2 * v for v in range(10))


def _scan_card(buf, prev_alnum, final):
    """Greedy left-to-right scan for Luhn-valid card candidates.

    Returns (matches, confirmed_upto), same contract as _scan_fixed.
    """
    matches = []
    n = len(buf)
    resume = 0
    for tok in _TOKEN_RE.finditer(buf):
        ts, te = tok.start(), tok.end()
        if te <= resume:
            continue
        # A token is open-ended (may grow with future input) when it reaches
        # the buffer end, possibly via a trailing lone separator.
        open_ended = not final and (
            te == n or (te == n - 1 and buf[te] in b" -")
        )
        total = te - ts
        if buf[ts:te].isdigit():
            # Dense run: only the token start can satisfy the left boundary.
            if open_ended and total <= 19:
                # May grow into a longer (possibly valid) candidate.
                return matches, ts
            if total > 19 or total < 13:
                continue
            if not _left_ok(buf, ts, prev_alnum):
                continue
            right = _right_ok(buf, te, final)
            if right is None:
                return matches, ts
            if right and _luhn_ok([b - 48 for b in buf[ts:te]]):
                matches.append((ts, te))
                resume = te
            continue
        # Mixed token: locate digits and their values.
        pos = []
        vals = []
        for i in range(ts, te):
            b = buf[i]
            if 48 <= b <= 57:
                pos.append(i)
                vals.append(b - 48)
        total = len(pos)
        j = 0
        while j < total:
            p = pos[j]
            if p < resume:
                j += 1
                continue
            if j == 0:
                if not _left_ok(buf, ts, prev_alnum):
                    j += 1
                    continue
            elif pos[j - 1] == p - 1:
                j += 1  # previous byte is a digit: boundary fails
                continue
            avail = total - j
            if open_ended and avail <= 19:
                # Token may grow or the 19-digit boundary is unknown.
                return matches, p
            if avail < 13:
                break
            kmax = min(19, avail)
            # Luhn sums for the window vals[j:j+kmax]; p_sum is the Luhn sum
            # aligned to the window end, q_sum with flipped parity.
            p_sum = 0
            q_sum = 0
            last = j + kmax - 1
            for i in range(j, j + kmax):
                v = vals[i]
                if (last - i) % 2 == 0:
                    p_sum += v
                    q_sum += _DBL[v]
                else:
                    p_sum += _DBL[v]
                    q_sum += v
            for k in range(kmax, 12, -1):
                end_pos = pos[j + k - 1] + 1
                if j + k < total:
                    ok = pos[j + k] != end_pos  # separator follows
                else:
                    right = _right_ok(buf, end_pos, final)
                    if right is None:
                        return matches, p
                    ok = right
                if ok and p_sum % 10 == 0:
                    matches.append((p, end_pos))
                    resume = end_pos
                    break
                v = vals[j + k - 1]
                p_sum, q_sum = q_sum - _DBL[v], p_sum - v
            j += 1
    return matches, n


def _apply_mask(out, buf, s, e):
    """Mask all but the last four digits of buf[s:e] inside ``out``."""
    digits = [i for i in range(s, e) if 48 <= buf[i] <= 57]
    for i in digits[:-4]:
        out[i] = 0x58  # 'X'


class Scanner:
    """Streaming redactor. Not thread-safe; one instance per stream."""

    def __init__(self) -> None:
        self._buf = bytearray()
        self._prev_alnum = False  # byte before buffer start is ASCII alnum?
        self._counts = [0, 0, 0]  # ssn, card, phone
        self._finished = False

    def _process(self, final: bool) -> bytes:
        buf = self._buf
        if not buf:
            return b""
        ssn_m, ssn_c = _scan_ssn(buf, self._prev_alnum, final)
        card_m, card_c = _scan_card(buf, self._prev_alnum, final)
        phone_m, phone_c = _scan_phone(buf, self._prev_alnum, final)
        d = min(ssn_c, card_c, phone_c)
        # Never cut through a confirmed match: it must be emitted whole.
        while True:
            cut = [s for s, e in ssn_m + card_m + phone_m if s < d < e]
            if not cut:
                break
            d = min(cut)
        out = bytearray(buf[:d])
        for matches, slot in ((ssn_m, 0), (card_m, 1), (phone_m, 2)):
            for s, e in matches:
                if s < d:
                    _apply_mask(out, buf, s, e)
                    self._counts[slot] += 1
        if d:
            self._prev_alnum = _is_alnum(buf[d - 1])
            del buf[:d]
        return bytes(out)

    def feed(self, chunk: bytes) -> bytes:
        """Feed a chunk; return bytes that are fully determined."""
        if self._finished:
            raise ValueError("feed() after finish()")
        self._buf += chunk
        return self._process(False)

    def finish(self) -> tuple[bytes, Counts]:
        """Signal end of input; return remaining bytes and hit totals."""
        if self._finished:
            raise ValueError("finish() called twice")
        self._finished = True
        out = self._process(True)
        return out, Counts(*self._counts)


def scan_bytes(data: bytes) -> tuple[bytes, Counts]:
    """One-shot convenience: redact a complete byte string."""
    scanner = Scanner()
    out = scanner.feed(data)
    tail, counts = scanner.finish()
    return out + tail, counts
