"""`expect(...)` passes and fails the way the matchers do, on stand-in handles (no server)."""

import re
import secrets
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any, cast

import httpx
import pytest

from channelstack.runtime.client import HandleContext, quiet_of
from channelstack.runtime.transport import Transport, on_refusal
from channelstack.runtime.wait import QuietState, WaitTimeoutError, set_wait_defaults, wait_defaults, wait_for
from pytest_channelstack import expect, matchers
from pytest_channelstack.plugin import (
    _skip_live_refusal,  # pyright: ignore[reportPrivateUsage]
    pytest_configure,
    pytest_unconfigure,
)

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
def quiet(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """The session is always quiet, and has nothing open."""

    async def always_quiet(_: object) -> QuietState:
        return QuietState(busy=False, quiet_for_ms=60_000, open=())

    monkeypatch.setattr(matchers, "quiet_of", always_quiet)
    before = wait_defaults()
    set_wait_defaults(quiet_for="20ms")
    yield
    set_wait_defaults(timeout=before.timeout, quiet_for=before.quiet_for)


async def test_the_ini_settings_are_every_waits_defaults() -> None:
    """`channelstack_timeout` and `channelstack_quiet_for` reach the SDK's own waits, not only the checks."""

    class Config:
        def getoption(self, name: str) -> None:
            return None

        def getini(self, name: str) -> str:
            return {"channelstack_mode": "auto", "channelstack_timeout": "40ms", "channelstack_quiet_for": "30ms"}[name]

    before = wait_defaults()
    pytest_configure(cast(pytest.Config, Config()))
    try:
        assert (wait_defaults().timeout, wait_defaults().quiet_for) == ("40ms", "30ms")

        async def nothing() -> None:
            return None

        with pytest.raises(WaitTimeoutError, match="Timed out after 40ms"):
            await wait_for("a reply", nothing)
    finally:
        pytest_unconfigure(cast(pytest.Config, Config()))
        set_wait_defaults(timeout=before.timeout, quiet_for=before.quiet_for)


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
    await expect(thread).to_have_replies_from("my-agent", count=2, timeout="300ms")
    with pytest.raises(AssertionError, match="Expected exactly 1 reply from my-agent, found 2"):
        await expect(thread).to_have_replies_from("my-agent", count=1, timeout="300ms")


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
    with pytest.raises(AssertionError, match=r'Expected the thread to be idle, it is working \("is thinking…"\)'):
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

    await expect(Fixture()).not_to_have_received_call(re.compile(".*"), error="not_in_channel", timeout="300ms")
    with pytest.raises(AssertionError, match=r"found 1\. Its calls:\n  reactions.add → already_reacted"):
        await expect(Fixture()).not_to_have_received_call(re.compile(".*"), error="already_reacted", timeout="300ms")
    await expect(Fixture()).not_to_have_received_call("chat.postMessage", times=2, timeout="300ms")
    with pytest.raises(
        AssertionError,
        match=r'not to call "chat.postMessage" 1 times, found 1\. Its calls:\n'
        r"  chat.postMessage\n  reactions.add → already_reacted",
    ):
        await expect(Fixture()).not_to_have_received_call("chat.postMessage", times=1, timeout="300ms")


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


@dataclass(frozen=True)
class Speaker:
    id: str
    name: str
    kind: str = "user"


@dataclass(frozen=True)
class Entry:
    id: str
    author: Speaker
    text: str
    controls: tuple[str, ...] = ()


@dataclass(frozen=True)
class Transcript:
    entries: list[Entry]


BOT = Speaker("B01", "my-agent", "app")
PERSON = Speaker("U01", "Ana")


class Conversation:
    _ctx = None

    def __init__(self, *entries: Entry) -> None:
        self.entries = list(entries)

    async def transcript(self) -> Transcript:
        return Transcript(self.entries)


async def test_text_a_person_sees_once_or_exactly_n_times() -> None:
    conversation = Conversation(Entry("1", PERSON, "deploy web"), Entry("2", BOT, "Deploying web"))
    await expect(conversation).to_contain_text("Deploying", timeout="300ms")
    await expect(conversation).to_contain_text("Deploying", count=1, timeout="300ms")
    await expect(conversation).not_to_contain_text("Thinking…", timeout="300ms")
    with pytest.raises(AssertionError, match='Expected exactly 2 entries with text matching "Deploying", found 1'):
        await expect(conversation).to_contain_text("Deploying", count=2, timeout="300ms")


class WithEphemeral:
    """A conversation with one message only Ana sees: read as no one, it's left out."""

    _ctx = None

    def __init__(self) -> None:
        self.viewers: list[object] = []

    async def transcript(self, *, as_: object = None) -> Transcript:
        self.viewers.append(as_)
        shown = [Entry("1", PERSON, "deploy web")]
        return Transcript([*shown, Entry("2", BOT, "Only you can see this")] if as_ is PERSON else shown)


async def test_text_as_a_person_sees_it_includes_their_ephemeral_messages() -> None:
    conversation = WithEphemeral()
    await expect(conversation).to_contain_text("Only you", as_=PERSON, timeout="300ms")
    await expect(conversation).not_to_contain_text("Only you", timeout="300ms")
    with pytest.raises(AssertionError, match='Expected text matching "Only you", found 0'):
        await expect(conversation).to_contain_text("Only you", timeout="300ms")
    assert conversation.viewers[0] is PERSON


async def test_a_button_on_the_apps_latest_message() -> None:
    conversation = Conversation(Entry("1", PERSON, "deploy"), Entry("2", BOT, "Approve?", ("Approve", "Cancel")))
    await expect(conversation).to_have_button("Approve", timeout="300ms")
    with pytest.raises(AssertionError, match="Buttons there: Approve, Cancel"):
        await expect(conversation).to_have_button("Reject", timeout="300ms")


async def test_no_button_with_a_label() -> None:
    conversation = Conversation(Entry("1", BOT, "Approve?", ("Approve", "Cancel")))
    await expect(conversation).not_to_have_button("Reject", timeout="300ms")
    with pytest.raises(AssertionError, match=r"Expected no button matching /approve/i\. Buttons there: Approve"):
        await expect(conversation).not_to_have_button(re.compile("approve", re.I), timeout="300ms")


@dataclass(frozen=True)
class Comment:
    author: Person
    body: str


class Issue:
    _ctx = None

    def __init__(self, *comments: Comment) -> None:
        self.list = list(comments)

    async def comments(self) -> list[Comment]:
        return self.list


async def test_comments_from_someone_and_exactly_how_many() -> None:
    issue = Issue(Comment(ANA, "@my-agent look"), Comment(AGENT, "Safari breaks on the redirect"))
    await expect(issue).to_have_comment_from("my-agent", text=re.compile("Safari"), timeout="300ms")
    await expect(issue).to_have_comments_from("my-agent", count=1, timeout="300ms")
    with pytest.raises(AssertionError, match="Expected exactly 2 comments from my-agent, found 1"):
        await expect(issue).to_have_comments_from("my-agent", count=2, timeout="300ms")


async def test_no_comment_from_someone_and_not_exactly_how_many() -> None:
    issue = Issue(Comment(ANA, "@my-agent look"), Comment(AGENT, "Safari breaks on the redirect"))
    await expect(issue).not_to_have_comment_from("my-agent", text="Chrome", timeout="300ms")
    await expect(issue).not_to_have_comments_from("my-agent", count=2, timeout="300ms")
    with pytest.raises(AssertionError, match=r'Expected no comment from my-agent matching "Safari"\. The conversation'):
        await expect(issue).not_to_have_comment_from("my-agent", text="Safari", timeout="300ms")
    with pytest.raises(AssertionError, match="Expected not exactly 1 comments from my-agent, found 1"):
        await expect(issue).not_to_have_comments_from("my-agent", count=1, timeout="300ms")


async def test_a_notion_page_points_to_its_discussions() -> None:
    class Page:
        _ctx = None

        async def discussions(self) -> list[object]:
            return []

    with pytest.raises(TypeError, match="to_have_comment_from needs a Notion discussion, not a page"):
        await expect(Page()).to_have_comment_from("my-agent", timeout="300ms")


@dataclass(frozen=True)
class Activity:
    type: str
    author: Person
    body: str | None = None


class AgentSession:
    _ctx = None

    def __init__(self, state: str, *activities: Activity) -> None:
        self.current = state
        self.list = list(activities)

    async def state(self) -> str:
        return self.current

    async def activities(self) -> list[Activity]:
        return self.list


class LinearIssue:
    _ctx = None

    def __init__(self, *sessions: AgentSession) -> None:
        self.list = list(sessions)

    async def sessions(self) -> list[AgentSession]:
        return self.list


async def test_an_agent_session_its_state_and_activities() -> None:
    session = AgentSession("complete", Activity("prompt", ANA, "fix it"), Activity("thought", AGENT, "Looking"))
    await expect(session).to_have_session_state("complete", timeout="300ms")
    await expect(LinearIssue(session)).to_have_activity(type="thought", from_="my-agent", timeout="300ms")
    with pytest.raises(AssertionError, match="Expected the agent session to be active, it is complete"):
        await expect(session).to_have_session_state("active", timeout="300ms")
    # People's prompts aren't the agent's activities.
    with pytest.raises(AssertionError, match="Expected a prompt"):
        await expect(session).to_have_activity(type="prompt", timeout="300ms")


async def test_an_agent_session_not_in_a_state_and_without_an_activity() -> None:
    session = AgentSession("complete", Activity("prompt", ANA, "fix it"), Activity("thought", AGENT, "Looking"))
    await expect(session).not_to_have_session_state("active", timeout="300ms")
    await expect(session).not_to_have_activity(type="error", timeout="300ms")
    with pytest.raises(AssertionError, match="Expected the agent session not to be complete, it is complete"):
        await expect(session).not_to_have_session_state("complete", timeout="300ms")
    with pytest.raises(AssertionError, match=r"Expected no thought from my-agent\. The session has:\n  my-agent"):
        await expect(LinearIssue(session)).not_to_have_activity(type="thought", from_=AGENT, timeout="300ms")
