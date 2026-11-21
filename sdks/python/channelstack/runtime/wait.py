"""The one polling loop. Every wait_for…, latest… and matcher is built on it; tests never sleep."""

import asyncio
import time
from collections.abc import Awaitable, Callable

from .duration import Duration, parse_duration


class WaitTimeoutError(Exception):
    def __init__(self, what: str, timeout_ms: float) -> None:
        super().__init__(f"Timed out after {timeout_ms:g}ms waiting for {what}")


async def wait_for[T](
    what: str,
    read: Callable[[], Awaitable[T | None]],
    *,
    timeout: Duration = "10s",
    interval: Duration = "50ms",
) -> T:
    """Read until `read` returns something other than None, or the timeout passes."""
    timeout_ms = parse_duration(timeout)
    interval_ms = parse_duration(interval)
    deadline = time.monotonic() + timeout_ms / 1000
    while True:
        value = await read()
        if value is not None:
            return value
        if time.monotonic() + interval_ms / 1000 > deadline:
            raise WaitTimeoutError(what, timeout_ms)
        await asyncio.sleep(interval_ms / 1000)
