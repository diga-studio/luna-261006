"""Offline streaming DLP detection and redaction library (stdlib only).

Detects and redacts US SSNs, bank card numbers (Luhn-validated) and US
phone numbers in a chunked UTF-8 byte stream.

Matching rules (d = ASCII digit):
  * SSN:   "ddd-dd-dddd"; first group not 000/666/900-999, other groups
           not all zero.
  * Card:  13-19 digits, at most one ASCII space or hyphen between
           adjacent digits (mixable), must pass Luhn.
  * Phone: "ddd-ddd-dddd" or "(ddd) ddd-dddd" (exactly one space).
  * Candidate neighbours (if any) must not be ASCII letters/digits;
    stream edges count as valid boundaries.

Each category scans independently left-to-right (earliest start, longest
valid candidate at that start, then continue from that hit's end).
Each hit keeps its last four digits; other digits become "X";
separators are preserved.  Mask requirements from all hits are unioned.
"""

from __future__ import annotations

import re

CATEGORIES = ("ssn", "card", "phone")

# Sentinel returned by matchers when more input is needed to decide.
_NEED = object()

_SSN_PAT = b"ddd-dd-dddd"
_PHONE_PAT_PLAIN = b"ddd-ddd-dddd"
_PHONE_PAT_PAREN = b"(ddd) ddd-dddd"

# Valid candidate start: a digit or '(' not preceded by an ASCII alnum.
_START_RE = re.compile(rb"(?<![0-9A-Za-z])[0-9(]")

_X = 0x58          # 'X'
_LPAREN = 0x28     # '('
_SPACE = 0x20
_HYPHEN = 0x2D


def _is_digit(b: int) -> bool:
    return 0x30 <= b <= 0x39


def _is_alnum(b: int) -> bool:
    return 0x30 <= b <= 0x39 or 0x41 <= b <= 0x5A or 0x61 <= b <= 0x7A


def _luhn_ok(digits) -> bool:
    total = 0
    for i, d in enumerate(reversed(digits)):
        if i & 1:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


class Scanner:
    """Streaming redactor; see module docstring for the rules."""

    def __init__(self) -> None:
        self._buf = bytearray()          # unemitted raw input bytes
        self._mask = bytearray()         # parallel flags: 1 => replace with 'X'
        self._dirty = 0                  # upper bound of set flags in _mask
        self._base = 0                   # absolute offset of _buf[0]
        self._prev = None                # byte at _base - 1 (None at stream start)
        self._cursor = {c: 0 for c in CATEGORIES}
        self._counts = {c: 0 for c in CATEGORIES}
        self._done = False

    # ------------------------------------------------------------------
    # public API
    # ------------------------------------------------------------------
    def feed(self, chunk: bytes) -> bytes:
        if self._done:
            raise ValueError("feed() after finish()")
        if chunk:
            self._buf += chunk
            self._mask += bytes(len(chunk))
        horizon = min(self._advance(c, False) for c in CATEGORIES)
        n = horizon - self._base
        return self._emit(n) if n > 0 else b""

    def finish(self) -> tuple[bytes, dict[str, int]]:
        if self._done:
            raise ValueError("finish() called twice")
        self._done = True
        for c in CATEGORIES:
            self._advance(c, True)
        out = self._emit(len(self._buf)) if self._buf else b""
        return out, dict(self._counts)

    # ------------------------------------------------------------------
    # streaming core
    # ------------------------------------------------------------------
    def _find_start(self, pos: int):
        """Earliest valid candidate start at absolute position >= pos."""
        buf = self._buf
        base = self._base
        j = max(pos, base) - base
        prev = self._prev
        while True:
            m = _START_RE.search(buf, j)
            if m is None:
                return None
            k = m.start()
            if k == 0 and prev is not None and _is_alnum(prev):
                j = 1
                continue
            return base + k

    def _advance(self, cat: str, eof: bool) -> int:
        """Resolve hits for one category as far as possible.

        Returns the absolute position up to which this category's mask
        decisions are final.
        """
        cur = self._cursor[cat]
        base = self._base
        while True:
            s = self._find_start(cur)
            if s is None:
                self._cursor[cat] = cur
                return base + len(self._buf)
            r = self._match(cat, s, eof)
            if r is _NEED:
                self._cursor[cat] = cur
                return s
            if r is None:
                cur = s + 1
                continue
            end, digs = r
            mask = self._mask
            for p in digs[:-4]:  # keep last four digits of the hit
                i = p - base
                if not mask[i]:
                    mask[i] = 1
                    self._dirty += 1
            self._counts[cat] += 1
            cur = end
        # unreachable

    def _emit(self, n: int) -> bytes:
        buf = self._buf
        self._prev = buf[n - 1]
        if self._dirty:
            flagged = self._mask[:n].count(1)
            if flagged:
                out = bytearray(buf[:n])
                mask = self._mask
                for i in range(n):
                    if mask[i]:
                        out[i] = _X
                self._dirty -= flagged
                del buf[:n]
                del mask[:n]
                self._base += n
                return bytes(out)
            self._dirty = 0
        out = bytes(buf[:n])
        del buf[:n]
        del self._mask[:n]
        self._base += n
        return out


    # ------------------------------------------------------------------
    # matchers: each returns (end, digit_positions) | None | _NEED
    # positions are absolute; `s` is a valid start (boundary checked).
    # ------------------------------------------------------------------
    def _match(self, cat: str, s: int, eof: bool):
        if cat == "card":
            return self._match_card(s, eof)
        b0 = self._buf[s - self._base]
        if cat == "ssn":
            if not _is_digit(b0):
                return None
            r = self._match_fixed(s, eof, _SSN_PAT)
            if r is None or r is _NEED:
                return r
            end, digs = r
            d = [self._buf[p - self._base] - 0x30 for p in digs]
            area = d[0] * 100 + d[1] * 10 + d[2]
            if area == 0 or area == 666 or area >= 900:
                return None
            if d[3] == 0 and d[4] == 0:
                return None
            if d[5] == 0 and d[6] == 0 and d[7] == 0 and d[8] == 0:
                return None
            return (end, digs)
        # phone
        if b0 == _LPAREN:
            return self._match_fixed(s, eof, _PHONE_PAT_PAREN)
        if not _is_digit(b0):
            return None
        return self._match_fixed(s, eof, _PHONE_PAT_PLAIN)

    def _match_fixed(self, s: int, eof: bool, pat: bytes):
        buf = self._buf
        base = self._base
        n = len(buf)
        i = s - base
        L = len(pat)
        for k in range(L):
            if i + k >= n:
                return _NEED if not eof else None
            b = buf[i + k]
            p = pat[k]
            if p == 0x64:  # 'd' => digit slot
                if not _is_digit(b):
                    return None
            elif b != p:
                return None
        if i + L == n:
            if not eof:
                return _NEED
        elif _is_alnum(buf[i + L]):
            return None
        end = base + i + L
        digs = [base + i + k for k in range(L) if pat[k] == 0x64]
        return (end, digs)

    def _match_card(self, s: int, eof: bool):
        buf = self._buf
        base = self._base
        n = len(buf)
        j = s - base
        pos = []  # absolute positions of the token's digits (<= 19)
        while True:
            if j >= n:
                if not eof:
                    return _NEED
                end = n
                break
            if not _is_digit(buf[j]):
                end = j
                break
            pos.append(base + j)
            j += 1
            if len(pos) == 19:
                end = j
                break
            if j >= n:
                if not eof:
                    return _NEED
                end = n
                break
            b = buf[j]
            if _is_digit(b):
                continue
            if b == _SPACE or b == _HYPHEN:
                if j + 1 >= n:
                    if not eof:
                        return _NEED
                    end = j  # trailing separator is not part of the token
                    break
                if _is_digit(buf[j + 1]):
                    j += 1
                    continue
                end = j
                break
            end = j
            break
        if end == n and not eof:
            return _NEED  # right boundary byte not yet available
        maxk = len(pos)
        for k in range(min(19, maxk), 12, -1):
            end_k = pos[k - 1] + 1
            if k < maxk:
                # boundary byte sits between digit k and digit k+1:
                # adjacent digit => boundary fails; separator => ok.
                if pos[k] == end_k:
                    continue
            elif end < n and _is_alnum(buf[end]):
                continue
            if _luhn_ok([buf[p - base] - 0x30 for p in pos[:k]]):
                return (end_k, pos[:k])
        return None
