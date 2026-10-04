"""Type definitions for the in-process CI build orchestrator."""

from __future__ import annotations

import enum
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional, Tuple


STAGE_NAMES: Tuple[str, ...] = (
    "checkout",
    "resolve_deps",
    "security_scan",
    "license_check",
    "build",
    "store",
)

# A stage function receives the results of previously passed stages of the
# same attempt (mapping stage name -> result payload) and returns
# ("PASS", result) or ("BLOCK", result). Must be picklable.
StageFn = Callable[[Dict[str, Any]], Tuple[str, Any]]


class StageOutcome(enum.Enum):
    PASS = "PASS"
    BLOCK = "BLOCK"


class AttemptState(enum.Enum):
    QUEUED = "QUEUED"
    RUNNING = "RUNNING"
    SUCCEEDED = "SUCCEEDED"
    BLOCKED = "BLOCKED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"
    SUPERSEDED = "SUPERSEDED"

    @property
    def terminal(self) -> bool:
        return self in _TERMINAL_STATES


_TERMINAL_STATES = frozenset(
    {
        AttemptState.SUCCEEDED,
        AttemptState.BLOCKED,
        AttemptState.FAILED,
        AttemptState.CANCELLED,
        AttemptState.SUPERSEDED,
    }
)


@dataclass(frozen=True)
class StageRecord:
    """A recorded, admitted result of one stage of one attempt."""

    stage: str
    outcome: StageOutcome
    result: Any


@dataclass(frozen=True)
class BuildSnapshot:
    """Self-consistent point-in-time view of a build."""

    build_id: str
    attempt: str
    state: AttemptState
    stage_records: Tuple[StageRecord, ...]
    artifact: Optional[bytes]
    error: Optional[str] = None
