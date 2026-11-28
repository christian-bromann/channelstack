"""`expect(...)` passes and fails the way the matchers do, on stand-in handles (no server)."""

import hashlib
import re
import secrets
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import ANY

import httpx
import pytest

from channelstack.runtime.client import HandleContext, quiet_of
from channelstack.runtime.files import set_files_root
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


@dataclass(frozen=True)
class Modal:
    title: str


class SlackPerson:
    _ctx = None

    def __init__(self, *titles: str) -> None:
        self.titles = titles

    async def modals(self) -> list[Modal]:
        return [Modal(title) for title in self.titles]


async def test_a_modal_opened_for_someone() -> None:
    await expect(SlackPerson("Deploy")).to_have_opened_modal(timeout="300ms")
    await expect(SlackPerson("Deploy")).to_have_opened_modal(re.compile("^dep", re.I), timeout="300ms")
    with pytest.raises(
        AssertionError, match='Expected a modal titled "Rollback" to have been opened. Opened: "Deploy"'
    ):
        await expect(SlackPerson("Deploy")).to_have_opened_modal("Rollback", timeout="300ms")


async def test_no_modal_opened_for_someone() -> None:
    await expect(SlackPerson()).not_to_have_opened_modal(timeout="300ms")
    with pytest.raises(AssertionError, match='Expected no modal to have been opened. Opened: "Deploy"'):
        await expect(SlackPerson("Deploy")).not_to_have_opened_modal(timeout="300ms")


@dataclass(frozen=True)
class Posted:
    visible_to: Person | None = None


async def test_a_message_only_one_person_sees() -> None:
    await expect(Posted(ANA)).to_be_ephemeral_for(ANA)
    with pytest.raises(AssertionError, match="Expected the message to be visible only to Ana, everyone can see it"):
        await expect(Posted()).to_be_ephemeral_for(ANA)
    with pytest.raises(AssertionError, match="visible only to Ana, only my-agent can"):
        await expect(Posted(AGENT)).to_be_ephemeral_for(ANA)


async def test_a_message_not_only_for_one_person() -> None:
    await expect(Posted()).not_to_be_ephemeral_for(ANA)
    with pytest.raises(AssertionError, match="Expected the message not to be visible only to Ana, only Ana can"):
        await expect(Posted(ANA)).not_to_be_ephemeral_for(ANA)


@dataclass(frozen=True)
class Attempt:
    status: str
    response_status: int | None = None
    duration_ms: float | None = None
    forged_signature: bool = False


@dataclass
class Delivery:
    attempts: list[Attempt]
    id: str = "dlv_1"
    _ctx: object = None

    async def refresh(self) -> "Delivery":
        return self


async def test_a_delivery_accepted_in_time() -> None:
    delivery = Delivery([Attempt("acknowledged", 200, 120)])
    await expect(delivery).to_be_accepted(within="1s", timeout="300ms")
    with pytest.raises(
        AssertionError,
        match=r"Expected delivery dlv_1 to be accepted within 100ms, its first attempt is acknowledged \(HTTP 200\) "
        r"after 120ms",
    ):
        await expect(delivery).to_be_accepted(within=100, timeout="300ms")


async def test_a_delivery_not_accepted() -> None:
    await expect(Delivery([Attempt("failed", 500, 30)])).not_to_be_accepted(timeout="300ms")
    with pytest.raises(AssertionError, match="Expected delivery dlv_1 not to be accepted, its first attempt is"):
        await expect(Delivery([Attempt("acknowledged", 200, 5)])).not_to_be_accepted(timeout="300ms")


async def test_a_forged_delivery_rejected() -> None:
    forged = Delivery([Attempt("acknowledged", 200), Attempt("failed", 401, forged_signature=True)])
    await expect(forged).to_be_rejected(timeout="300ms")
    with pytest.raises(AssertionError, match=r"but no forged attempt was sent\. Call delivery\.resend\(bad_signature"):
        await expect(Delivery([Attempt("acknowledged", 200)])).to_be_rejected(timeout="300ms")
    with pytest.raises(AssertionError, match="to be rejected with a 4xx, the agent answered 200"):
        await expect(Delivery([Attempt("acknowledged", 200, forged_signature=True)])).to_be_rejected(timeout="300ms")


async def test_a_forged_delivery_not_rejected() -> None:
    await expect(Delivery([Attempt("acknowledged", 200, forged_signature=True)])).not_to_be_rejected(timeout="300ms")
    with pytest.raises(AssertionError, match="of delivery dlv_1 not to be rejected with a 4xx, the agent answered 401"):
        await expect(Delivery([Attempt("failed", 401, forged_signature=True)])).not_to_be_rejected(timeout="300ms")


async def test_a_delivery_retried() -> None:
    delivery = Delivery([Attempt("timed_out"), Attempt("timed_out"), Attempt("acknowledged", 200)])
    await expect(delivery).to_be_retried(timeout="300ms")
    await expect(delivery).to_be_retried(times=2, timeout="300ms")
    with pytest.raises(AssertionError, match="Expected delivery dlv_1 to be retried 1 times, it was retried 2 times"):
        await expect(delivery).to_be_retried(times=1, timeout="300ms")


async def test_a_delivery_not_retried() -> None:
    # A forged resend isn't a retry.
    await expect(
        Delivery([Attempt("acknowledged", 200), Attempt("failed", 401, forged_signature=True)])
    ).not_to_be_retried(timeout="300ms")
    with pytest.raises(AssertionError, match="Expected delivery dlv_1 not to be retried, it was retried 1 times"):
        await expect(Delivery([Attempt("timed_out"), Attempt("acknowledged", 200)])).not_to_be_retried(timeout="300ms")


@dataclass(frozen=True)
class ReviewComment:
    author: Person
    path: str
    line: int
    body: str


@dataclass(frozen=True)
class Review:
    author: Person
    state: str
    body: str = ""


@dataclass(frozen=True)
class CheckRun:
    name: str
    status: str
    conclusion: str | None = None


@dataclass
class PullRequest:
    _ctx: object = None
    comments_on_diff: list[ReviewComment] = field(default_factory=lambda: [])
    review_list: list[Review] = field(default_factory=lambda: [])
    runs: list[CheckRun] = field(default_factory=lambda: [])
    label_list: list[str] = field(default_factory=lambda: [])
    is_merged: bool = False

    async def review_comments(self) -> list[ReviewComment]:
        return self.comments_on_diff

    async def reviews(self) -> list[Review]:
        return self.review_list

    async def check_runs(self) -> list[CheckRun]:
        return self.runs

    async def labels(self) -> list[str]:
        return self.label_list

    async def merged(self) -> bool:
        return self.is_merged


DIFF = PullRequest(comments_on_diff=[ReviewComment(AGENT, "src/login.ts", 12, "Safari drops the cookie here")])


async def test_a_comment_on_the_diff() -> None:
    await expect(DIFF).to_have_review_comment(path="src/login.ts", line=12, from_=AGENT, text="Safari", timeout="300ms")
    with pytest.raises(
        AssertionError,
        match=r"Expected a comment on the diff on src/login.ts:13 from my-agent\. The diff has:\n"
        r"  my-agent on src/login.ts:12: Safari drops the cookie here",
    ):
        await expect(DIFF).to_have_review_comment(path="src/login.ts", line=13, from_="my-agent", timeout="300ms")


async def test_no_comment_on_the_diff() -> None:
    await expect(DIFF).not_to_have_review_comment(path="README.md", timeout="300ms")
    with pytest.raises(AssertionError, match=r'Expected no comment on the diff matching "cookie"\. The diff has'):
        await expect(DIFF).not_to_have_review_comment(text="cookie", timeout="300ms")


REVIEWED = PullRequest(review_list=[Review(AGENT, "CHANGES_REQUESTED", "Needs a test")])


async def test_a_review_from_someone() -> None:
    await expect(REVIEWED).to_have_review_from(AGENT, state="CHANGES_REQUESTED", timeout="300ms")
    with pytest.raises(
        AssertionError,
        match=r"Expected a review from my-agent with state APPROVED\. Reviews there:\n"
        r'  my-agent: CHANGES_REQUESTED "Needs a test"',
    ):
        await expect(REVIEWED).to_have_review_from("my-agent", state="APPROVED", timeout="300ms")


async def test_no_review_from_someone() -> None:
    await expect(REVIEWED).not_to_have_review_from(ANA, timeout="300ms")
    with pytest.raises(AssertionError, match="Expected no review from my-agent. Reviews there"):
        await expect(REVIEWED).not_to_have_review_from("my-agent", timeout="300ms")


CHECKED = PullRequest(runs=[CheckRun("ci / test", "completed", "failure"), CheckRun("lint", "in_progress")])


async def test_a_check_run() -> None:
    await expect(CHECKED).to_have_check_run("ci / test", conclusion="failure", timeout="300ms")
    await expect(CHECKED).to_have_check_run(re.compile("^li"), status="in_progress", timeout="300ms")
    with pytest.raises(
        AssertionError,
        match=r'Expected a check run "ci" \(completed, success\)\. Check runs there:\n'
        r"  ci / test: completed, failure\n  lint: in_progress",
    ):
        # A string must equal the name.
        await expect(CHECKED).to_have_check_run("ci", status="completed", conclusion="success", timeout="300ms")


async def test_no_check_run() -> None:
    await expect(CHECKED).not_to_have_check_run("ci / test", conclusion="success", timeout="300ms")
    with pytest.raises(AssertionError, match=r"Expected no check run /test/ \(failure\)"):
        await expect(CHECKED).not_to_have_check_run(re.compile("test"), conclusion="failure", timeout="300ms")


async def test_a_label_in_any_case() -> None:
    labelled = PullRequest(label_list=["Bug"])
    await expect(labelled).to_have_label("bug", timeout="300ms")
    with pytest.raises(AssertionError, match='Expected the label "triage". Labels there: Bug'):
        await expect(labelled).to_have_label("triage", timeout="300ms")


async def test_no_label() -> None:
    await expect(PullRequest()).not_to_have_label("bug", timeout="300ms")
    with pytest.raises(AssertionError, match='Expected no label "BUG". Labels there: Bug'):
        await expect(PullRequest(label_list=["Bug"])).not_to_have_label("BUG", timeout="300ms")


async def test_a_merged_pull_request() -> None:
    await expect(PullRequest(is_merged=True)).to_be_merged(timeout="300ms")
    with pytest.raises(AssertionError, match="^Expected the pull request to be merged$"):
        await expect(PullRequest()).to_be_merged(timeout="300ms")


async def test_a_pull_request_not_merged() -> None:
    await expect(PullRequest()).not_to_be_merged(timeout="300ms")
    with pytest.raises(AssertionError, match="^Expected the pull request not to be merged$"):
        await expect(PullRequest(is_merged=True)).not_to_be_merged(timeout="300ms")


@dataclass(frozen=True)
class WorkflowState:
    name: str


@dataclass
class TrackedIssue:
    """A Linear issue: who it is delegated and assigned to, and its workflow state."""

    _ctx: object = None
    delegate: Person | None = None
    owner: Person | None = None
    workflow: str = "Todo"

    async def delegated_to(self) -> Person | None:
        return self.delegate

    async def assignee(self) -> Person | None:
        return self.owner

    async def state(self) -> WorkflowState:
        return WorkflowState(self.workflow)


async def test_an_issue_delegated_to_an_app() -> None:
    await expect(TrackedIssue(delegate=AGENT)).to_be_delegated_to(AGENT, timeout="300ms")
    await expect(TrackedIssue()).to_be_delegated_to(None, timeout="300ms")
    with pytest.raises(
        AssertionError, match="Expected the issue to be delegated to my-agent, it is delegated to no one"
    ):
        await expect(TrackedIssue()).to_be_delegated_to(AGENT, timeout="300ms")


async def test_an_issue_not_delegated_to_an_app() -> None:
    await expect(TrackedIssue()).not_to_be_delegated_to(AGENT, timeout="300ms")
    with pytest.raises(AssertionError, match="not to be delegated to no one, it is delegated to no one"):
        await expect(TrackedIssue()).not_to_be_delegated_to(None, timeout="300ms")


async def test_an_issue_assigned_to_someone() -> None:
    await expect(TrackedIssue(owner=ANA)).to_be_assigned_to(ANA, timeout="300ms")
    with pytest.raises(AssertionError, match="Expected the issue to be assigned to no one, it is assigned to Ana"):
        await expect(TrackedIssue(owner=ANA)).to_be_assigned_to(None, timeout="300ms")


async def test_an_issue_not_assigned_to_someone() -> None:
    await expect(TrackedIssue(owner=ANA)).not_to_be_assigned_to(AGENT, timeout="300ms")
    with pytest.raises(AssertionError, match="Expected the issue not to be assigned to Ana, it is assigned to Ana"):
        await expect(TrackedIssue(owner=ANA)).not_to_be_assigned_to(ANA, timeout="300ms")


async def test_an_issue_in_a_workflow_state() -> None:
    await expect(TrackedIssue(workflow="In Progress")).to_have_state("in progress", timeout="300ms")
    with pytest.raises(AssertionError, match='Expected the issue to be in "Done", it is in "Todo"'):
        await expect(TrackedIssue()).to_have_state("Done", timeout="300ms")


async def test_an_issue_not_in_a_workflow_state() -> None:
    await expect(TrackedIssue()).not_to_have_state("Done", timeout="300ms")
    with pytest.raises(AssertionError, match='Expected the issue not to be in "todo", it is in "Todo"'):
        await expect(TrackedIssue()).not_to_have_state("todo", timeout="300ms")


def rich(kind: str, text: str, *children: dict[str, Any]) -> dict[str, Any]:
    return {"type": kind, kind: {"rich_text": [{"plain_text": text}]}, "children": list(children)}


class NotionPage:
    _ctx = None

    def __init__(self, **properties: object) -> None:
        self.properties = properties

    async def blocks(self) -> list[dict[str, Any]]:
        return [
            rich("heading_1", "Incident 42", rich("paragraph", "Root cause: a stale cache")),
            {"type": "child_page", "child_page": {"title": "Timeline"}},
        ]

    async def property(self, name: str) -> object:
        return self.properties.get(name)


async def test_a_block_at_any_depth() -> None:
    await expect(NotionPage()).to_have_block(re.compile("root cause", re.I), timeout="300ms")
    await expect(NotionPage()).to_have_block("Timeline", timeout="300ms")
    with pytest.raises(
        AssertionError,
        match=r'Expected the page to have a block matching "Fix"\. Its blocks:\n'
        r"  Incident 42\n  Root cause: a stale cache\n  Timeline",
    ):
        await expect(NotionPage()).to_have_block("Fix", timeout="300ms")


async def test_no_block() -> None:
    await expect(NotionPage()).not_to_have_block("Fix", timeout="300ms")
    with pytest.raises(AssertionError, match='Expected the page not to have a block matching "stale"'):
        await expect(NotionPage()).not_to_have_block("stale", timeout="300ms")


async def test_a_property_value() -> None:
    row = NotionPage(Status="Done", Points=3)
    await expect(row).to_have_property_value("Status", "Done", timeout="300ms")
    await expect(row).to_have_property_value("Points", ANY, timeout="300ms")
    with pytest.raises(AssertionError, match='Expected Status to be Open, it is "Done"'):
        await expect(row).to_have_property_value("Status", "Open", timeout="300ms")


async def test_not_a_property_value() -> None:
    row = NotionPage(Points=3)
    await expect(row).not_to_have_property_value("Points", 5, timeout="300ms")
    with pytest.raises(AssertionError, match="Expected Points not to be 3, it is 3"):
        await expect(row).not_to_have_property_value("Points", 3, timeout="300ms")


# The model: the file a call carried, by its hash.

PNG = bytes([0x89, *b"PNG", 0, 255])
PNG_SHA256 = hashlib.sha256(PNG).hexdigest()


def part(type: str, **fields: Any) -> SimpleNamespace:
    """An image, file or audio in a call, as the fake read it."""
    return SimpleNamespace(
        type=type, **{"url": None, "file_id": None, "media_type": None, "bytes": None, "sha256": None, **fields}
    )


def request(messages: list[SimpleNamespace] | None = None, file: SimpleNamespace | None = None) -> SimpleNamespace:
    return SimpleNamespace(request=SimpleNamespace(text="", tools=[], messages=messages or [], file=file))


@dataclass
class Model:
    """The openai fixture: its calls, the newest last."""

    requests: list[SimpleNamespace]
    _ctx: object = None

    async def calls(self) -> list[SimpleNamespace]:
        return list(self.requests)


SENT = Model(
    [
        request([SimpleNamespace(parts=[part("image", url="https://example.com/a.png")])]),
        request(file=part("audio", media_type="audio/wav", bytes=44, sha256="ab" * 32)),
        request(
            [
                SimpleNamespace(parts=None),
                SimpleNamespace(parts=[part("image", media_type="image/png", bytes=6, sha256=PNG_SHA256)]),
            ]
        ),
    ]
)


@pytest.fixture
def chart(tmp_path: Path) -> Iterator[Path]:
    """`chart.png` in the files root. Leaves no root set."""
    (tmp_path / "chart.png").write_bytes(PNG)
    set_files_root(tmp_path)
    yield tmp_path / "chart.png"
    set_files_root(None)


async def test_a_file_sent_holds_for_its_path_from_the_files_root_and_for_its_bytes(chart: Path) -> None:
    await expect(SENT).to_have_sent_file("./chart.png", **FAST)
    await expect(SENT).to_have_sent_file(chart, **FAST)
    await expect(SENT).to_have_sent_file(PNG, **FAST)


async def test_a_file_not_sent_fails_with_what_was_sent_newest_first(chart: Path) -> None:
    listed = "\n".join(
        [
            r"Expected the agent to send the model these bytes \(3 bytes, sha256 039058c6f2c0\)\. "
            "What it sent, newest first:",
            rf"  image, image/png, 6 bytes, sha256 {PNG_SHA256[:12]}",
            "  audio, audio/wav, 44 bytes, sha256 abababababab",
            r"  image, https://example\.com/a\.png",
        ]
    )
    with pytest.raises(AssertionError, match=f"^{listed}$"):
        await expect(SENT).to_have_sent_file(b"\x01\x02\x03", **FAST)
    with pytest.raises(
        AssertionError, match=r"to send the model chart\.png \(6 bytes, .*It sent no image, file or audio\.$"
    ):
        await expect(Model([request([SimpleNamespace(parts=None)])])).to_have_sent_file("./chart.png", **FAST)
    with pytest.raises(FileNotFoundError):
        await expect(SENT).to_have_sent_file("./missing.png", **FAST)


async def test_a_file_not_to_be_sent_once_quiet() -> None:
    await expect(SENT).not_to_have_sent_file(b"\x01", **FAST)
    with pytest.raises(AssertionError, match=r"^Expected the agent not to send the model these bytes \(6 bytes"):
        await expect(SENT).not_to_have_sent_file(PNG, **FAST)
