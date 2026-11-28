"""The plugin's session fixture fails a test that left a bot loop (decision 0027), on a stand-in session.

`test/acceptance/plugin-defaults.test.ts` runs the same against the server: two scripted apps loop
past the guard, and the fixture fails the test.
"""

from dataclasses import dataclass, field
from typing import cast

import pytest

from channelstack import ChannelstackError, Session
from pytest_channelstack.plugin import _fail_on_loops  # pyright: ignore[reportPrivateUsage]

pytestmark = pytest.mark.asyncio


@dataclass(frozen=True)
class Quiet:
    loops: list[str] = field(default_factory=lambda: [])


@dataclass
class StandIn:
    """A session whose quiet state names the loops the fake stopped, or whose read is refused."""

    loops: list[str] = field(default_factory=lambda: [])
    refused: bool = False

    async def quiet(self) -> Quiet:
        if self.refused:
            raise ChannelstackError("action_requires", 400, "live, without proxy mode")
        return Quiet(self.loops)


STOPPED = "a bot loop in slack C0123 was stopped after 50 app messages with no person between them (ping → pong …)"


async def test_a_session_with_a_stopped_loop_fails_the_test_naming_it() -> None:
    with pytest.raises(pytest.fail.Exception, match=r"The fake stopped a bot loop in slack C0123 .*\(ping → pong"):
        await _fail_on_loops(cast(Session, StandIn([STOPPED])))


async def test_a_session_without_loops_or_that_cannot_tell_passes() -> None:
    await _fail_on_loops(cast(Session, StandIn()))
    await _fail_on_loops(cast(Session, StandIn(refused=True)))
