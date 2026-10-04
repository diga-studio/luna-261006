"""Crash-injection hooks used only by tests.

Set env CHUNK_UPLOAD_CRASH_AT to a comma-separated list of point names;
when a named point is reached the process exits immediately (like kill -9).
"""

from __future__ import annotations

import os


def crash_point(name: str) -> None:
    points = os.environ.get("CHUNK_UPLOAD_CRASH_AT", "")
    if points and name in points.split(","):
        os._exit(3)
