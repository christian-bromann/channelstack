# @show:start
# conftest.py: pytest's own fixtures, built on channelstack's.
import pytest_asyncio

from channelstack import SlackConversation, SlackFixture, SlackUser


@pytest_asyncio.fixture(loop_scope="session")
async def ana(slack: SlackFixture) -> SlackUser:
    return await slack.create_user(name="Ana")


@pytest_asyncio.fixture(loop_scope="session")
async def support(slack: SlackFixture, ana: SlackUser) -> SlackConversation:
    return await slack.create_channel(name="support", participants=[ana, slack.app])
# @show:end
