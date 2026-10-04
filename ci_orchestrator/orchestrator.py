"""In-process CI build orchestrator with cancel/rerun safety."""

from __future__ import annotations

import threading
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from .executor import StageCrashed, run_stage
from .types import (
    STAGE_NAMES,
    AttemptState,
    BuildSnapshot,
    StageFn,
    StageOutcome,
    StageRecord,
)


@dataclass
class _Attempt:
    token: str
    state: AttemptState = AttemptState.QUEUED
    records: List[StageRecord] = field(default_factory=list)
    artifact: Optional[bytes] = None
    error: Optional[str] = None
    thread: Optional[threading.Thread] = None


@dataclass
class _BuildEntry:
    build_id: str
    stages: Tuple[StageFn, ...]
    current: _Attempt


class Orchestrator:
    """Coordinates build attempts; all mutable state lives in memory."""

    def __init__(
        self,
        stage_timeout: float = 60.0,
        admit_hook: Optional[Callable[[str, str], None]] = None,
    ) -> None:
        self._stage_timeout = stage_timeout
        # Test/diagnostic hook invoked by the worker thread after a stage
        # result arrived from the child process but before it is admitted
        # under the lock. Called as admit_hook(attempt_token, stage_name).
        self._admit_hook = admit_hook
        self._lock = threading.Lock()
        self._builds: Dict[str, _BuildEntry] = {}

    def submit(self, build_id: str, stages: Sequence[StageFn]) -> str:
        """Register a build, queue its first attempt, return the attempt id."""
        stages = tuple(stages)
        if len(stages) != len(STAGE_NAMES):
            raise ValueError(f"expected {len(STAGE_NAMES)} stage functions")
        with self._lock:
            if build_id in self._builds:
                raise ValueError(f"build already registered: {build_id!r}")
            entry = _BuildEntry(build_id=build_id, stages=stages, current=None)  # type: ignore[arg-type]
            self._builds[build_id] = entry
            attempt = self._start_attempt_locked(entry)
            return attempt.token

    def rerun(self, build_id: str) -> str:
        """Start a replacement attempt from the original stage functions."""
        with self._lock:
            entry = self._builds[build_id]
            old = entry.current
            if old is not None and not old.state.terminal:
                old.state = AttemptState.SUPERSEDED
            attempt = self._start_attempt_locked(entry)
            return attempt.token

    def cancel(self, build_id: str, attempt: str) -> bool:
        """Cancel the current attempt iff ``attempt`` matches and is not terminal."""
        with self._lock:
            entry = self._builds.get(build_id)
            if entry is None:
                return False
            current = entry.current
            if current is None or current.token != attempt:
                return False
            if current.state.terminal:
                return False
            current.state = AttemptState.CANCELLED
            return True

    def get(self, build_id: str) -> BuildSnapshot:
        """Return a self-consistent snapshot of the build's current attempt."""
        with self._lock:
            entry = self._builds[build_id]
            current = entry.current
            return BuildSnapshot(
                build_id=build_id,
                attempt=current.token,
                state=current.state,
                stage_records=tuple(current.records),
                artifact=current.artifact,
                error=current.error,
            )

    def shutdown(self) -> None:
        with self._lock:
            threads = [
                entry.current.thread
                for entry in self._builds.values()
                if entry.current is not None and entry.current.thread is not None
            ]
        for thread in threads:
            thread.join(timeout=1.0)

    # -- internal ---------------------------------------------------------

    def _start_attempt_locked(self, entry: _BuildEntry) -> _Attempt:
        attempt = _Attempt(token=f"{entry.build_id}:{uuid.uuid4().hex}")
        entry.current = attempt
        thread = threading.Thread(
            target=self._run_attempt,
            args=(entry, attempt),
            name=f"ci-attempt-{attempt.token}",
            daemon=True,
        )
        attempt.thread = thread
        thread.start()
        return attempt

    def _is_live_locked(self, entry: _BuildEntry, attempt: _Attempt) -> bool:
        return entry.current is attempt and attempt.state in (
            AttemptState.QUEUED,
            AttemptState.RUNNING,
        )

    def _run_attempt(self, entry: _BuildEntry, attempt: _Attempt) -> None:
        inputs: Dict[str, Any] = {}
        for index, stage_name in enumerate(STAGE_NAMES):
            with self._lock:
                if not self._is_live_locked(entry, attempt):
                    return
                attempt.state = AttemptState.RUNNING
            try:
                outcome, result = run_stage(
                    entry.stages[index], dict(inputs), self._stage_timeout
                )
            except StageCrashed as exc:
                self._admit(entry, attempt, stage_name, crashed=str(exc))
                return
            admitted = self._admit(
                entry, attempt, stage_name, outcome=outcome, result=result
            )
            if not admitted:
                return
            if outcome == "BLOCK":
                return
            inputs[stage_name] = result

    def _admit(
        self,
        entry: _BuildEntry,
        attempt: _Attempt,
        stage_name: str,
        outcome: Optional[str] = None,
        result: Any = None,
        crashed: Optional[str] = None,
    ) -> bool:
        """Apply a stage outcome to ``attempt`` if it is still the live one.

        Returns True iff the outcome was admitted. Late notifications from
        cancelled or superseded attempts are discarded here.
        """
        if self._admit_hook is not None:
            self._admit_hook(attempt.token, stage_name)
        with self._lock:
            if not self._is_live_locked(entry, attempt):
                return False
            if crashed is not None:
                attempt.state = AttemptState.FAILED
                attempt.error = crashed
                return False
            record = StageRecord(
                stage=stage_name,
                outcome=StageOutcome(outcome),
                result=result,
            )
            attempt.records.append(record)
            if outcome == "BLOCK":
                attempt.state = AttemptState.BLOCKED
            elif stage_name == STAGE_NAMES[-1]:
                attempt.artifact = result
                attempt.state = AttemptState.SUCCEEDED
            return True
