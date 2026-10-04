"""Crash-injection tests: kill the process mid-operation, reopen, verify.

A subprocess worker performs one operation per run; CHUNK_UPLOAD_CRASH_AT
makes it die at a chosen fault point. After every crash the store is
reopened and must show either the pre- or post-operation state, with
all previously confirmed bytes intact.
"""

import hashlib
import os
import subprocess
import sys
from pathlib import Path

import pytest

from chunk_upload import UploadStore

sys.path.insert(0, str(Path(__file__).resolve().parent))
from helpers import pattern_bytes  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
WORKER = Path(__file__).resolve().parent / "crash_worker.py"
SEED = "crash"


def run_worker(storage, sid_file, op, *args, crash_at=None):
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join(
        [str(ROOT / "tests"), str(ROOT), env.get("PYTHONPATH", "")]
    )
    env.pop("CHUNK_UPLOAD_CRASH_AT", None)
    if crash_at:
        env["CHUNK_UPLOAD_CRASH_AT"] = crash_at
    return subprocess.run(
        [sys.executable, str(WORKER), str(storage), str(sid_file), op]
        + [str(a) for a in args],
        env=env,
        capture_output=True,
        text=True,
    )


def check_consistent(storage, sid, seed, allowed_confirmed, total):
    """Session state must be one of the allowed prefixes, bytes intact."""
    with UploadStore(storage) as s:
        info = s.get_session(sid)
        assert info.confirmed_bytes in allowed_confirmed, info
        tmp = storage / "tmp" / f"{sid}.part"
        if not info.completed:
            assert tmp.exists()
            assert tmp.stat().st_size == info.confirmed_bytes
            pos = 0
            with open(tmp, "rb") as f:
                while True:
                    blk = f.read(1 << 20)
                    if not blk:
                        break
                    assert blk == pattern_bytes(seed, pos, len(blk))
                    pos += len(blk)
            assert pos == info.confirmed_bytes
        else:
            # recovery must have removed temp bytes of completed sessions
            assert not tmp.exists()
            expected = hashlib.sha256(pattern_bytes(seed, 0, total)).hexdigest()
            assert info.object_path is not None
            assert info.object_path.name == f"sha256-{expected}"
            assert info.object_path.read_bytes() == pattern_bytes(seed, 0, total)
        return info


SUBMIT_POINTS = ["chunk_block_written", "chunk_flushed", "chunk_committed"]


@pytest.mark.parametrize("point", SUBMIT_POINTS)
def test_crash_during_submit_repeated_restarts(tmp_path, point):
    storage = tmp_path / "store"
    sid_file = tmp_path / "sid"
    chunk_len = (1 << 20) + 123  # crosses the 1 MiB IO block boundary
    n_chunks = 3
    total = chunk_len * n_chunks
    boundaries = [chunk_len * i for i in range(n_chunks + 1)]

    # crash twice at this point, verifying invariants after each kill
    for _ in range(2):
        r = run_worker(storage, sid_file, "submit", SEED, chunk_len, total,
                       crash_at=point)
        assert r.returncode == 3, r.stderr
        sid = sid_file.read_text().strip()
        check_consistent(storage, sid, SEED, boundaries, total)

    # finish without crashing
    for _ in range(n_chunks + 1):
        r = run_worker(storage, sid_file, "submit", SEED, chunk_len, total)
        assert r.returncode == 0, r.stderr
        sid = sid_file.read_text().strip()
        info = check_consistent(storage, sid, SEED, boundaries, total)
        if info.confirmed_bytes == total:
            break
    assert info.confirmed_bytes == total

    # final object must equal the original input byte for byte
    digest = hashlib.sha256(pattern_bytes(SEED, 0, total)).hexdigest()
    with UploadStore(storage) as s:
        path = s.complete(sid, digest)
        assert path.read_bytes() == pattern_bytes(SEED, 0, total)


COMPLETE_POINTS = [
    "complete_verified",
    "complete_linked",
    "complete_committed",
    "complete_done",
]


@pytest.mark.parametrize("point", COMPLETE_POINTS)
def test_crash_during_complete_repeated_restarts(tmp_path, point):
    storage = tmp_path / "store"
    sid_file = tmp_path / "sid"
    total = (1 << 20) + 777
    digest = hashlib.sha256(pattern_bytes(SEED, 0, total)).hexdigest()

    r = run_worker(storage, sid_file, "submit", SEED, total, total)
    assert r.returncode == 0, r.stderr
    sid = sid_file.read_text().strip()

    # crash at this point, then keep rerunning until a clean exit;
    # after every run the state must be pre- or post-complete
    crashed = False
    for _ in range(3):
        r = run_worker(storage, sid_file, "complete", SEED, total,
                       crash_at=point)
        crashed = crashed or r.returncode == 3
        assert r.returncode in (0, 3), r.stderr
        check_consistent(storage, sid, SEED, [total], total)
        if r.returncode == 0:
            break
    assert crashed

    # completing again must succeed and publish the exact bytes
    with UploadStore(storage) as s:
        path = s.complete(sid, digest)
        assert path.read_bytes() == pattern_bytes(SEED, 0, total)
        assert s.complete(sid, digest) == path  # idempotent
    check_consistent(storage, sid, SEED, [total], total)


def test_crash_during_recovery_truncate(tmp_path):
    storage = tmp_path / "store"
    sid_file = tmp_path / "sid"
    chunk_len = (1 << 20) + 55
    for _ in range(3):
        # leave an unconfirmed tail on disk
        r = run_worker(storage, sid_file, "submit", SEED, chunk_len,
                       chunk_len * 2, crash_at="chunk_flushed")
        assert r.returncode == 3, r.stderr
        # die in the middle of recovery itself
        r = run_worker(storage, sid_file, "open",
                       crash_at="recover_truncated")
        assert r.returncode == 3, r.stderr
        # a clean reopen must finish recovery without manual repair
        r = run_worker(storage, sid_file, "open")
        assert r.returncode == 0, r.stderr
        sid = sid_file.read_text().strip()
        check_consistent(storage, sid, SEED, [0], chunk_len * 2)


def test_crash_during_recovery_tmp_removal(tmp_path):
    storage = tmp_path / "store"
    sid_file = tmp_path / "sid"
    total = 500_000
    r = run_worker(storage, sid_file, "submit", SEED, total, total)
    assert r.returncode == 0, r.stderr
    sid = sid_file.read_text().strip()
    # completed in DB, temp file not yet removed
    r = run_worker(storage, sid_file, "complete", SEED, total,
                   crash_at="complete_committed")
    assert r.returncode == 3, r.stderr
    # die while recovery removes the leftover temp file
    r = run_worker(storage, sid_file, "open", crash_at="recover_tmp_removed")
    assert r.returncode == 3, r.stderr
    r = run_worker(storage, sid_file, "open")
    assert r.returncode == 0, r.stderr
    info = check_consistent(storage, sid, SEED, [total], total)
    assert info.completed


def test_dedup_with_crash_during_complete(tmp_path):
    storage = tmp_path / "store"
    total = 800_000
    data = pattern_bytes(SEED, 0, total)
    digest = hashlib.sha256(data).hexdigest()

    with UploadStore(storage) as s:
        sid_a = s.create_session()
        sid_b = s.create_session()
        s.submit_chunk(sid_a, 0, __import__("io").BytesIO(data))
        s.submit_chunk(sid_b, 0, __import__("io").BytesIO(data))

    # session A dies right after the object is linked, before DB commit
    (tmp_path / "sid_a").write_text(sid_a)
    r = run_worker(storage, tmp_path / "sid_a", "complete", SEED, total,
                   crash_at="complete_linked")
    assert r.returncode == 3, r.stderr

    # recover, then finish both sessions
    with UploadStore(storage) as s:
        info = s.get_session(sid_a)
        assert not info.completed and info.confirmed_bytes == total
        pa = s.complete(sid_a, digest)
        pb = s.complete(sid_b, digest)
        assert pa == pb
        assert pa.read_bytes() == data
        assert s.get_session(sid_a).object_path == pa
        assert s.get_session(sid_b).object_path == pa

    # after reopen: both completed, no temp copies, single shared object
    with UploadStore(storage) as s:
        assert s.get_session(sid_a).completed
        assert s.get_session(sid_b).completed
        assert list((storage / "tmp").glob("*.part")) == []
        objects = list((storage / "objects").glob("sha256-*"))
        assert len(objects) == 1
        assert objects[0].read_bytes() == data
