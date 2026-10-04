"""Resumable chunked upload store backed by local files and SQLite."""

from __future__ import annotations

import hashlib
import os
import sqlite3
import uuid
from dataclasses import dataclass
from typing import BinaryIO, Optional

from .errors import (
    ChunkTooLargeError,
    ContentMismatchError,
    DigestMismatchError,
    ObjectTooLargeError,
    OffsetMismatchError,
    PartialOverlapError,
    SessionCompletedError,
    SessionNotFoundError,
    StoreCorruptError,
)

MAX_CHUNK_BYTES = 256 * 1024 * 1024  # 256 MiB per chunk
MAX_OBJECT_BYTES = 8 * 1024 * 1024 * 1024  # 8 GiB per object
IO_BLOCK_BYTES = 1024 * 1024  # 1 MiB streaming block

_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    confirmed_bytes INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'completed')),
    digest TEXT
);
"""


@dataclass(frozen=True)
class SessionInfo:
    """Snapshot of an upload session."""

    session_id: str
    confirmed_bytes: int
    completed: bool
    digest: Optional[str]
    object_path: Optional[str]


class LayerStore:
    """Manages resumable chunked uploads rooted at a local directory.

    Layout under ``root``::

        meta.sqlite3                 session metadata
        tmp/<session-id>.part        staging bytes for active sessions
        objects/sha256/<hexdigest>   published objects (content addressed)
    """

    def __init__(self, root: str) -> None:
        self._root = os.path.abspath(root)
        self._tmp_dir = os.path.join(self._root, "tmp")
        self._objects_dir = os.path.join(self._root, "objects", "sha256")
        os.makedirs(self._tmp_dir, exist_ok=True)
        os.makedirs(self._objects_dir, exist_ok=True)
        self._db = sqlite3.connect(os.path.join(self._root, "meta.sqlite3"))
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA synchronous=FULL")
        self._db.executescript(_SCHEMA)
        self._db.commit()
        self._recover()

    def close(self) -> None:
        self._db.close()

    def __enter__(self) -> "LayerStore":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # -- paths ---------------------------------------------------------

    def _tmp_path(self, session_id: str) -> str:
        return os.path.join(self._tmp_dir, session_id + ".part")

    def _object_path(self, digest: str) -> str:
        return os.path.join(self._objects_dir, digest)

    # -- recovery ------------------------------------------------------

    def _recover(self) -> None:
        """Reconcile on-disk state after a possible hard kill.

        - active session: truncate staging file to the confirmed prefix
          recorded in SQLite (a crashed append may have left extra bytes).
        - completed session: ensure the object is published and drop any
          leftover staging file.
        """
        rows = self._db.execute(
            "SELECT id, confirmed_bytes, state, digest FROM sessions"
        ).fetchall()
        for session_id, confirmed, state, digest in rows:
            tmp = self._tmp_path(session_id)
            if state == "active":
                if not os.path.exists(tmp):
                    if confirmed != 0:
                        raise StoreCorruptError(
                            f"staging file missing for active session {session_id}"
                        )
                    open(tmp, "wb").close()
                else:
                    with open(tmp, "r+b") as fh:
                        fh.truncate(confirmed)
            else:
                obj = self._object_path(digest)
                if not os.path.exists(obj):
                    if os.path.exists(tmp):
                        self._publish(tmp, obj)
                    else:
                        raise StoreCorruptError(
                            f"object missing for completed session {session_id}"
                        )
                if os.path.exists(tmp):
                    os.unlink(tmp)
        # Drop staging files with no session row (crash between file
        # creation and row insert).
        known = {row[0] + ".part" for row in rows}
        for name in os.listdir(self._tmp_dir):
            if name not in known:
                os.unlink(os.path.join(self._tmp_dir, name))

    @staticmethod
    def _publish(src: str, dst: str) -> None:
        """Atomically make ``src`` visible at ``dst`` (idempotent)."""
        if not os.path.exists(dst):
            os.link(src, dst)
        dir_fd = os.open(os.path.dirname(dst), os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)

    # -- session operations --------------------------------------------

    def create_session(self) -> str:
        """Create a new upload session and return its id."""
        session_id = uuid.uuid4().hex
        # Create the staging file first; recovery removes orphans if we
        # die before the row is committed.
        open(self._tmp_path(session_id), "wb").close()
        self._db.execute(
            "INSERT INTO sessions (id, confirmed_bytes, state, digest)"
            " VALUES (?, 0, 'active', NULL)",
            (session_id,),
        )
        self._db.commit()
        return session_id

    def _get_row(self, session_id: str) -> tuple:
        row = self._db.execute(
            "SELECT confirmed_bytes, state, digest FROM sessions WHERE id = ?",
            (session_id,),
        ).fetchone()
        if row is None:
            raise SessionNotFoundError(session_id)
        return row

    def get_session(self, session_id: str) -> SessionInfo:
        """Return the current state of a session."""
        confirmed, state, digest = self._get_row(session_id)
        completed = state == "completed"
        return SessionInfo(
            session_id=session_id,
            confirmed_bytes=confirmed,
            completed=completed,
            digest=digest if completed else None,
            object_path=self._object_path(digest) if completed else None,
        )

    @staticmethod
    def _read_up_to(stream: BinaryIO, size: int) -> bytes:
        """Read up to ``size`` bytes, looping over short reads."""
        chunks = []
        remaining = size
        while remaining > 0:
            block = stream.read(remaining)
            if not block:
                break
            chunks.append(block)
            remaining -= len(block)
        return b"".join(chunks)

    def put_chunk(self, session_id: str, offset: int, stream: BinaryIO) -> int:
        """Accept or deduplicate a chunk; return confirmed byte count.

        - ``offset == confirmed``: append the whole stream atomically.
        - range fully inside the confirmed prefix: verify bytes match and
          return without appending.
        - anything else (gap, partial overlap, differing bytes, oversized
          chunk/object) raises and leaves the session unchanged.
        """
        confirmed, state, _ = self._get_row(session_id)
        if state != "active":
            raise SessionCompletedError(session_id)
        if offset < 0 or offset > confirmed:
            raise OffsetMismatchError(
                f"offset {offset}, confirmed {confirmed}"
            )
        tmp = self._tmp_path(session_id)
        with open(tmp, "r+b") as fh:
            if offset < confirmed:
                return self._verify_prefix(fh, stream, offset, confirmed)
            new_bytes = self._append(fh, stream, confirmed, tmp)
        if new_bytes:
            self._db.execute(
                "UPDATE sessions SET confirmed_bytes = ? WHERE id = ?",
                (confirmed + new_bytes, session_id),
            )
            self._db.commit()
        return confirmed + new_bytes

    def _verify_prefix(
        self, fh: BinaryIO, stream: BinaryIO, offset: int, confirmed: int
    ) -> int:
        """Check a retry fully inside the confirmed prefix; never writes."""
        pos = offset
        total = 0
        while pos < confirmed:
            block = self._read_up_to(
                stream, min(IO_BLOCK_BYTES, confirmed - pos)
            )
            if not block:
                return confirmed  # stream ended inside the prefix: ok
            total += len(block)
            if total > MAX_CHUNK_BYTES:
                raise ChunkTooLargeError()
            fh.seek(pos)
            if fh.read(len(block)) != block:
                raise ContentMismatchError(
                    f"retry differs at offset {pos}"
                )
            pos += len(block)
        if stream.read(1):
            raise PartialOverlapError(
                f"chunk covers prefix and extends past {confirmed}"
            )
        return confirmed

    def _append(
        self, fh: BinaryIO, stream: BinaryIO, confirmed: int, tmp: str
    ) -> int:
        """Append the whole stream at ``confirmed``; all or nothing."""
        fh.seek(confirmed)
        new_bytes = 0
        try:
            while True:
                block = stream.read(IO_BLOCK_BYTES)
                if not block:
                    break
                new_bytes += len(block)
                if new_bytes > MAX_CHUNK_BYTES:
                    raise ChunkTooLargeError()
                if confirmed + new_bytes > MAX_OBJECT_BYTES:
                    raise ObjectTooLargeError()
                fh.write(block)
            fh.flush()
            os.fsync(fh.fileno())
        except BaseException:
            # Roll the staging file back to the confirmed prefix so the
            # session is untouched even if we keep running.
            fh.truncate(confirmed)
            fh.flush()
            os.fsync(fh.fileno())
            raise
        return new_bytes

    def complete(self, session_id: str, sha256_hex: str) -> str:
        """Verify digest and publish the object; return its path.

        On digest mismatch the session is untouched and may keep
        uploading. A completed session returns the same object for the
        same digest and rejects any other digest without changing state.
        """
        expected = sha256_hex.lower()
        confirmed, state, digest = self._get_row(session_id)
        if state == "completed":
            if digest == expected:
                return self._object_path(digest)
            raise DigestMismatchError(
                f"session already completed with digest {digest}"
            )
        tmp = self._tmp_path(session_id)
        actual = self._sha256_of(tmp, confirmed)
        if actual != expected:
            raise DigestMismatchError(
                f"expected {expected}, actual {actual}"
            )
        obj = self._object_path(actual)
        # 1. make the object visible (idempotent, survives a crash here)
        self._publish(tmp, obj)
        # 2. record completion
        self._db.execute(
            "UPDATE sessions SET state = 'completed', digest = ? WHERE id = ?",
            (actual, session_id),
        )
        self._db.commit()
        # 3. drop staging bytes; recovery finishes this if we die first
        os.unlink(tmp)
        return obj

    @staticmethod
    def _sha256_of(path: str, size: int) -> str:
        hasher = hashlib.sha256()
        remaining = size
        with open(path, "rb") as fh:
            while remaining > 0:
                block = fh.read(min(IO_BLOCK_BYTES, remaining))
                if not block:
                    raise StoreCorruptError(f"short read on {path}")
                hasher.update(block)
                remaining -= len(block)
        return hasher.hexdigest()
