"""Public data types."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Optional


@dataclass(frozen=True)
class SessionInfo:
    """Snapshot of an upload session."""

    session_id: str
    confirmed_bytes: int
    completed: bool
    object_path: Optional[Path]
