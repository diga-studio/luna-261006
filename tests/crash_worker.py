"""Subprocess worker for crash-injection tests.

Performs one scripted operation against a storage dir. When
CHUNK_UPLOAD_CRASH_AT names a fault point reached during the
operation, the process dies instantly (os._exit), simulating kill -9.

Usage: crash_worker.py <storage_dir> <sid_file> <op> [args]
  op=submit   <seed> <chunk_len> <total_len>   submit next chunk(s)
  op=complete <seed> <total_len>               complete with true digest
  op=open                                      open+close (runs recovery)
"""

import hashlib
import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from chunk_upload import UploadStore  # noqa: E402
from helpers import pattern_bytes  # noqa: E402


def get_or_create_session(store, sid_file):
    if sid_file.exists():
        return sid_file.read_text().strip()
    sid = store.create_session()
    sid_file.write_text(sid)
    return sid


def main() -> int:
    storage_dir = Path(sys.argv[1])
    sid_file = Path(sys.argv[2])
    op = sys.argv[3]

    if op == "open":
        store = UploadStore(storage_dir)
        store.close()
        return 0

    if op == "submit":
        seed, chunk_len, total = sys.argv[4], int(sys.argv[5]), int(sys.argv[6])
        store = UploadStore(storage_dir)
        sid = get_or_create_session(store, sid_file)
        confirmed = store.get_session(sid).confirmed_bytes
        if confirmed >= total:
            store.close()
            return 0
        end = min(confirmed + chunk_len, total)
        store.submit_chunk(sid, confirmed, io.BytesIO(pattern_bytes(seed, confirmed, end - confirmed)))
        store.close()
        return 0

    if op == "complete":
        seed, total = sys.argv[4], int(sys.argv[5])
        store = UploadStore(storage_dir)
        sid = get_or_create_session(store, sid_file)
        digest = hashlib.sha256(pattern_bytes(seed, 0, total)).hexdigest()
        store.complete(sid, digest)
        store.close()
        return 0

    raise SystemExit(f"unknown op {op}")


if __name__ == "__main__":
    sys.exit(main())
