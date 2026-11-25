import re

from channelstack import SlackFixture
from pytest_channelstack import expect


async def test_three_matchers(slack: SlackFixture) -> None:
    ana = await slack.create_user(name="Ana")
    channel = await slack.create_channel(participants=[ana, slack.app])
    msg = await ana.say("@my-agent summarize yesterday's incidents", channel=channel)
    # @show:start
    await expect(msg.thread).to_have_reply_from("my-agent", text=re.compile("incident", re.I))
    await expect(msg.thread).to_have_replies_from(slack.app, count=1)
    await expect(channel).not_to_have_channel_message_from("my-agent")
    # @show:end
