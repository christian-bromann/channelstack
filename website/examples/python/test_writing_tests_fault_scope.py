from channelstack import SlackFixture
from pytest_channelstack import expect


# @show:start
async def test_still_answers_when_slack_refuses_a_message_as_too_long(slack: SlackFixture) -> None:
    ana = await slack.create_user(name="Ana")
    channel = await slack.create_channel(participants=[ana, slack.app])
    async with await slack.fault(type="error", operation="chat.postMessage", error="msg_too_long", times=1):
        msg = await ana.say("@my-agent hello", channel=channel)

        await expect(msg.thread).to_have_replies_from("my-agent", count=1)
# @show:end
