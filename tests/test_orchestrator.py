"""End-to-end tests for the CI build orchestrator.

Stage functions run in real spawned child processes. Deterministic
interleavings are achieved with two orchestrator test hooks:

* ``on_stage_executed`` fires when a child process has finished a stage
  but its result notification has not necessarily been accepted yet;
* ``hold_stage`` / ``release_stage`` defer and re-admit acceptance of a
  specific attempt's stage result.
"""

from __future__ import annotations

import threading
import time

import pytest

from ci_orchestrator import (
    BLOCK,
    PASS,
    STAGE_NAMES,
    AttemptStatus,
    Orchestrator,
)
from tests import stages

TIMEOUT = 20.0


class Tracker:
    """Records (attempt, stage_index) child-process completions."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._events: dict = {}

    def __call__(self, build_id: str, attempt: int, stage_index: int) -> None:
        with self._lock:
            event = self._events.setdefault((attempt, stage_index), threading.Event())
            event.set()

    def wait(self, attempt: int, stage_index: int) -> None:
        with self._lock:
            event = self._events.setdefault((attempt, stage_index), threading.Event())
        assert event.wait(TIMEOUT), (
            f"stage {stage_index} of attempt {attempt} never executed"
        )

    def executed(self, attempt: int, stage_index: int) -> bool:
        with self._lock:
            event = self._events.get((attempt, stage_index))
        return bool(event and event.is_set())


@pytest.fixture()
def tracker():
    return Tracker()


@pytest.fixture()
def orch(tracker):
    instance = Orchestrator(on_stage_executed=tracker)
    yield instance
    instance.close()


@pytest.fixture(autouse=True)
def clean_control_files():
    for path in (stages.SCAN_CONTROL, stages.ARTIFACT_CONTROL):
        path.unlink(missing_ok=True)
    yield
    for path in (stages.SCAN_CONTROL, stages.ARTIFACT_CONTROL):
        path.unlink(missing_ok=True)


def wait_for_status(orch, build_id, statuses):
    deadline = time.monotonic() + TIMEOUT
    while True:
        snap = orch.get(build_id)
        if snap is not None and snap.status in statuses:
            return snap
        assert time.monotonic() < deadline, f"never reached {statuses}"
        time.sleep(0.02)


# ------------------------------------------------------------ basic flows


def test_happy_path_publishes_artifact(orch):
    attempt = orch.submit("b1", stages.make_all_pass())
    snap = wait_for_status(orch, "b1", {AttemptStatus.SUCCEEDED})
    assert snap.attempt == attempt
    assert [r.stage for r in snap.stages] == list(STAGE_NAMES)
    assert all(r.verdict == PASS for r in snap.stages)
    assert snap.artifact == b"artifact-v1"


def test_block_stops_pipeline(orch):
    plan = stages.make_all_pass()
    plan[2] = stages.scan_block
    orch.submit("b2", plan)
    snap = wait_for_status(orch, "b2", {AttemptStatus.BLOCKED})
    assert [r.stage for r in snap.stages] == list(STAGE_NAMES[:3])
    assert snap.stages[-1].verdict == BLOCK
    assert snap.artifact is None


def test_stage_exception_fails_attempt(orch):
    plan = stages.make_all_pass()
    plan[2] = stages.boom
    orch.submit("b3", plan)
    snap = wait_for_status(orch, "b3", {AttemptStatus.FAILED})
    assert [r.stage for r in snap.stages] == list(STAGE_NAMES[:2])
    assert snap.artifact is None


def test_cancel_current_attempt(orch):
    attempt = orch.submit("b4", stages.make_all_pass())
    assert orch.cancel("b4", attempt) is True
    snap = orch.get("b4")
    assert snap.status is AttemptStatus.CANCELLED
    assert orch.cancel("b4", attempt) is False  # already terminal
    time.sleep(1.0)  # late child-process results must not revive it
    assert orch.get("b4").status is AttemptStatus.CANCELLED


def test_get_unknown_build_returns_none(orch):
    assert orch.get("nope") is None


def test_duplicate_submit_rejected(orch):
    orch.submit("b5", stages.make_all_pass())
    with pytest.raises(ValueError):
        orch.submit("b5", stages.make_all_pass())


def test_rerun_unknown_build_rejected(orch):
    with pytest.raises(KeyError):
        orch.rerun("nope")


# ------------------------------------------- required interleaving cases


def test_stale_scan_pass_cannot_bypass_gate(orch, tracker):
    """Old attempt's in-flight scan PASS must not unblock the new attempt.

    1. attempt 1's security scan returns PASS, but the notification is
       held before acceptance;
    2. rerun supersedes attempt 1; the new attempt's scan returns BLOCK;
    3. the stale PASS notification is released and must be dropped;
    4. the new attempt must stop at the scan and never reach build or
       artifact storage.
    """
    stages.SCAN_CONTROL.write_text(PASS)
    plan = stages.make_all_pass()
    plan[2] = stages.scan_from_file
    attempt1 = orch.submit("scan-gate", plan)
    orch.hold_stage(attempt1, 2)
    tracker.wait(attempt1, 2)  # scan PASS computed, notification in flight

    stages.SCAN_CONTROL.write_text(BLOCK)
    attempt2 = orch.rerun("scan-gate")
    assert attempt2 != attempt1

    orch.release_stage(attempt1, 2)  # stale PASS arrives too late

    snap = wait_for_status(orch, "scan-gate", {AttemptStatus.BLOCKED})
    assert snap.attempt == attempt2
    assert [r.stage for r in snap.stages] == list(STAGE_NAMES[:3])
    assert snap.stages[-1].verdict == BLOCK
    assert snap.artifact is None

    time.sleep(1.0)  # nothing may advance past the blocked gate
    snap = orch.get("scan-gate")
    assert len(snap.stages) == 3
    assert not tracker.executed(attempt2, 4)  # build never started
    assert not tracker.executed(attempt2, 5)  # store never started


def test_cancel_and_rerun_with_pending_artifact(orch, tracker):
    """Pending artifact notification of a cancelled attempt is dropped.

    1. attempt 1 finishes the artifact stage, notification held;
    2. cancel attempt 1, then rerun -> attempt 2;
    3. the stale artifact notification is released and must be dropped;
    4. a stale cancel request must not touch attempt 2;
    5. the final snapshot contains only attempt 2's own records and
       attempt 2's own artifact.
    """
    stages.ARTIFACT_CONTROL.write_bytes(b"artifact-old")
    plan = stages.make_all_pass()
    plan[5] = stages.store_from_file
    attempt1 = orch.submit("artifact-gate", plan)
    orch.hold_stage(attempt1, 5)
    tracker.wait(attempt1, 5)  # artifact computed, notification in flight

    assert orch.cancel("artifact-gate", attempt1) is True

    stages.ARTIFACT_CONTROL.write_bytes(b"artifact-new")
    attempt2 = orch.rerun("artifact-gate")

    orch.release_stage(attempt1, 5)  # stale artifact must be dropped
    assert orch.cancel("artifact-gate", attempt1) is False  # stale cancel

    snap = wait_for_status(orch, "artifact-gate", {AttemptStatus.SUCCEEDED})
    assert snap.attempt == attempt2
    assert [r.stage for r in snap.stages] == list(STAGE_NAMES)
    assert all(r.verdict == PASS for r in snap.stages)
    assert snap.artifact == b"artifact-new"


def test_new_attempt_inherits_nothing(orch, tracker):
    """A rerun starts from stage 0; old passed stages are not reused."""
    attempt1 = orch.submit("fresh", stages.make_all_pass())
    tracker.wait(attempt1, 2)  # a few stages already passed
    attempt2 = orch.rerun("fresh")
    snap = wait_for_status(orch, "fresh", {AttemptStatus.SUCCEEDED})
    assert snap.attempt == attempt2
    assert len(snap.stages) == 6
    assert snap.stages[0].stage == "checkout"
    assert snap.artifact == b"artifact-v1"
