"""Runs a single stage function in a child process."""

from __future__ import annotations

import multiprocessing as mp
import queue
from typing import Any, Dict, Tuple

from .types import StageFn


class StageCrashed(RuntimeError):
    """The stage raised or its child process exited abnormally."""


def _child_main(fn: StageFn, inputs: Dict[str, Any], out: "mp.Queue") -> None:
    try:
        outcome, result = fn(inputs)
        if outcome not in ("PASS", "BLOCK"):
            raise ValueError(f"invalid stage outcome: {outcome!r}")
        out.put(("ok", outcome, result))
    except BaseException as exc:  # deliver stage exceptions to the parent
        try:
            out.put(("error", f"{type(exc).__name__}: {exc}"))
        except Exception:
            pass


def run_stage(fn: StageFn, inputs: Dict[str, Any], timeout: float) -> Tuple[str, Any]:
    """Execute ``fn`` in a child process.

    Returns ("PASS", result) or ("BLOCK", result) as produced by the stage.
    Raises StageCrashed if the child dies abnormally or the stage raises.
    """
    ctx = mp.get_context("spawn")
    out: "mp.Queue" = ctx.Queue()
    proc = ctx.Process(target=_child_main, args=(fn, inputs, out), daemon=True)
    proc.start()
    proc.join(timeout)
    if proc.is_alive():
        proc.kill()
        proc.join()
        raise StageCrashed(f"stage timed out after {timeout}s")
    try:
        message = out.get_nowait()
    except queue.Empty:
        raise StageCrashed(
            f"stage child exited with code {proc.exitcode} without a result"
        ) from None
    if message[0] == "error":
        raise StageCrashed(f"stage raised: {message[1]}")
    _, outcome, result = message
    return outcome, result
