"""The pytest plugin: one client per run, one session per test, and a fixture per channel.

    async def test_mention(slack: SlackFixture) -> None:
        ana = await slack.create_user(name="Ana")
        channel = await slack.create_channel(participants=[ana, slack.app])
        msg = await ana.say("@my-agent hi", channel=channel)
        await expect(msg.thread).to_have_reply_from("my-agent")

Tests and fixtures share one event loop for the whole run, so the client (and a server it
started) lives as long as the run. Every test gets its own session, closed after it, which removes
everything the test created.
"""

from collections.abc import AsyncIterator
from typing import cast, get_args

import pytest
import pytest_asyncio

from channelstack import (
    Channelstack,
    ChannelstackError,
    GitHubFixture,
    LinearFixture,
    NotionFixture,
    Session,
    SlackFixture,
    connect,
)
from channelstack.runtime.files import set_files_root
from channelstack.runtime.launcher import Mode
from channelstack.runtime.transport import on_refusal

from .options import defaults

SKIPS_LIVE = frozenset({"unsupported_in_live", "action_requires"})
"""The refusals live mode skips a test for: what it can't do, or needs a piece this run doesn't have."""


def pytest_addoption(parser: pytest.Parser) -> None:
    group = parser.getgroup("channelstack")
    group.addoption(
        "--channelstack-mode",
        choices=get_args(Mode),
        default=None,
        help="How the client finds the server: attach to a running one, start one, or either (default: auto)",
    )
    parser.addini("channelstack_mode", "How the client finds the server: auto, attach or start", default="auto")
    parser.addini("channelstack_timeout", "How long a check waits (default: 10s)", default="10s")
    parser.addini("channelstack_quiet_for", "How long the agent must be quiet (default: 750ms)", default="750ms")


def _skip_live_refusal(error: ChannelstackError, path: str) -> None:
    """What live mode can't do skips the test, with the reason, instead of failing it.

    A fake-only feature (`unsupported_in_live`), or one that needs a piece this run lacks
    (`action_requires`: the browser actor, proxy mode). The fake never refuses these, so every test
    still runs in full against the fake.
    """
    if path.startswith("/sessions/") and error.code in SKIPS_LIVE:
        pytest.skip(f"live: {error.message}")


def pytest_configure(config: pytest.Config) -> None:
    mode = cast(str | None, config.getoption("channelstack_mode")) or cast(str, config.getini("channelstack_mode"))
    if mode not in get_args(Mode):
        raise pytest.UsageError(f"channelstack_mode must be one of {', '.join(get_args(Mode))}, got {mode!r}")
    defaults.mode = cast(Mode, mode)
    defaults.timeout = cast(str, config.getini("channelstack_timeout"))
    defaults.quiet_for = cast(str, config.getini("channelstack_quiet_for"))
    on_refusal(_skip_live_refusal)


def pytest_unconfigure(config: pytest.Config) -> None:
    on_refusal(None)


@pytest_asyncio.fixture(scope="session", loop_scope="session")
async def channelstack() -> AsyncIterator[Channelstack]:
    """The root client, for the whole run: `env()`, `reset()`, and sessions."""
    client = await connect(mode=defaults.mode)
    try:
        yield client
    finally:
        await client.close()


@pytest_asyncio.fixture(loop_scope="session")
async def channelstack_session(channelstack: Channelstack, request: pytest.FixtureRequest) -> AsyncIterator[Session]:
    """The test's session: closing it after the test removes everything the test created."""
    session = await channelstack.open_session()
    # A fixture path in a test (`files="./fixtures/web"`) starts from the test file, like an import.
    set_files_root(request.path.parent)
    async with session:
        yield session


@pytest_asyncio.fixture(loop_scope="session")
async def slack(channelstack_session: Session) -> SlackFixture:
    """The Slack fixture: the agent's app, the workspace, and people and channels to create."""
    return await channelstack_session.slack()


@pytest_asyncio.fixture(loop_scope="session")
async def github(channelstack_session: Session) -> GitHubFixture:
    """The GitHub fixture: the agent's App, the org, and people and repos to create."""
    return await channelstack_session.github()


@pytest_asyncio.fixture(loop_scope="session")
async def linear(channelstack_session: Session) -> LinearFixture:
    """The Linear fixture: the agent's app, and people, teams and issues to create."""
    return await channelstack_session.linear()


@pytest_asyncio.fixture(loop_scope="session")
async def notion(channelstack_session: Session) -> NotionFixture:
    """The Notion fixture: the agent's integration, and people, pages and databases to create."""
    return await channelstack_session.notion()
