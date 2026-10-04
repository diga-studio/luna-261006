"""Runs a single stage function inside a child process."""

from __future__ import annotations

import multiprocessing
import traceback
from typing import Any, Callable, Dict, Optional, Tuple

from .types import BLOCK, PASS, StageFn

_CTX = multiprocessing.get_context("spawn")


def _child_entry(fn: StageFn, prior_results: Dict[str, Any], conn) -> None:
    try:
        verdict, result = fn(prior_results)
        if verdict not in (PASS, BLOCK):
            conn.send(("error", f"invalid verdict: {verdict!r}"))
        else:
            conn.send(("pass" if verdict == PASS else "block", result))
    except BaseException:
        conn.send(("error", traceback.format_exc()))
    finally:
        conn.close()


def run_stage(
    fn: StageFn,
    prior_results: Dict[str, Any],
    on_process: Optional[Callable[[multiprocessing.Process], None]] = None,
) -> Tuple[str, Any]:
    """Execute ``fn`` in a child process.

    Returns a tuple ``(kind, payload)`` where kind is one of
    ``"pass"``, ``"block"`` or ``"error"``.
    """
    parent_conn, child_conn = _CTX.Pipe()
    proc = _CTX.Process(
        target=_child_entry, args=(fn, prior_results, child_conn)
    )
    proc.start()
    if on_process is not None:
        on_process(proc)
    child_conn.close()
    try:
        try:
            message = parent_conn.recv()
        except EOFError:
            message = None
    finally:
        proc.join()
        parent_conn.close()
    if message is None:
        return ("error", f"stage process exited abnormally (exitcode={proc.exitcode})")
    return message
