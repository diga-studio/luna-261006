"""UploadStore: resumable chunked upload of container image layers.

Layout under the storage root:
    meta.db                 SQLite session metadata
    tmp/<session>.part      confirmed bytes of unfinished sessions
    objects/sha256-<hex>    published objects (shared by digest)

Crash model: every confirmed state change is fsync'd / committed before
the operation returns. On open, recovery truncates temp files back to
the confirmed prefix, removes temp files of completed sessions, and
drops stale staging files, so queries always match the actual bytes.
"""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import BinaryIO, Union

from . import files
from .db import MetaDB
from .errors import (
    DigestMismatch,
    ObjectTooLarge,
    OffsetMismatch,
    SessionCompleted,
    SessionNotFound,
    StorageCorrupted,
)
from .faults import crash_point
from .types import SessionInfo

MAX_CHUNK_BYTES = 256 * 1024 * 1024  # 256 MiB
MAX_OBJECT_BYTES = 8 * 1024 * 1024 * 1024  # 8 GiB


class UploadStore:
    """Resumable chunked upload store rooted at a local directory.

    Calls against one store are executed serially; no concurrency.
    """

    def __init__(self, root: Union[str, Path]) -> None:
        self._root = Path(root).resolve()
        files.tmp_dir(self._root).mkdir(parents=True, exist_ok=True)
        files.objects_dir(self._root).mkdir(parents=True, exist_ok=True)
        self._db = MetaDB(self._root / "meta.db")
        self._recover()

    # ------------------------------------------------------------------
    # recovery
    # ------------------------------------------------------------------

    def _recover(self) -> None:
        known = set()
        for session_id, confirmed, status, _digest in self._db.all_sessions():
            known.add(session_id)
            tmp = files.tmp_path(self._root, session_id)
            if status == "completed":
                files.remove_if_exists(tmp)
                crash_point("recover_tmp_removed")
                continue
            if not tmp.exists():
                if confirmed > 0:
                    raise StorageCorrupted(
                        f"temp bytes missing for active session {session_id}"
                    )
                tmp.touch()
                continue
            size = tmp.stat().st_size
            if size < confirmed:
                raise StorageCorrupted(
                    f"temp file shorter than confirmed prefix for {session_id}"
                )
            if size > confirmed:
                # crashed mid-append: drop the unconfirmed tail
                files.truncate_file(tmp, confirmed)
                crash_point("recover_truncated")
        # orphan temp files whose session row never committed
        for path in files.tmp_dir(self._root).glob("*.part"):
            if path.stem not in known:
                files.remove_if_exists(path)
        # stale staging files from a crashed publish
        for path in files.objects_dir(self._root).glob(".staging-*"):
            files.remove_if_exists(path)

    # ------------------------------------------------------------------
    # helpers
    # ------------------------------------------------------------------

    def _row(self, session_id: str):
        row = self._db.get_session(session_id)
        if row is None:
            raise SessionNotFound(session_id)
        return row

    # ------------------------------------------------------------------
    # public API
    # ------------------------------------------------------------------

    def create_session(self) -> str:
        session_id = uuid.uuid4().hex
        self._db.create_session(session_id)
        files.tmp_path(self._root, session_id).touch()
        return session_id

    def get_session(self, session_id: str) -> SessionInfo:
        _sid, confirmed, status, digest = self._row(session_id)
        completed = status == "completed"
        return SessionInfo(
            session_id=session_id,
            confirmed_bytes=confirmed,
            completed=completed,
            object_path=files.object_path(self._root, digest) if completed else None,
        )

    def submit_chunk(self, session_id: str, offset: int, stream: BinaryIO) -> int:
        _sid, confirmed, status, _digest = self._row(session_id)
        if status == "completed":
            raise SessionCompleted(session_id)
        if offset < 0 or offset > confirmed:
            raise OffsetMismatch(
                f"offset {offset} does not match confirmed {confirmed}"
            )
        tmp = files.tmp_path(self._root, session_id)
        if offset < confirmed:
            # idempotent retry of an already-confirmed range
            files.prefix_matches(tmp, offset, stream, confirmed)
            return confirmed

        try:
            written = files.append_stream(tmp, stream, offset, MAX_CHUNK_BYTES)
        except Exception:
            # all-or-nothing: roll the file back to the confirmed prefix
            files.truncate_file(tmp, confirmed)
            raise
        if confirmed + written > MAX_OBJECT_BYTES:
            files.truncate_file(tmp, confirmed)
            raise ObjectTooLarge(
                f"object would exceed {MAX_OBJECT_BYTES} bytes"
            )
        if written:
            self._db.set_confirmed(session_id, confirmed + written)
            crash_point("chunk_committed")
        return confirmed + written

    def complete(self, session_id: str, sha256_hex: str) -> Path:
        expected = sha256_hex.strip().lower()
        if len(expected) != 64 or any(c not in "0123456789abcdef" for c in expected):
            raise ValueError(f"invalid SHA-256 hex digest: {sha256_hex!r}")
        _sid, confirmed, status, digest = self._row(session_id)
        if status == "completed":
            if digest == expected:
                return files.object_path(self._root, digest)
            raise DigestMismatch(
                "session already completed with a different digest"
            )
        tmp = files.tmp_path(self._root, session_id)
        if tmp.stat().st_size != confirmed:
            # defensive: never let unconfirmed tail bytes into an object
            files.truncate_file(tmp, confirmed)
        actual = files.hash_file_prefix(tmp, confirmed)
        crash_point("complete_verified")
        if actual != expected:
            raise DigestMismatch(
                f"expected {expected}, confirmed bytes hash to {actual}"
            )
        dest = files.object_path(self._root, expected)
        files.publish_object(tmp, dest, files.staging_path(self._root, session_id))
        crash_point("complete_linked")
        self._db.mark_completed(session_id, expected)
        crash_point("complete_committed")
        files.remove_if_exists(tmp)
        crash_point("complete_done")
        return dest

    def close(self) -> None:
        self._db.close()

    def __enter__(self) -> "UploadStore":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()
