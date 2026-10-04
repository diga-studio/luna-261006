"""Picklable stage functions shared by the orchestrator tests.

Stage functions run in spawned subprocesses, so they must be module-level
and only take picklable arguments. Cross-process coordination uses files.
"""

import os
import time


def pass_payload(inputs, payload):
    return ("PASS", payload)


def block_payload(inputs, payload):
    return ("BLOCK", payload)


def boom(inputs, message):
    raise RuntimeError(message)


def gated_pass(inputs, gate_file, payload):
    """PASS once ``gate_file`` exists; raise TimeoutError otherwise."""
    deadline = time.monotonic() + 30.0
    while not os.path.exists(gate_file):
        if time.monotonic() > deadline:
            raise TimeoutError(f"gate not released: {gate_file}")
        time.sleep(0.01)
    return ("PASS", payload)


def flip_scan(inputs, marker_file):
    """PASS on the first invocation, BLOCK on every later one."""
    if os.path.exists(marker_file):
        return ("BLOCK", "policy-violation")
    with open(marker_file, "w") as fh:
        fh.write("scanned")
    return ("PASS", "scan-ok")


def counted_store(inputs, counter_file):
    """Return an artifact whose bytes identify which invocation produced it."""
    count = 0
    if os.path.exists(counter_file):
        with open(counter_file) as fh:
            count = int(fh.read() or 0)
    count += 1
    with open(counter_file, "w") as fh:
        fh.write(str(count))
    return ("PASS", f"artifact-v{count}".encode())
