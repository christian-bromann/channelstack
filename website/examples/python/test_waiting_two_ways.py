from channelstack import SlackFixture
from pytest_channelstack import expect


async def test_matchers_wait_in_two_ways(slack: SlackFixture) -> None:
    ana = await slack.create_user(name="Ana")
    channel = await slack.create_channel(participants=[ana, slack.app])
    # @show:start
    msg = await ana.say("@my-agent summarize yesterday's incidents", channel=channel)

    await expect(msg.thread).to_have_reply_from("my-agent")  # waits for a reply
    await expect(msg.thread).to_have_replies_from("my-agent", count=1)  # waits for quiet, then counts
    await expect(channel).not_to_have_channel_message_from("my-agent")  # waits for quiet, then checks
    # @show:end
