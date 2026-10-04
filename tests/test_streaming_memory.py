"""512 MiB streaming upload: verifies the 32 MiB working-memory budget
for upload, prefix comparison and digest validation (excluding the
caller's own input buffer, which here is generated 1 MiB at a time).
"""

import hashlib
import os
import tracemalloc

from layerstore import LayerStore

TOTAL = 512 * 1024 * 1024  # 512 MiB
CHUNK = 64 * 1024 * 1024  # 64 MiB per chunk, well under the 256 MiB cap
MEMORY_BUDGET = 32 * 1024 * 1024


class GeneratedStream:
    """Deterministic byte stream; never holds more than one block."""

    def __init__(self, seed: int, size: int):
        self._block = hashlib.sha256(b"seed:%d" % seed).digest() * (
            (1024 * 1024) // 32
        )
        self._pos = 0
        self._remaining = size

    def read(self, n: int = -1) -> bytes:
        if n < 0:
            n = self._remaining
        n = min(n, self._remaining, len(self._block) - self._pos)
        out = self._block[self._pos : self._pos + n]
        self._pos += n
        self._remaining -= n
        if self._pos == len(self._block) and self._remaining > 0:
            # chain to the next 1 MiB block: cheap and deterministic
            self._block = hashlib.sha256(self._block).digest() * (
                (1024 * 1024) // 32
            )
            self._pos = 0
        return out


class LimitedStream:
    """Exposes at most ``size`` bytes of an underlying stream."""

    def __init__(self, inner: GeneratedStream, size: int):
        self._inner = inner
        self._remaining = size

    def read(self, n: int = -1) -> bytes:
        if n < 0 or n > self._remaining:
            n = self._remaining
        block = self._inner.read(n)
        self._remaining -= len(block)
        return block


def digest_of(seed: int, size: int) -> str:
    hasher = hashlib.sha256()
    stream = GeneratedStream(seed, size)
    while True:
        block = stream.read(1024 * 1024)
        if not block:
            return hasher.hexdigest()
        hasher.update(block)


def test_512mib_streaming_upload_within_memory_budget(tmp_path):
    store = LayerStore(str(tmp_path / "store"))
    sid = store.create_session()
    expected_digest = digest_of(1, TOTAL)

    tracemalloc.start()
    try:
        source = GeneratedStream(1, TOTAL)
        offset = 0
        while offset < TOTAL:
            size = min(CHUNK, TOTAL - offset)
            confirmed = store.put_chunk(sid, offset, LimitedStream(source, size))
            assert confirmed == offset + size
            offset = confirmed
        # retry a range crossing chunk boundaries, forcing comparison
        retry = GeneratedStream(1, TOTAL)
        to_skip = CHUNK - 5
        while to_skip:
            to_skip -= len(retry.read(to_skip))
        assert store.put_chunk(
            sid, CHUNK - 5, LimitedStream(retry, CHUNK + 10)
        ) == TOTAL
        _, peak_upload = tracemalloc.get_traced_memory()

        path = store.complete(sid, expected_digest)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()

    assert peak < MEMORY_BUDGET, f"peak python memory {peak} bytes"
    assert peak_upload < MEMORY_BUDGET

    # final object equals the original input byte for byte
    hasher = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            block = fh.read(1024 * 1024)
            if not block:
                break
            hasher.update(block)
    assert hasher.hexdigest() == expected_digest
    assert os.path.getsize(path) == TOTAL
    store.close()
