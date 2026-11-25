"""`expect(...)` passes and fails the way the matchers do, on stand-in handles (no server)."""

import re
import secrets
from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest

from channelstack.runtime.client import HandleContext, quiet_of
from channelstack.runtime.transport import Transport, on_refusal
from channelstack.runtime.wait import QuietState
from pytest_channelstack import expect, matchers
from pytest_channelstack.plugin import _skip_live_refusal  # pyright: ignore[reportPrivateUsage]

pytestmark = pytest.mark.asyncio


@dataclass(frozen=True)
class Person:
    id: str
    name: str


@dataclass
class Message:
    author: Person
    text: str


@dataclass
class Thread:
    """A thread whose replies arrive one read at a time: `later` are added on each read."""

    _ctx: object = None
    messages: list[Message] = field(default_factory=lambda: [])
    later: list[Message] = field(default_factory=lambda: [])

    async def replies(self) -> list[Message]:
        if self.later:
            self.messages.append(self.later.pop(0))
        return list(self.messages)


AGENT = Person("B01", "my-agent")
ANA = Person("U01", "Ana")
FAST = {"timeout": "300ms"}


@pytest.fixture(autouse=True)
def quiet(monkeypatch: pytest.MonkeyPatch) -> None:
    """The session is always quiet, and has nothing open."""

    async def always_quiet(_: object) -> QuietState:
        return QuietState(busy=False, quiet_for_ms=60_000, open=())

    monkeypatch.setattr(matchers, "quiet_of", always_quiet)
    monkeypatch.setattr(matchers.defaults, "quiet_for", "20ms")


async def test_a_positive_check_waits_for_what_arrives_later() -> None:
    thread = Thread(later=[Message(ANA, "hi"), Message(AGENT, "an incident report")])
    await expect(thread).to_have_reply_from("my-agent", text=re.compile("incident"), **FAST)
    await expect(thread).to_have_reply_from(AGENT)


async def test_a_positive_check_fails_with_what_the_thread_has() -> None:
    thread = Thread(messages=[Message(ANA, "hi")])
    with pytest.raises(AssertionError, match=r"Expected a reply from my-agent\. The thread has:\n  Ana: hi"):
        await expect(thread).to_have_reply_from("my-agent", **FAST)


async def test_a_negative_check_fails_on_a_reply() -> None:
    thread = Thread(messages=[Message(AGENT, "here")])
    with pytest.raises(AssertionError, match="Expected no reply from my-agent"):
        await expect(thread).not_to_have_reply_from("my-agent", **FAST)
    await expect(Thread(messages=[Message(ANA, "hi")])).not_to_have_reply_from("my-agent", **FAST)


async def test_an_exact_count_is_checked_once_quiet() -> None:
    thread = Thread(messages=[Message(AGENT, "one"), Message(AGENT, "two")])
    await expect(thread).to_have_replies_from("my-agent", count=2, **FAST)
    with pytest.raises(AssertionError, match="Expected exactly 1 reply from my-agent, found 2"):
        await expect(thread).to_have_replies_from("my-agent", count=1, **FAST)


async def test_a_failure_says_what_the_agent_left_open(monkeypatch: pytest.MonkeyPatch) -> None:
    async def open_stream(_: object) -> QuietState:
        return QuietState(busy=False, quiet_for_ms=60_000, open=("a stream in thread 1.2",))

    monkeypatch.setattr(matchers, "quiet_of", open_stream)
    with pytest.raises(AssertionError, match="Still open: a stream in thread 1.2"):
        await expect(Thread()).to_have_reply_from("my-agent", **FAST)


@dataclass(frozen=True)
class Status:
    state: str
    text: str | None = None


async def test_status() -> None:
    class Working:
        _ctx = None

        async def status(self) -> Status:
            return Status("working", "is thinking…")

    await expect(Working()).to_have_status("working", **FAST)
    with pytest.raises(AssertionError, match=r"Expected the thread to be idle, it is working \('is thinking…'\)"):
        await expect(Working()).to_have_status("idle", **FAST)


@dataclass(frozen=True)
class Reaction:
    emoji: str
    by: list[Person]


async def test_a_reaction_by_someone() -> None:
    class Reacted:
        _ctx = None

        async def reactions(self) -> list[Reaction]:
            return [Reaction("eyes", [AGENT])]

    await expect(Reacted()).to_have_reaction(":eyes:", by=AGENT, **FAST)
    with pytest.raises(AssertionError, match=r"reaction by Ana\. Reactions there: :eyes: by my-agent"):
        await expect(Reacted()).to_have_reaction("eyes", by=ANA, **FAST)


@dataclass(frozen=True)
class Call:
    operation: str
    error: str | None = None


async def test_no_call_with_an_error() -> None:
    class Fixture:
        _ctx = None

        async def calls(self, *, error: Any = None) -> list[Call]:
            calls = [Call("chat.postMessage"), Call("reactions.add", "already_reacted")]
            return [call for call in calls if error is None or call.error == error]

    await expect(Fixture()).not_to_have_received_call(re.compile(".*"), error="not_in_channel", **FAST)
    with pytest.raises(AssertionError, match="found 1: reactions.add → already_reacted"):
        await expect(Fixture()).not_to_have_received_call(re.compile(".*"), error="already_reacted", **FAST)


async def test_a_live_refusal_while_describing_a_failure_keeps_it_a_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    """Live, the open work a failure message adds may be refused: the check still fails, it isn't skipped."""

    async def send(*_: object) -> httpx.Response:
        return httpx.Response(501, json={"error": "action_requires", "message": "needs the browser", "data": {}})

    transport = Transport(url="http://127.0.0.1:1", token=secrets.token_hex(8), base_path="/_channelstack", errors={})
    monkeypatch.setattr(transport, "_send", send)
    monkeypatch.setattr(matchers, "quiet_of", quiet_of)  # the real one, through the transport
    thread = Thread(_ctx=HandleContext(transport=transport, session="ses_1"))
    on_refusal(_skip_live_refusal)
    try:
        with pytest.raises(AssertionError, match="Expected a reply from my-agent"):
            await expect(thread).to_have_reply_from("my-agent", **FAST)
        # The same refusal anywhere else skips the test, as live mode should.
        with pytest.raises(pytest.skip.Exception, match="live: needs the browser"):
            await quiet_of(HandleContext(transport=transport, session="ses_1"))
    finally:
        on_refusal(None)
        await transport.close()
