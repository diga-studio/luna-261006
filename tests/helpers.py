"""Deterministic content generator shared by tests.

Content is a chain of sha256 blocks so any byte range can be
regenerated independently for verification without holding the
whole object in memory.
"""

from __future__ import annotations

import hashlib


def _block(seed: str, index: int) -> bytes:
    return hashlib.sha256(f"{seed}:{index}".encode()).digest()


def pattern_bytes(seed: str, start: int, length: int) -> bytes:
    """Bytes [start, start+length) of the deterministic stream."""
    out = bytearray()
    while length > 0:
        index, off = divmod(start, 32)
        take = min(32 - off, length)
        out += _block(seed, index)[off:off + take]
        start += take
        length -= take
    return bytes(out)


class PatternStream:
    """File-like read-only stream of `length` deterministic bytes."""

    def __init__(self, seed: str, length: int, start: int = 0) -> None:
        self._seed = seed
        self._end = start + length
        self._pos = start

    def read(self, n: int = -1) -> bytes:
        if self._pos >= self._end:
            return b""
        if n is None or n < 0:
            n = self._end - self._pos
        n = min(n, self._end - self._pos)
        data = pattern_bytes(self._seed, self._pos, n)
        self._pos += n
        return data
