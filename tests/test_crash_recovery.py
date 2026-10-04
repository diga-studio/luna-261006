"""Kill/restart tests: a child process is hard-killed (os._exit) in the
middle of chunk reception or completion, over and over. After every
restart the store must expose either the pre- or post-operation state,
confirmed bytes must never change, and the final object must match the
original input byte for byte.
"""

import hashlib
import os
import subprocess
import sys

import pytest

from layerstore import LayerStore

CHILD = os.path.join(os.path.dirname(__file__), "crash_child.py")
CHUNK_SIZE = 4 * 1024 * 1024 + 13  # spans several 1 MiB IO blocks


def chunk_data(seed: int, size: int) -> bytes:
    out = bytearray()
    counter = 0
    while len(out) < size:
        out += hashlib.sha256(f"{seed}:{counter}".encode()).digest()
        counter += 1
    return bytes(out[:size])


def run_child(*args) -> None:
    subprocess.run([sys.executable, CHILD, *args], check=False)


def read_prefix(path: str, size: int) -> bytes:
    with open(path, "rb") as fh:
        return fh.read(size)


def test_repeated_kills_during_append_and_complete(tmp_path):
    root = str(tmp_path / "store")
    sid_file = str(tmp_path / "sid")
    chunks = [chunk_data(i, CHUNK_SIZE) for i in range(4)]
    full = b"".join(chunks)
    digest = hashlib.sha256(full).hexdigest()

    run_child("init", root, sid_file)
    sid = open(sid_file).read().strip()

    confirmed = 0
    for i, chunk in enumerate(chunks):
        # killed mid-append (while reading the stream / writing blocks)
        run_child("append", root, sid_file, str(i), str(len(chunk)), "1500000")
        store = LayerStore(root)
        info = store.get_session(sid)
        # prefix must be exactly the pre- or post-operation state
        assert info.confirmed_bytes in (confirmed, confirmed + len(chunk))
        assert read_prefix(store._tmp_path(sid), info.confirmed_bytes) == full[: info.confirmed_bytes]
        if info.confirmed_bytes == confirmed:
            # killed before the commit that confirms the bytes
            store.close()
            run_child("append_commit_crash", root, sid_file, str(i), str(len(chunk)))
            store = LayerStore(root)
            info = store.get_session(sid)
            assert info.confirmed_bytes in (confirmed, confirmed + len(chunk))
            assert read_prefix(store._tmp_path(sid), info.confirmed_bytes) == full[: info.confirmed_bytes]
            if info.confirmed_bytes == confirmed:
                store.close()
                # clean retry must land the whole chunk
                run_child("append", root, sid_file, str(i), str(len(chunk)), "-1")
                store = LayerStore(root)
                info = store.get_session(sid)
                assert info.confirmed_bytes == confirmed + len(chunk)
        confirmed = info.confirmed_bytes
        store.close()
    assert confirmed == len(full)

    # killed at every stage of completion, then a clean complete
    for stage in ("during_hash", "after_publish", "after_commit"):
        run_child("complete", root, sid_file, digest, stage)
        store = LayerStore(root)
        info = store.get_session(sid)
        if not info.completed:
            # bytes must survive any number of killed completions
            assert info.confirmed_bytes == len(full)
        store.close()
    run_child("complete", root, sid_file, digest, "none")

    store = LayerStore(root)
    info = store.get_session(sid)
    assert info.completed and info.confirmed_bytes == len(full)
    assert read_prefix(info.object_path, len(full) + 1) == full
    store.close()


def test_killed_complete_shares_object_and_leaves_no_tmp(tmp_path):
    root = str(tmp_path / "store")
    sid_a_file = str(tmp_path / "sid_a")
    sid_b_file = str(tmp_path / "sid_b")
    data = chunk_data(99, CHUNK_SIZE)
    digest = hashlib.sha256(data).hexdigest()

    for sid_file in (sid_a_file, sid_b_file):
        run_child("init", root, sid_file)
        run_child("append", root, sid_file, "99", str(len(data)), "-1")
    sid_a = open(sid_a_file).read().strip()
    sid_b = open(sid_b_file).read().strip()

    # session A completes cleanly; session B is killed after the commit
    run_child("complete", root, sid_a_file, digest, "none")
    run_child("complete", root, sid_b_file, digest, "after_commit")

    store = LayerStore(root)
    info_a = store.get_session(sid_a)
    info_b = store.get_session(sid_b)
    assert info_a.completed and info_b.completed
    # both sessions resolve to the same readable object
    assert info_a.object_path == info_b.object_path
    assert read_prefix(info_a.object_path, len(data)) == data
    # no staging copies remain for completed sessions
    assert os.listdir(os.path.join(root, "tmp")) == []
    # completion of B is retryable and returns the same object
    assert store.complete(sid_b, digest) == info_a.object_path
    store.close()

    # and again after a full restart
    store = LayerStore(root)
    assert store.get_session(sid_b).object_path == info_a.object_path
    assert os.listdir(os.path.join(root, "tmp")) == []
    store.close()


def test_killed_after_publish_can_still_complete(tmp_path):
    root = str(tmp_path / "store")
    sid_file = str(tmp_path / "sid")
    data = chunk_data(7, CHUNK_SIZE)
    digest = hashlib.sha256(data).hexdigest()

    run_child("init", root, sid_file)
    run_child("append", root, sid_file, "7", str(len(data)), "-1")
    # killed after the object was published but before the DB commit
    run_child("complete", root, sid_file, digest, "after_publish")

    store = LayerStore(root)
    sid = open(sid_file).read().strip()
    info = store.get_session(sid)
    assert not info.completed  # commit never happened
    assert info.confirmed_bytes == len(data)
    # re-completing works and reuses the already-published object
    path = store.complete(sid, digest)
    assert read_prefix(path, len(data)) == data
    store.close()
