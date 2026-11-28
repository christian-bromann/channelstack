"""Answering model calls from the test (decision 0029).

The server holds each call a responder script matches; this task reads them (a long poll), runs the
test's function and posts what it returns. It runs until the script is undone or its session
closes, which end its reads.
"""

import asyncio
import inspect
from collections.abc import Awaitable, Callable
from typing import Any, Protocol

from .transport import ChannelstackError

_LONG_POLL_MS = 20_000
"""How long one read waits on the server for a held call: well inside any HTTP timeout."""

_running: set[asyncio.Task[None]] = set()
"""The responders running, so their tasks aren't collected while they wait."""


class _HeldPage(Protocol):
    @property
    def held(self) -> list[Any]: ...
    @property
    def cursor(self) -> str: ...


def respond_with(
    held: Callable[[str | None, int], Awaitable[_HeldPage]],
    answer: Callable[[str, Any, str | None], Awaitable[None]],
    respond: Callable[[Any], Any],
) -> None:
    """Start answering a responder script's calls in the background, on the running event loop."""

    async def answer_one(call: Any) -> None:
        try:
            turn = respond(call.request)
            if inspect.isawaitable(turn):
                turn = await turn
            result: tuple[Any, str | None] = (turn, None)
        except Exception as error:  # noqa: BLE001 - the test's function failed: the server records why
            result = (None, f"{type(error).__name__}: {error}")
        try:
            await answer(call.id, *result)
        except ChannelstackError:
            # The agent hung up, or the call was answered by its timeout: the server has recorded why.
            pass

    async def loop() -> None:
        since: str | None = None
        while True:
            try:
                page = await held(since, _LONG_POLL_MS)
            except ChannelstackError:
                # The script was undone, or its session closed: nothing more will be held for it.
                return
            since = page.cursor
            for call in page.held:
                task = asyncio.create_task(answer_one(call))
                _running.add(task)
                task.add_done_callback(_running.discard)

    task = asyncio.get_running_loop().create_task(loop())
    _running.add(task)
    task.add_done_callback(_running.discard)
