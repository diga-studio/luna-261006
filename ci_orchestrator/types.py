"""Shared types for the in-process CI build orchestrator."""

from __future__ import annotations

import enum
from dataclasses import dataclass
from typing import Any, Callable, Dict, Tuple

PASS = "PASS"
BLOCK = "BLOCK"

STAGE_NAMES: Tuple[str, ...] = (
    "checkout",
    "resolve_deps",
    "security_scan",
    "license_check",
    "build",
    "store_artifact",
)

StageFn = Callable[[Dict[str, Any]], Tuple[str, Any]]


class AttemptStatus(enum.Enum):
    QUEUED = "QUEUED"
    RUNNING = "RUNNING"
    SUCCEEDED = "SUCCEEDED"
    BLOCKED = "BLOCKED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"
    SUPERSEDED = "SUPERSEDED"


TERMINAL_STATUSES = frozenset(
    {
        AttemptStatus.SUCCEEDED,
        AttemptStatus.BLOCKED,
        AttemptStatus.FAILED,
        AttemptStatus.CANCELLED,
        AttemptStatus.SUPERSEDED,
    }
)


@dataclass(frozen=True)
class StageRecord:
    """One accepted stage outcome, attributed to exactly one attempt."""

    stage: str
    verdict: str
    result: Any


@dataclass(frozen=True)
class BuildSnapshot:
    """Self-consistent view of a build's current attempt."""

    build_id: str
    attempt: int
    status: AttemptStatus
    stages: Tuple[StageRecord, ...]
    artifact: bytes | None
