"""Streaming test: >=512 MiB object uploaded in chunks, memory bounded.

Peak RSS growth during upload + hash verification must stay under the
32 MiB budget (the library streams in 1 MiB blocks). Content is a
deterministic pattern so expected bytes are regenerated, never stored.
"""

import hashlib
import resource
import sys
from pathlib import Path

from chunk_upload import UploadStore

sys.path.insert(0, str(Path(__file__).resolve().parent))
from helpers import PatternStream, pattern_bytes  # noqa: E402

SEED = "streaming"
TOTAL = 512 * 1024 * 1024  # 512 MiB
CHUNK = 64 * 1024 * 1024  # 64 MiB per chunk
MEM_BUDGET = 32 * 1024 * 1024  # 32 MiB


def _rss() -> int:
    usage = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    # bytes on macOS, KiB on Linux
    return usage if sys.platform == "darwin" else usage * 1024


def _expected_digest(seed: str, total: int) -> str:
    h = hashlib.sha256()
    pos = 0
    while pos < total:
        take = min(1 << 20, total - pos)
        h.update(pattern_bytes(seed, pos, take))
        pos += take
    return h.hexdigest()


def test_streaming_upload_memory_bounded(tmp_path):
    with UploadStore(tmp_path) as s:
        # warm-up: let the interpreter settle allocator arenas
        warm = s.create_session()
        s.submit_chunk(warm, 0, PatternStream("warm", 4 << 20))
        s.complete(warm, _expected_digest("warm", 4 << 20))

        sid = s.create_session()
        baseline = _rss()
        pos = 0
        while pos < TOTAL:
            pos = s.submit_chunk(sid, pos, PatternStream(SEED, CHUNK, start=pos))
        assert pos == TOTAL
        path = s.complete(sid, _expected_digest(SEED, TOTAL))
        growth = _rss() - baseline
        assert growth < MEM_BUDGET, f"RSS grew by {growth / 2**20:.1f} MiB"

        assert s.get_session(sid).confirmed_bytes == TOTAL
        assert path.stat().st_size == TOTAL
        # stream-compare the published object against the source pattern
        pos = 0
        with open(path, "rb") as f:
            while True:
                blk = f.read(1 << 20)
                if not blk:
                    break
                assert blk == pattern_bytes(SEED, pos, len(blk))
                pos += len(blk)
        assert pos == TOTAL
