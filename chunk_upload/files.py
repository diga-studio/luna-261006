"""File-level helpers: temp bytes, atomic publish, streaming hash/compare.

Everything streams in IO_BLOCK-sized pieces so peak extra memory stays
far below the 32 MiB budget regardless of object size.
"""

from __future__ import annotations

import hashlib
import os
import shutil
from pathlib import Path
from typing import BinaryIO

from .errors import ChunkTooLarge, ContentConflict
from .faults import crash_point

IO_BLOCK = 1024 * 1024  # 1 MiB streaming block size


def tmp_dir(root: Path) -> Path:
    return root / "tmp"


def objects_dir(root: Path) -> Path:
    return root / "objects"


def tmp_path(root: Path, session_id: str) -> Path:
    return tmp_dir(root) / f"{session_id}.part"


def object_path(root: Path, digest_hex: str) -> Path:
    return objects_dir(root) / f"sha256-{digest_hex}"


def staging_path(root: Path, session_id: str) -> Path:
    return objects_dir(root) / f".staging-{session_id}"


def _fsync_dir(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def append_stream(path: Path, stream: BinaryIO, offset: int, max_bytes: int) -> int:
    """Append stream bytes to `path` at `offset`; fsync before returning.

    Returns the number of bytes written. Raises ChunkTooLarge if the
    stream yields more than `max_bytes`; the caller must then truncate
    the file back, so the write is all-or-nothing.
    """
    written = 0
    first_block = True
    with open(path, "r+b") as f:
        f.seek(offset)
        while True:
            block = stream.read(IO_BLOCK)
            if not block:
                break
            written += len(block)
            if written > max_bytes:
                raise ChunkTooLarge(
                    f"chunk exceeds limit of {max_bytes} bytes"
                )
            f.write(block)
            if first_block:
                first_block = False
                crash_point("chunk_block_written")
        f.flush()
        os.fsync(f.fileno())
    crash_point("chunk_flushed")
    return written


def hash_file_prefix(path: Path, length: int) -> str:
    """SHA-256 hex digest of the first `length` bytes, computed streaming."""
    h = hashlib.sha256()
    remaining = length
    with open(path, "rb") as f:
        while remaining > 0:
            block = f.read(min(IO_BLOCK, remaining))
            if not block:
                break
            h.update(block)
            remaining -= len(block)
    return h.hexdigest()


def prefix_matches(path: Path, offset: int, stream: BinaryIO, confirmed: int) -> None:
    """Verify stream bytes equal the confirmed file region at `offset`.

    Raises ContentConflict if any byte differs or the stream extends
    beyond `confirmed` (partial overlap into unconfirmed territory).
    """
    pos = offset
    with open(path, "rb") as f:
        while True:
            block = stream.read(IO_BLOCK)
            if not block:
                return
            if pos + len(block) > confirmed:
                raise ContentConflict(
                    "retry range extends beyond confirmed prefix"
                )
            f.seek(pos)
            existing = f.read(len(block))
            if existing != block:
                raise ContentConflict("retry bytes differ from confirmed prefix")
            pos += len(block)


def publish_object(tmp: Path, dest: Path, staging: Path) -> None:
    """Atomically publish `tmp` as `dest`.

    Uses a hardlink so identical sessions share one object without
    copying; falls back to staged copy + atomic rename if linking is
    unavailable. Idempotent: an existing `dest` is left untouched.
    """
    if dest.exists():
        return
    try:
        os.link(tmp, dest)
    except OSError:
        if staging.exists():
            staging.unlink()
        with open(tmp, "rb") as src, open(staging, "wb") as dst:
            shutil.copyfileobj(src, dst, IO_BLOCK)
            dst.flush()
            os.fsync(dst.fileno())
        os.replace(staging, dest)
    _fsync_dir(dest.parent)


def truncate_file(path: Path, size: int) -> None:
    with open(path, "r+b") as f:
        f.truncate(size)
        f.flush()
        os.fsync(f.fileno())


def remove_if_exists(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        pass
