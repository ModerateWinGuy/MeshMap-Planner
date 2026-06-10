"""Lightweight, decoupled progress reporting for long-running jobs.

A background task installs a *sink* (a ``callable(message, fraction)``) for the duration of the
job; deep code — the SPLAT! service, the DEM providers — calls :func:`report` to surface human
progress without knowing anything about Redis, task ids, or HTTP. The sink is held in a
``ContextVar`` so concurrent jobs (each on its own worker thread) stay isolated and no function
signatures have to change to thread a reporter object through.

``fraction`` is an optional 0..1 estimate of overall completion. Steps that can't estimate it pass
``None`` to update only the message; the sink keeps the last known fraction so the bar doesn't jump
backwards.
"""

import contextvars
import logging
from typing import Callable, Optional

logger = logging.getLogger(__name__)

# A sink is callable(message: str, fraction: float | None) -> None.
ProgressSink = Callable[[str, Optional[float]], None]

_sink: "contextvars.ContextVar[Optional[ProgressSink]]" = contextvars.ContextVar(
    "progress_sink", default=None
)


def set_progress_sink(sink: Optional[ProgressSink]) -> None:
    """Install the progress sink for the current context (call at the start of a job)."""
    _sink.set(sink)


def clear_progress_sink() -> None:
    """Remove the sink (call in a finally when the job ends)."""
    _sink.set(None)


def report(message: str, fraction: Optional[float] = None) -> None:
    """Surface a progress update. A no-op if no sink is installed. Never raises — progress
    reporting must not be able to break the job it's describing."""
    sink = _sink.get()
    if sink is None:
        return
    try:
        sink(message, fraction)
    except Exception as e:  # noqa: BLE001 — best-effort; swallow so the job is unaffected.
        logger.debug("Progress sink failed: %s", e)
