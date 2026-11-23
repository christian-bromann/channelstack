"""The one polling loop. Every wait_for…, latest… and matcher is built on it; tests never sleep."""

import asyncio
import re
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Protocol

from .duration import Duration, parse_duration


class WaitTimeoutError(Exception):
    def __init__(self, what: str, timeout_ms: float) -> None:
        super().__init__(f"Timed out after {timeout_ms:g}ms waiting for {what}")


async def wait_for[T](
    what: str | Callable[[], str],
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
            raise WaitTimeoutError(what if isinstance(what, str) else what(), timeout_ms)
        await asyncio.sleep(interval_ms / 1000)


async def retry_while[T](
    codes: Sequence[str],
    call: Callable[[], Awaitable[T]],
    *,
    timeout: Duration = "10s",
) -> T:
    """Repeat a call while it is refused with one of these error codes, the way a person waits for a
    button to appear before clicking it. When the time is up, the last refusal is the error."""
    refusal: Exception | None = None

    async def attempt() -> tuple[T] | None:
        nonlocal refusal
        try:
            return (await call(),)
        except Exception as error:
            if getattr(error, "code", None) not in codes:
                raise
            refusal = error
            return None

    try:
        return (await wait_for("the call to be accepted", attempt, timeout=timeout))[0]
    except WaitTimeoutError:
        if refusal is not None:
            raise refusal from None
        raise


@dataclass(frozen=True)
class QuietState:
    """What the server says about the agent's activity in a session (GET /sessions/{sid}/quiet)."""

    busy: bool
    quiet_for_ms: float
    open: Sequence[str] = ()
    """What is still open, in words: a delivery in flight or about to be retried, a stream the agent never stopped."""


class Author(Protocol):
    """Anyone who can author something: a handle with an id and a name."""

    @property
    def id(self) -> str: ...

    @property
    def name(self) -> str: ...


Text = str | re.Pattern[str]
"""Text to look for: a string the text contains, or a compiled pattern."""


def text_matches(text: str, expected: Text | None) -> bool:
    """Does a text match what was asked for: a string it contains, a pattern, or nothing (any text)?"""
    if expected is None:
        return True
    return expected in text if isinstance(expected, str) else expected.search(text) is not None


def from_matches(author: Author, from_: Author | str | None) -> bool:
    """Does an item's author match a `from_` filter: a handle, a name, or nothing (anyone)?"""
    if from_ is None:
        return True
    if isinstance(from_, str):
        return from_ in (author.name, author.id)
    return author.id == from_.id


def pattern_on_wire(pattern: str | re.Pattern[str]) -> str | dict[str, str]:
    """Text to find as it goes to the server: a string as it is, a pattern as its source and flags."""
    if isinstance(pattern, str):
        return pattern
    marks = {"i": re.IGNORECASE, "m": re.MULTILINE, "s": re.DOTALL}
    return {"source": pattern.pattern, "flags": "".join(flag for flag, bit in marks.items() if pattern.flags & bit)}


def describe_wait(what: str, from_: Author | str | None) -> str:
    """ "a reply" -> "a reply from my-agent", for timeout messages."""
    if from_ is None:
        return what
    return f"{what} from {from_ if isinstance(from_, str) else from_.name}"


async def wait_for_next[T](
    seen: dict[str, int],
    key: str,
    read: Callable[[], Awaitable[Sequence[T]]],
    matches: Callable[[T], bool],
    what: str,
    *,
    timeout: Duration = "10s",
    starts_turn: Callable[[T], bool] | None = None,
) -> T:
    """Wait for the next new item of a list that matches, after the last one this handle returned.

    `seen` belongs to the handle and remembers, per wait, how far it has looked. With `starts_turn`,
    the wait also looks only after the newest item that starts a turn (a person's prompt).
    """

    async def look() -> T | None:
        items = await read()
        turn = 0
        if starts_turn is not None:
            turn = next((position + 1 for position in reversed(range(len(items))) if starts_turn(items[position])), 0)
        for position in range(max(seen.get(key, 0), turn), len(items)):
            if matches(items[position]):
                seen[key] = position + 1
                return items[position]
        return None

    return await wait_for(what, look, timeout=timeout)


async def until_quiet(
    quiet: Callable[[], Awaitable[QuietState]],
    *,
    timeout: Duration = "10s",
    quiet_for: Duration = "750ms",
    watching: bool = False,
) -> None:
    """Resolve once the agent has been quiet for `quiet_for`. Negative and exact-count checks read after this.

    With `watching`, the quiet time counts from now at the earliest: the caller wants to have looked
    for the whole window. An agent that is thinking makes no sound, so a session that went quiet a
    while ago says nothing about what arrives next.
    """
    quiet_for_ms = parse_duration(quiet_for)
    started = time.monotonic()

    still_open: Sequence[str] = ()

    async def settled() -> bool | None:
        nonlocal still_open
        state = await quiet()
        still_open = state.open
        if watching and (time.monotonic() - started) * 1000 < quiet_for_ms:
            return None
        return True if not state.busy and state.quiet_for_ms >= quiet_for_ms else None

    def what() -> str:
        # A wait that gives up says what the agent left open: that is usually the bug.
        left = f". Still open: {'; '.join(still_open)}" if still_open else ""
        return f"the agent to be quiet for {quiet_for_ms:g}ms{left}"

    await wait_for(what, settled, timeout=timeout)


async def latest_once_quiet[T](
    read: Callable[[], Awaitable[Sequence[T]]],
    matches: Callable[[T], bool],
    quiet: Callable[[], Awaitable[QuietState]],
    what: str,
    *,
    timeout: Duration = "10s",
    quiet_for: Duration = "750ms",
) -> T:
    """The last item of a list that matches, read once the agent is quiet. Waits for at least one first."""

    async def latest() -> T | None:
        matching = [item for item in await read() if matches(item)]
        return matching[-1] if matching else None

    await wait_for(what, latest, timeout=timeout)
    await until_quiet(quiet, timeout=timeout, quiet_for=quiet_for)
    # The agent may have said more while it was settling: the answer is what is there now.
    return await wait_for(what, latest, timeout=timeout)
