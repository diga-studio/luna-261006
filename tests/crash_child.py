"""Child-process helper that simulates hard kills (os._exit) mid-operation.

Usage:
    crash_child.py init <root> <sid_file>
    crash_child.py append <root> <sid_file> <seed> <size> <crash_after>
    crash_child.py append_commit_crash <root> <sid_file> <seed> <size>
    crash_child.py complete <root> <sid_file> <digest> <stage>

<stage> is one of: none, during_hash, after_publish, after_commit.
"""

import hashlib
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from layerstore import LayerStore  # noqa: E402


def chunk_data(seed: int, size: int) -> bytes:
    out = bytearray()
    counter = 0
    while len(out) < size:
        out += hashlib.sha256(f"{seed}:{counter}".encode()).digest()
        counter += 1
    return bytes(out[:size])


class CrashStream:
    """Yields ``data`` but hard-exits once ``crash_after`` bytes are out."""

    def __init__(self, data: bytes, crash_after: int):
        self._data = data
        self._pos = 0
        self._crash_after = crash_after

    def read(self, n: int = -1) -> bytes:
        if 0 <= self._crash_after <= self._pos:
            os._exit(1)
        if n < 0:
            n = len(self._data) - self._pos
        block = self._data[self._pos : self._pos + n]
        self._pos += len(block)
        return block


def load_sid(sid_file: str) -> str:
    with open(sid_file) as fh:
        return fh.read().strip()


def main() -> None:
    cmd, root, sid_file = sys.argv[1], sys.argv[2], sys.argv[3]
    store = LayerStore(root)

    if cmd == "init":
        sid = store.create_session()
        with open(sid_file, "w") as fh:
            fh.write(sid)
        return

    sid = load_sid(sid_file)

    if cmd == "append":
        seed, size, crash_after = int(sys.argv[4]), int(sys.argv[5]), int(sys.argv[6])
        info = store.get_session(sid)
        store.put_chunk(sid, info.confirmed_bytes,
                        CrashStream(chunk_data(seed, size), crash_after))
    elif cmd == "append_commit_crash":
        seed, size = int(sys.argv[4]), int(sys.argv[5])
        # die inside the SQLite commit that confirms the appended bytes
        orig_commit = sqlite3.Connection.commit

        def dying_commit(self):
            if self is store._db:
                os._exit(1)
            return orig_commit(self)

        sqlite3.Connection.commit = dying_commit
        info = store.get_session(sid)
        store.put_chunk(sid, info.confirmed_bytes,
                        CrashStream(chunk_data(seed, size), -1))
    elif cmd == "complete":
        digest, stage = sys.argv[4], sys.argv[5]
        if stage == "during_hash":
            def dying_sha256(path, size):
                os._exit(1)

            LayerStore._sha256_of = staticmethod(dying_sha256)
        elif stage == "after_publish":
            orig_publish = LayerStore._publish

            def dying_publish(self, src, dst):
                orig_publish(self, src, dst)
                os._exit(1)

            LayerStore._publish = dying_publish
        elif stage == "after_commit":
            orig_unlink = os.unlink

            def dying_unlink(path, *args, **kwargs):
                if path.endswith(".part"):
                    os._exit(1)
                return orig_unlink(path, *args, **kwargs)

            os.unlink = dying_unlink
        elif stage != "none":
            raise SystemExit(f"unknown stage {stage}")
        store.complete(sid, digest)
    else:
        raise SystemExit(f"unknown command {cmd}")


if __name__ == "__main__":
    main()
