"""Basic semantics: sessions, chunks, retries, completion, dedup."""

import hashlib
import io

import pytest

from chunk_upload import (
    ChunkTooLarge,
    ContentConflict,
    DigestMismatch,
    OffsetMismatch,
    SessionCompleted,
    SessionNotFound,
    UploadStore,
)
from chunk_upload import store as store_mod

from helpers import pattern_bytes

SEED = "basic"


def test_create_and_query(tmp_path):
    with UploadStore(tmp_path) as s:
        sid = s.create_session()
        info = s.get_session(sid)
        assert info.confirmed_bytes == 0
        assert not info.completed
        assert info.object_path is None


def test_sessions_are_independent(tmp_path):
    with UploadStore(tmp_path) as s:
        a = s.create_session()
        b = s.create_session()
        s.submit_chunk(a, 0, io.BytesIO(b"aaa"))
        assert s.get_session(a).confirmed_bytes == 3
        assert s.get_session(b).confirmed_bytes == 0
        with pytest.raises(OffsetMismatch):
            s.submit_chunk(b, 3, io.BytesIO(b"x"))


def test_sequential_chunks_and_query(tmp_path):
    data = pattern_bytes(SEED, 0, 10_000)
    with UploadStore(tmp_path) as s:
        sid = s.create_session()
        for start in range(0, 10_000, 3_000):
            end = min(start + 3_000, 10_000)
            n = s.submit_chunk(sid, start, io.BytesIO(data[start:end]))
            assert n == end
        assert s.get_session(sid).confirmed_bytes == 10_000
        digest = hashlib.sha256(data).hexdigest()
        path = s.complete(sid, digest)
        assert path.read_bytes() == data


def test_retry_inside_prefix_across_chunk_boundaries(tmp_path):
    data = pattern_bytes(SEED, 0, 9_000)
    with UploadStore(tmp_path) as s:
        sid = s.create_session()
        s.submit_chunk(sid, 0, io.BytesIO(data[:4_000]))
        s.submit_chunk(sid, 4_000, io.BytesIO(data[4_000:]))
        # retry [1000, 8000): spans both original chunks, must not append
        n = s.submit_chunk(sid, 1_000, io.BytesIO(data[1_000:8_000]))
        assert n == 9_000
        assert s.get_session(sid).confirmed_bytes == 9_000


def test_retry_with_different_content_rejected(tmp_path):
    data = pattern_bytes(SEED, 0, 5_000)
    other = pattern_bytes("other", 0, 5_000)
    with UploadStore(tmp_path) as s:
        sid = s.create_session()
        s.submit_chunk(sid, 0, io.BytesIO(data))
        with pytest.raises(ContentConflict):
            s.submit_chunk(sid, 0, io.BytesIO(other))
        assert s.get_session(sid).confirmed_bytes == 5_000


def test_partial_overlap_into_new_region_rejected(tmp_path):
    data = pattern_bytes(SEED, 0, 8_000)
    with UploadStore(tmp_path) as s:
        sid = s.create_session()
        s.submit_chunk(sid, 0, io.BytesIO(data[:5_000]))
        # matches the prefix but extends past the confirmed end
        with pytest.raises(ContentConflict):
            s.submit_chunk(sid, 3_000, io.BytesIO(data[3_000:]))
        assert s.get_session(sid).confirmed_bytes == 5_000
        # session still usable afterwards
        n = s.submit_chunk(sid, 5_000, io.BytesIO(data[5_000:]))
        assert n == 8_000


def test_gap_offset_rejected(tmp_path):
    with UploadStore(tmp_path) as s:
        sid = s.create_session()
        s.submit_chunk(sid, 0, io.BytesIO(b"abc"))
        with pytest.raises(OffsetMismatch):
            s.submit_chunk(sid, 10, io.BytesIO(b"x"))
        assert s.get_session(sid).confirmed_bytes == 3


def test_wrong_digest_keeps_session_and_allows_correct_complete(tmp_path):
    data = pattern_bytes(SEED, 0, 4_000)
    wrong = hashlib.sha256(b"nope").hexdigest()
    with UploadStore(tmp_path) as s:
        sid = s.create_session()
        s.submit_chunk(sid, 0, io.BytesIO(data))
        with pytest.raises(DigestMismatch):
            s.complete(sid, wrong)
        info = s.get_session(sid)
        assert not info.completed and info.confirmed_bytes == 4_000
        # can still append and then complete correctly
        s.submit_chunk(sid, 4_000, io.BytesIO(data))
        good = hashlib.sha256(data + data).hexdigest()
        path = s.complete(sid, good)
        assert path.read_bytes() == data + data


def test_complete_is_idempotent_and_locks_digest(tmp_path):
    data = pattern_bytes(SEED, 0, 2_000)
    digest = hashlib.sha256(data).hexdigest()
    other = hashlib.sha256(b"other").hexdigest()
    with UploadStore(tmp_path) as s:
        sid = s.create_session()
        s.submit_chunk(sid, 0, io.BytesIO(data))
        p1 = s.complete(sid, digest)
        p2 = s.complete(sid, digest)
        assert p1 == p2
        with pytest.raises(DigestMismatch):
            s.complete(sid, other)
        with pytest.raises(SessionCompleted):
            s.submit_chunk(sid, 2_000, io.BytesIO(b"x"))
        assert s.get_session(sid).object_path == p1


def test_unknown_session(tmp_path):
    with UploadStore(tmp_path) as s:
        with pytest.raises(SessionNotFound):
            s.get_session("missing")
        with pytest.raises(SessionNotFound):
            s.submit_chunk("missing", 0, io.BytesIO(b"x"))
        with pytest.raises(SessionNotFound):
            s.complete("missing", "0" * 64)


def test_empty_chunk_at_tip_is_noop(tmp_path):
    with UploadStore(tmp_path) as s:
        sid = s.create_session()
        assert s.submit_chunk(sid, 0, io.BytesIO(b"")) == 0
        s.submit_chunk(sid, 0, io.BytesIO(b"ab"))
        assert s.submit_chunk(sid, 2, io.BytesIO(b"")) == 2


def test_chunk_size_limit(tmp_path, monkeypatch):
    monkeypatch.setattr(store_mod, "MAX_CHUNK_BYTES", 1_000)
    with UploadStore(tmp_path) as s:
        sid = s.create_session()
        with pytest.raises(ChunkTooLarge):
            s.submit_chunk(sid, 0, io.BytesIO(b"x" * 1_001))
        # nothing was confirmed
        assert s.get_session(sid).confirmed_bytes == 0
        n = s.submit_chunk(sid, 0, io.BytesIO(b"x" * 1_000))
        assert n == 1_000


def test_object_size_limit(tmp_path, monkeypatch):
    monkeypatch.setattr(store_mod, "MAX_OBJECT_BYTES", 1_500)
    from chunk_upload import ObjectTooLarge

    with UploadStore(tmp_path) as s:
        sid = s.create_session()
        s.submit_chunk(sid, 0, io.BytesIO(b"x" * 1_000))
        with pytest.raises(ObjectTooLarge):
            s.submit_chunk(sid, 1_000, io.BytesIO(b"x" * 1_000))
        assert s.get_session(sid).confirmed_bytes == 1_000


def test_two_sessions_same_content_share_one_object(tmp_path):
    data = pattern_bytes(SEED, 0, 6_000)
    digest = hashlib.sha256(data).hexdigest()
    with UploadStore(tmp_path) as s:
        s1, s2 = s.create_session(), s.create_session()
        s.submit_chunk(s1, 0, io.BytesIO(data))
        s.submit_chunk(s2, 0, io.BytesIO(data))
        p1 = s.complete(s1, digest)
        p2 = s.complete(s2, digest)
        assert p1 == p2
        assert p1.read_bytes() == data
        # no temp copies remain for completed sessions
        tmp_files = list((tmp_path / "tmp").glob("*.part"))
        assert tmp_files == []
        objects = list((tmp_path / "objects").glob("sha256-*"))
        assert len(objects) == 1


def test_reopen_preserves_active_session(tmp_path):
    data = pattern_bytes(SEED, 0, 7_000)
    s = UploadStore(tmp_path)
    sid = s.create_session()
    s.submit_chunk(sid, 0, io.BytesIO(data[:3_000]))
    s.close()
    with UploadStore(tmp_path) as s2:
        assert s2.get_session(sid).confirmed_bytes == 3_000
        s2.submit_chunk(sid, 3_000, io.BytesIO(data[3_000:]))
        digest = hashlib.sha256(data).hexdigest()
        assert s2.complete(sid, digest).read_bytes() == data
