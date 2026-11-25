# @show:start
import pytest_asyncio

from channelstack import SlackConversation, SlackFixture, SlackUser
from pytest_channelstack import expect


# In a project, these fixtures go in conftest.py, where every test file finds them.
@pytest_asyncio.fixture(loop_scope="session")
async def ana(slack: SlackFixture) -> SlackUser:
    return await slack.create_user(name="Ana")


@pytest_asyncio.fixture(loop_scope="session")
async def ben(slack: SlackFixture) -> SlackUser:
    return await slack.create_user(name="Ben", admin=True)


@pytest_asyncio.fixture(loop_scope="session")
async def support(slack: SlackFixture, ana: SlackUser, ben: SlackUser) -> SlackConversation:
    return await slack.create_channel(name="support", participants=[ana, ben, slack.app])


async def test_an_admin_and_a_regular_member_see_the_same_answer(
    support: SlackConversation, ana: SlackUser, ben: SlackUser
) -> None:
    question = await ana.say("@my-agent who's on call?", channel=support)
    await ben.reply("+1, also need this", thread=question)

    await expect(question.thread).to_have_replies_from("my-agent", count=1)
# @show:end
