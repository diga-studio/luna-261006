"""Central orchestration loop: owns all build state."""

from __future__ import annotations

import itertools
import queue
import threading
from typing import Any, Callable, Dict, List, Optional, Tuple

from .executor import run_stage
from .types import (
    PASS,
    STAGE_NAMES,
    TERMINAL_STATUSES,
    AttemptStatus,
    BuildSnapshot,
    StageFn,
    StageRecord,
)


class _Attempt:
    __slots__ = ("id", "status", "records", "artifact")

    def __init__(self, attempt_id: int) -> None:
        self.id = attempt_id
        self.status = AttemptStatus.RUNNING
        self.records: List[StageRecord] = []
        self.artifact: Optional[bytes] = None


class _BuildState:
    __slots__ = ("stages", "current")

    def __init__(self, stages: List[StageFn], attempt: _Attempt) -> None:
        self.stages = stages
        self.current = attempt


class Orchestrator:
    """In-process CI build orchestrator.

    All state transitions happen on a single internal event-loop thread;
    stage results arriving from replaced or cancelled attempts are dropped.
    A downstream stage is only launched by the loop itself, after the
    previous stage's result has been accepted for the current attempt, and
    it only ever receives results recorded by that same attempt.
    """

    def __init__(
        self,
        on_stage_executed: Optional[Callable[[str, int, int], None]] = None,
    ) -> None:
        self._on_stage_executed = on_stage_executed
        self._queue: "queue.Queue[tuple]" = queue.Queue()
        self._builds: Dict[str, _BuildState] = {}
        self._attempt_ids = itertools.count(1)
        self._held: set = set()
        self._held_lock = threading.Lock()
        self._deferred: List[tuple] = []
        self._procs: Dict[int, Any] = {}
        self._procs_lock = threading.Lock()
        self._closed = False
        self._thread = threading.Thread(
            target=self._loop, name="ci-orchestrator", daemon=True
        )
        self._thread.start()

    # ------------------------------------------------------------------ API

    def submit(self, build_id: str, stages: List[StageFn]) -> int:
        """Register a build and queue its first attempt. Returns attempt id."""
        if len(stages) != len(STAGE_NAMES):
            raise ValueError(f"expected {len(STAGE_NAMES)} stage functions")
        return self._call(("submit", build_id, list(stages)))

    def rerun(self, build_id: str) -> int:
        """Create a fresh attempt from the original stage functions."""
        return self._call(("rerun", build_id))

    def cancel(self, build_id: str, attempt: int) -> bool:
        """Cancel the current attempt iff it matches and is not terminal."""
        return self._call(("cancel", build_id, attempt))

    def get(self, build_id: str) -> Optional[BuildSnapshot]:
        """Return a self-consistent snapshot of the build's current attempt."""
        return self._call(("get", build_id))

    def hold_stage(self, attempt: int, stage_index: int) -> None:
        """Test hook: defer acceptance of one attempt's stage result."""
        with self._held_lock:
            self._held.add((attempt, stage_index))

    def release_stage(self, attempt: int, stage_index: int) -> None:
        """Test hook: re-admit a deferred stage result."""
        with self._held_lock:
            self._held.discard((attempt, stage_index))
        self._queue.put(("release", attempt, stage_index))

    def close(self) -> None:
        if not self._closed:
            self._closed = True
            self._queue.put(("stop",))
            self._thread.join(timeout=5)

    # ------------------------------------------------------------- plumbing

    def _call(self, msg: tuple) -> Any:
        reply: "queue.Queue[tuple]" = queue.Queue()
        self._queue.put(msg + (reply,))
        kind, value = reply.get()
        if kind == "err":
            raise value
        return value

    def _loop(self) -> None:
        while True:
            msg = self._queue.get()
            tag = msg[0]
            if tag == "stop":
                return
            if tag == "stage_done":
                self._on_stage_done(*msg[1:])
            elif tag == "release":
                self._on_release(msg[1], msg[2])
            else:
                *args, reply = msg[1:]
                try:
                    handler = {
                        "submit": self._apply_submit,
                        "rerun": self._apply_rerun,
                        "cancel": self._apply_cancel,
                        "get": self._apply_get,
                    }[tag]
                    reply.put(("ok", handler(*args)))
                except Exception as exc:  # noqa: BLE001 - reported to caller
                    reply.put(("err", exc))

    # ------------------------------------------------------- state changes

    def _apply_submit(self, build_id: str, stages: List[StageFn]) -> int:
        if build_id in self._builds:
            raise ValueError(f"build {build_id!r} already registered")
        attempt = _Attempt(next(self._attempt_ids))
        self._builds[build_id] = _BuildState(stages, attempt)
        self._launch(build_id, self._builds[build_id], 0)
        return attempt.id

    def _apply_rerun(self, build_id: str) -> int:
        build = self._builds.get(build_id)
        if build is None:
            raise KeyError(f"unknown build {build_id!r}")
        self._retire(build.current, AttemptStatus.SUPERSEDED)
        attempt = _Attempt(next(self._attempt_ids))
        build.current = attempt
        self._launch(build_id, build, 0)
        return attempt.id

    def _apply_cancel(self, build_id: str, attempt_id: int) -> bool:
        build = self._builds.get(build_id)
        if build is None:
            return False
        current = build.current
        if current.id != attempt_id or current.status in TERMINAL_STATUSES:
            return False
        self._retire(current, AttemptStatus.CANCELLED)
        return True

    def _apply_get(self, build_id: str) -> Optional[BuildSnapshot]:
        build = self._builds.get(build_id)
        if build is None:
            return None
        current = build.current
        return BuildSnapshot(
            build_id=build_id,
            attempt=current.id,
            status=current.status,
            stages=tuple(current.records),
            artifact=current.artifact,
        )

    def _retire(self, attempt: _Attempt, status: AttemptStatus) -> None:
        if attempt.status not in TERMINAL_STATUSES:
            attempt.status = status
        self._terminate_process(attempt.id)

    # ------------------------------------------------------- stage results

    def _on_stage_done(
        self,
        build_id: str,
        attempt_id: int,
        stage_index: int,
        kind: str,
        payload: Any,
    ) -> None:
        with self._held_lock:
            held = (attempt_id, stage_index) in self._held
        if held:
            self._deferred.append(
                ("stage_done", build_id, attempt_id, stage_index, kind, payload)
            )
            return
        self._accept_stage_done(build_id, attempt_id, stage_index, kind, payload)

    def _on_release(self, attempt_id: int, stage_index: int) -> None:
        pending = [
            m
            for m in self._deferred
            if m[2] == attempt_id and m[3] == stage_index
        ]
        self._deferred = [
            m
            for m in self._deferred
            if not (m[2] == attempt_id and m[3] == stage_index)
        ]
        for _, build_id, att, stage_index, kind, payload in pending:
            self._accept_stage_done(build_id, att, stage_index, kind, payload)

    def _accept_stage_done(
        self,
        build_id: str,
        attempt_id: int,
        stage_index: int,
        kind: str,
        payload: Any,
    ) -> None:
        build = self._builds.get(build_id)
        if build is None:
            return
        attempt = build.current
        if attempt.id != attempt_id:
            return  # stale attempt: replaced or superseded
        if attempt.status in TERMINAL_STATUSES:
            return  # stale attempt: cancelled or already finished
        if stage_index != len(attempt.records):
            return  # out-of-order or duplicate notification
        stage_name = STAGE_NAMES[stage_index]
        if kind == "error":
            attempt.status = AttemptStatus.FAILED
            return
        attempt.records.append(
            StageRecord(stage=stage_name, verdict=PASS if kind == "pass" else "BLOCK",
                        result=payload)
        )
        if kind == "block":
            attempt.status = AttemptStatus.BLOCKED
            return
        if stage_index == len(STAGE_NAMES) - 1:
            if not isinstance(payload, bytes):
                attempt.status = AttemptStatus.FAILED
                return
            attempt.artifact = payload
            attempt.status = AttemptStatus.SUCCEEDED
            return
        self._launch(build_id, build, stage_index + 1)

    # ------------------------------------------------------------ execution

    def _launch(self, build_id: str, build: _BuildState, stage_index: int) -> None:
        attempt = build.current
        attempt_id = attempt.id
        fn = build.stages[stage_index]
        prior_results = {rec.stage: rec.result for rec in attempt.records}
        thread = threading.Thread(
            target=self._execute_stage,
            args=(build_id, attempt_id, stage_index, fn, prior_results),
            name=f"ci-stage-{attempt_id}-{stage_index}",
            daemon=True,
        )
        thread.start()

    def _execute_stage(
        self,
        build_id: str,
        attempt_id: int,
        stage_index: int,
        fn: StageFn,
        prior_results: Dict[str, Any],
    ) -> None:
        def register(proc: Any) -> None:
            with self._procs_lock:
                self._procs[attempt_id] = proc

        try:
            kind, payload = run_stage(fn, prior_results, on_process=register)
        except Exception as exc:  # noqa: BLE001 - defensive
            kind, payload = "error", f"executor failure: {exc!r}"
        finally:
            with self._procs_lock:
                self._procs.pop(attempt_id, None)
        if self._on_stage_executed is not None:
            self._on_stage_executed(build_id, attempt_id, stage_index)
        self._queue.put(
            ("stage_done", build_id, attempt_id, stage_index, kind, payload)
        )

    def _terminate_process(self, attempt_id: int) -> None:
        with self._procs_lock:
            proc = self._procs.pop(attempt_id, None)
        if proc is not None and proc.is_alive():
            proc.terminate()
