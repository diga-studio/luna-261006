import hashlib
import io
import os

import pytest

import layerstore.store as store_mod
from layerstore import LayerStore
from layerstore.errors import (
    ChunkTooLargeError,
    ContentMismatchError,
    DigestMismatchError,
    ObjectTooLargeError,
    OffsetMismatchError,
    PartialOverlapError,
    SessionCompletedError,
    SessionNotFoundError,
)


@pytest.fixture()
def store(tmp_path):
    s = LayerStore(str(tmp_path / "store"))
    yield s
    s.close()


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def test_basic_flow(store):
    sid = store.create_session()
    info = store.get_session(sid)
    assert info.confirmed_bytes == 0 and not info.completed

    assert store.put_chunk(sid, 0, io.BytesIO(b"hello ")) == 6
    assert store.put_chunk(sid, 6, io.BytesIO(b"world")) == 11

    path = store.complete(sid, sha256(b"hello world"))
    assert open(path, "rb").read() == b"hello world"
    info = store.get_session(sid)
    assert info.completed and info.object_path == path
    assert info.confirmed_bytes == 11
    assert info.digest == sha256(b"hello world")


def test_sessions_are_independent(store):
    a = store.create_session()
    b = store.create_session()
    store.put_chunk(a, 0, io.BytesIO(b"aaa"))
    store.put_chunk(b, 0, io.BytesIO(b"bb"))
    assert store.get_session(a).confirmed_bytes == 3
    assert store.get_session(b).confirmed_bytes == 2
    assert store.complete(a, sha256(b"aaa")) != store.complete(b, sha256(b"bb"))


def test_retry_inside_prefix_crossing_chunk_boundaries(store):
    sid = store.create_session()
    store.put_chunk(sid, 0, io.BytesIO(b"AAAA"))
    store.put_chunk(sid, 4, io.BytesIO(b"BBBB"))
    store.put_chunk(sid, 8, io.BytesIO(b"CCCC"))
    # retry range crosses the boundaries of the original chunks
    assert store.put_chunk(sid, 2, io.BytesIO(b"AABBBBCC")) == 12
    # retry shorter than the confirmed prefix
    assert store.put_chunk(sid, 0, io.BytesIO(b"AA")) == 12
    # empty retry at offset 0
    assert store.put_chunk(sid, 0, io.BytesIO(b"")) == 12
    assert store.get_session(sid).confirmed_bytes == 12
    assert store.complete(sid, sha256(b"AAAABBBBCCCC"))


def test_conflicting_retry_does_not_change_state(store):
    sid = store.create_session()
    store.put_chunk(sid, 0, io.BytesIO(b"AAAA"))
    with pytest.raises(ContentMismatchError):
        store.put_chunk(sid, 1, io.BytesIO(b"XAA"))
    assert store.get_session(sid).confirmed_bytes == 4
    assert store.complete(sid, sha256(b"AAAA"))


def test_partial_overlap_rejected(store):
    sid = store.create_session()
    store.put_chunk(sid, 0, io.BytesIO(b"AAAA"))
    # covers the prefix but extends past the confirmed end
    with pytest.raises(PartialOverlapError):
        store.put_chunk(sid, 2, io.BytesIO(b"AABBBB"))
    assert store.get_session(sid).confirmed_bytes == 4


def test_gap_rejected(store):
    sid = store.create_session()
    store.put_chunk(sid, 0, io.BytesIO(b"AAAA"))
    with pytest.raises(OffsetMismatchError):
        store.put_chunk(sid, 5, io.BytesIO(b"B"))
    with pytest.raises(OffsetMismatchError):
        store.put_chunk(sid, -1, io.BytesIO(b"B"))
    assert store.get_session(sid).confirmed_bytes == 4


def test_wrong_digest_then_correct_complete(store):
    sid = store.create_session()
    store.put_chunk(sid, 0, io.BytesIO(b"data"))
    with pytest.raises(DigestMismatchError):
        store.complete(sid, sha256(b"other"))
    # session untouched: can still append and complete
    assert store.put_chunk(sid, 4, io.BytesIO(b"!")) == 5
    path = store.complete(sid, sha256(b"data!"))
    assert open(path, "rb").read() == b"data!"


def test_completed_session_is_immutable(store):
    sid = store.create_session()
    store.put_chunk(sid, 0, io.BytesIO(b"data"))
    path = store.complete(sid, sha256(b"data"))
    # same digest again: same object
    assert store.complete(sid, sha256(b"data")) == path
    # different digest: rejected, no change
    with pytest.raises(DigestMismatchError):
        store.complete(sid, sha256(b"other"))
    # no appends after completion
    with pytest.raises(SessionCompletedError):
        store.put_chunk(sid, 4, io.BytesIO(b"x"))
    assert store.get_session(sid).object_path == path


def test_same_content_shares_one_object(store, tmp_path):
    a = store.create_session()
    b = store.create_session()
    store.put_chunk(a, 0, io.BytesIO(b"same"))
    store.put_chunk(b, 0, io.BytesIO(b"sa"))
    store.put_chunk(b, 2, io.BytesIO(b"me"))
    pa = store.complete(a, sha256(b"same"))
    pb = store.complete(b, sha256(b"same"))
    assert pa == pb
    objects = os.listdir(tmp_path / "store" / "objects" / "sha256")
    assert objects == [sha256(b"same")]


def test_reopen_keeps_state_and_drops_completed_tmp(store, tmp_path):
    root = tmp_path / "store"
    active = store.create_session()
    done = store.create_session()
    store.put_chunk(active, 0, io.BytesIO(b"pending"))
    store.put_chunk(done, 0, io.BytesIO(b"finished"))
    path = store.complete(done, sha256(b"finished"))
    store.close()

    reopened = LayerStore(str(root))
    try:
        assert reopened.get_session(active).confirmed_bytes == 7
        info = reopened.get_session(done)
        assert info.completed and info.object_path == path
        assert open(path, "rb").read() == b"finished"
        tmp_dir = root / "tmp"
        assert os.listdir(tmp_dir) == [active + ".part"]
        # active session can resume after reopen
        assert reopened.put_chunk(active, 7, io.BytesIO(b"!")) == 8
        assert reopened.complete(active, sha256(b"pending!"))
    finally:
        reopened.close()


def test_object_contains_no_unconfirmed_bytes(store, tmp_path):
    sid = store.create_session()
    store.put_chunk(sid, 0, io.BytesIO(b"confirmed"))
    store.close()
    # simulate a crashed append that left junk beyond the confirmed prefix
    tmp_file = tmp_path / "store" / "tmp" / (sid + ".part")
    with open(tmp_file, "ab") as fh:
        fh.write(b"JUNK-NEVER-CONFIRMED")
    reopened = LayerStore(str(tmp_path / "store"))
    try:
        assert reopened.get_session(sid).confirmed_bytes == 9
        path = reopened.complete(sid, sha256(b"confirmed"))
        assert open(path, "rb").read() == b"confirmed"
    finally:
        reopened.close()


def test_unknown_session(store):
    with pytest.raises(SessionNotFoundError):
        store.get_session("nope")
    with pytest.raises(SessionNotFoundError):
        store.put_chunk("nope", 0, io.BytesIO(b"x"))
    with pytest.raises(SessionNotFoundError):
        store.complete("nope", "0" * 64)


def test_chunk_size_limit(store, monkeypatch):
    monkeypatch.setattr(store_mod, "MAX_CHUNK_BYTES", 10)
    sid = store.create_session()
    with pytest.raises(ChunkTooLargeError):
        store.put_chunk(sid, 0, io.BytesIO(b"x" * 11))
    # failed chunk left nothing behind
    assert store.get_session(sid).confirmed_bytes == 0
    assert store.put_chunk(sid, 0, io.BytesIO(b"x" * 10)) == 10


def test_object_size_limit(store, monkeypatch):
    monkeypatch.setattr(store_mod, "MAX_OBJECT_BYTES", 12)
    sid = store.create_session()
    store.put_chunk(sid, 0, io.BytesIO(b"x" * 10))
    with pytest.raises(ObjectTooLargeError):
        store.put_chunk(sid, 10, io.BytesIO(b"y" * 3))
    assert store.get_session(sid).confirmed_bytes == 10


def test_stream_with_short_reads(store):
    class TricklyStream:
        def __init__(self, data):
            self._data = data
            self._pos = 0

        def read(self, n=-1):
            if self._pos >= len(self._data):
                return b""
            n = 3 if n < 0 else min(n, 3)  # never return more than 3 bytes
            block = self._data[self._pos : self._pos + n]
            self._pos += len(block)
            return block

    sid = store.create_session()
    payload = b"trickly-stream-payload"
    assert store.put_chunk(sid, 0, TricklyStream(payload)) == len(payload)
    # retry verification also tolerates short reads
    assert store.put_chunk(sid, 0, TricklyStream(payload)) == len(payload)
    assert store.complete(sid, sha256(payload))
