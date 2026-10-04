"""In-process CI build orchestration library."""

from .executor import StageCrashed
from .orchestrator import Orchestrator
from .types import (
    STAGE_NAMES,
    AttemptState,
    BuildSnapshot,
    StageFn,
    StageOutcome,
    StageRecord,
)

__all__ = [
    "STAGE_NAMES",
    "AttemptState",
    "BuildSnapshot",
    "Orchestrator",
    "StageCrashed",
    "StageFn",
    "StageOutcome",
    "StageRecord",
]
