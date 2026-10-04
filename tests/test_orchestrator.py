import functools
import threading
import time

import pytest

import helpers
from ci_orchestrator import AttemptState, Orchestrator
from ci_orchestrator.types import STAGE_NAMES, StageOutcome


def wait_for(predicate, timeout=15.0, interval=0.005):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False


def pass_stages(artifact=b"artifact"):
    stages = [
        functools.partial(helpers.pass_payload, payload=f"{name}-result")
        for name in STAGE_NAMES[:-1]
    ]
    stages.append(functools.partial(helpers.pass_payload, payload=artifact))
    return stages


@pytest.fixture
def orchestrator():
    orch = Orchestrator(stage_timeout=30.0)
    yield orch
    orch.shutdown()


def test_happy_path_succeeds_with_full_stage_trail(orchestrator):
    token = orchestrator.submit("build-ok", pass_stages(artifact=b"final-bytes"))
    assert wait_for(lambda: orchestrator.get("build-ok").state == AttemptState.SUCCEEDED)
    snap = orchestrator.get("build-ok")
    assert snap.attempt == token
    assert snap.artifact == b"final-bytes"
    assert [r.stage for r in snap.stage_records] == list(STAGE_NAMES)
    assert all(r.outcome == StageOutcome.PASS for r in snap.stage_records)


def test_block_stops_pipeline(orchestrator):
    stages = pass_stages()
    stages[2] = functools.partial(helpers.block_payload, payload="cve-found")
    orchestrator.submit("build-blocked", stages)
    assert wait_for(lambda: orchestrator.get("build-blocked").state == AttemptState.BLOCKED)
    snap = orchestrator.get("build-blocked")
    assert [r.stage for r in snap.stage_records] == list(STAGE_NAMES[:3])
    assert snap.stage_records[-1].outcome == StageOutcome.BLOCK
    assert snap.artifact is None


def test_stage_exception_fails_attempt(orchestrator):
    stages = pass_stages()
    stages[0] = functools.partial(helpers.boom, message="checkout exploded")
    orchestrator.submit("build-failed", stages)
    assert wait_for(lambda: orchestrator.get("build-failed").state == AttemptState.FAILED)
    snap = orchestrator.get("build-failed")
    assert "checkout exploded" in snap.error
    assert snap.artifact is None


def test_cancel_stops_attempt(tmp_path, orchestrator):
    gate = tmp_path / "gate"
    stages = pass_stages()
    stages[0] = functools.partial(helpers.gated_pass, gate_file=str(gate), payload="co")
    token = orchestrator.submit("build-cancel", stages)
    assert orchestrator.cancel("build-cancel", token) is True
    assert orchestrator.get("build-cancel").state == AttemptState.CANCELLED
    gate.touch()  # late stage completion must not advance the cancelled attempt
    time.sleep(0.5)
    snap = orchestrator.get("build-cancel")
    assert snap.state == AttemptState.CANCELLED
    assert snap.stage_records == ()
    assert orchestrator.cancel("build-cancel", token) is False  # already terminal


def test_rerun_supersedes_and_does_not_inherit(tmp_path, orchestrator):
    gate = tmp_path / "gate"
    stages = pass_stages(artifact=b"fresh")
    stages[0] = functools.partial(helpers.gated_pass, gate_file=str(gate), payload="co")
    token1 = orchestrator.submit("build-rerun", stages)
    token2 = orchestrator.rerun("build-rerun")
    assert token2 != token1
    gate.touch()
    assert wait_for(lambda: orchestrator.get("build-rerun").state == AttemptState.SUCCEEDED)
    snap = orchestrator.get("build-rerun")
    assert snap.attempt == token2
    assert snap.artifact == b"fresh"
    assert [r.stage for r in snap.stage_records] == list(STAGE_NAMES)


def test_rerun_invalidates_unadmitted_scan_success(tmp_path):
    """Old attempt's scan PASS is in flight; rerun; new scan BLOCKs; the late
    old notification must not let the new attempt reach build/store."""
    marker = tmp_path / "scan-marker"
    entered = threading.Event()
    release = threading.Event()
    holder = {}

    def hook(token, stage):
        if stage == "security_scan" and token == holder.get("old"):
            entered.set()
            assert release.wait(timeout=15)

    orch = Orchestrator(stage_timeout=30.0, admit_hook=hook)
    try:
        stages = pass_stages()
        stages[2] = functools.partial(helpers.flip_scan, marker_file=str(marker))
        token1 = orch.submit("build-race", stages)
        holder["old"] = token1

        assert entered.wait(timeout=15)  # scan PASS sent, not yet admitted
        token2 = orch.rerun("build-race")
        release.set()  # now let the stale notification arrive

        assert wait_for(lambda: orch.get("build-race").state == AttemptState.BLOCKED)
        time.sleep(0.5)  # give any stray old-attempt work a chance to appear
        snap = orch.get("build-race")
        assert snap.attempt == token2
        assert [r.stage for r in snap.stage_records] == list(STAGE_NAMES[:3])
        assert snap.stage_records[-1].outcome == StageOutcome.BLOCK
        assert snap.artifact is None
    finally:
        release.set()
        orch.shutdown()


def test_cancel_and_rerun_with_pending_artifact_notification(tmp_path):
    """Artifact notification pending; cancel + rerun; snapshot must only ever
    show the current attempt's records and artifact; stale cancels are no-ops."""
    counter = tmp_path / "store-counter"
    entered = threading.Event()
    release = threading.Event()
    holder = {}

    def hook(token, stage):
        if stage == "store" and token == holder.get("old"):
            entered.set()
            assert release.wait(timeout=15)

    orch = Orchestrator(stage_timeout=30.0, admit_hook=hook)
    try:
        stages = pass_stages()
        stages[-1] = functools.partial(helpers.counted_store, counter_file=str(counter))
        token1 = orch.submit("build-store", stages)
        holder["old"] = token1

        assert entered.wait(timeout=15)  # artifact notification in flight
        assert orch.cancel("build-store", token1) is True
        snap = orch.get("build-store")
        assert snap.state == AttemptState.CANCELLED
        assert snap.artifact is None

        token2 = orch.rerun("build-store")
        assert orch.cancel("build-store", token1) is False  # stale id, no effect
        release.set()  # old artifact notification must be discarded

        assert wait_for(lambda: orch.get("build-store").state == AttemptState.SUCCEEDED)
        snap = orch.get("build-store")
        assert snap.attempt == token2
        assert snap.artifact == b"artifact-v2"  # produced by the new attempt only
        assert [r.stage for r in snap.stage_records] == list(STAGE_NAMES)
        assert all(r.outcome == StageOutcome.PASS for r in snap.stage_records)

        assert orch.cancel("build-store", token1) is False
        assert orch.cancel("build-store", token2) is False  # already terminal
        snap = orch.get("build-store")
        assert snap.state == AttemptState.SUCCEEDED
        assert snap.artifact == b"artifact-v2"
    finally:
        release.set()
        orch.shutdown()
