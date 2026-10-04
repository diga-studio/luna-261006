"""Picklable stage functions shared by the test-suite.

All functions live at module level so they can be pickled into the
spawned child processes.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, Tuple

from ci_orchestrator import BLOCK, PASS

_DIR = Path(__file__).resolve().parent
SCAN_CONTROL = _DIR / ".scan_verdict"
ARTIFACT_CONTROL = _DIR / ".artifact_bytes"


def scan_from_file(prior: Dict[str, Any]) -> Tuple[str, Any]:
    """Security scan whose verdict is read from a local control file.

    Lets a test change the verdict between a submit and a rerun even
    though stage code runs in a freshly spawned child process.
    """
    try:
        verdict = SCAN_CONTROL.read_text().strip()
    except FileNotFoundError:
        verdict = PASS
    if verdict == BLOCK:
        return BLOCK, {"vulns": 7}
    return PASS, {"vulns": 0}


def store_from_file(prior: Dict[str, Any]) -> Tuple[str, Any]:
    """Artifact store whose bytes come from a local control file."""
    try:
        payload = ARTIFACT_CONTROL.read_bytes()
    except FileNotFoundError:
        payload = b"artifact-default"
    return PASS, payload


def checkout_ok(prior: Dict[str, Any]) -> Tuple[str, Any]:
    assert prior == {}
    return PASS, {"commit": "abc123"}


def resolve_ok(prior: Dict[str, Any]) -> Tuple[str, Any]:
    assert set(prior) == {"checkout"}
    return PASS, ["lib-a==1.0"]


def scan_ok(prior: Dict[str, Any]) -> Tuple[str, Any]:
    assert set(prior) == {"checkout", "resolve_deps"}
    return PASS, {"vulns": 0}


def scan_block(prior: Dict[str, Any]) -> Tuple[str, Any]:
    return BLOCK, {"vulns": 3}


def license_ok(prior: Dict[str, Any]) -> Tuple[str, Any]:
    assert "security_scan" in prior
    return PASS, {"copyleft": False}


def build_ok(prior: Dict[str, Any]) -> Tuple[str, Any]:
    assert "license_check" in prior
    return PASS, {"image": "app:1.0"}


def store_v1(prior: Dict[str, Any]) -> Tuple[str, Any]:
    assert "build" in prior
    return PASS, b"artifact-v1"


def store_v2(prior: Dict[str, Any]) -> Tuple[str, Any]:
    return PASS, b"artifact-v2"


def boom(prior: Dict[str, Any]) -> Tuple[str, Any]:
    raise RuntimeError("stage exploded")


def make_all_pass(store=store_v1):
    return [checkout_ok, resolve_ok, scan_ok, license_ok, build_ok, store]
