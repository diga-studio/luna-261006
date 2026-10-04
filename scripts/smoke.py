"""Happy-path smoke test: one build runs all six stages to an artifact."""

import time

from ci_orchestrator import AttemptStatus, Orchestrator
from tests.stages import make_all_pass


def main() -> None:
    orch = Orchestrator()
    attempt = orch.submit("b1", make_all_pass())
    print("attempt:", attempt)
    deadline = time.time() + 30
    snap = orch.get("b1")
    while time.time() < deadline and snap.status not in (
        AttemptStatus.SUCCEEDED,
        AttemptStatus.FAILED,
        AttemptStatus.BLOCKED,
    ):
        time.sleep(0.05)
        snap = orch.get("b1")
    print(snap.status, [(s.stage, s.verdict) for s in snap.stages], snap.artifact)
    assert snap.status is AttemptStatus.SUCCEEDED
    assert snap.artifact == b"artifact-v1"
    assert len(snap.stages) == 6
    orch.close()
    print("SMOKE_OK")


if __name__ == "__main__":
    main()
