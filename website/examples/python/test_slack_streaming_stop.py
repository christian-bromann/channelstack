from channelstack import SlackFixture
from pytest_channelstack import expect


async def test_a_streaming_reply_and_stop(slack: SlackFixture) -> None:
    ana = await slack.create_user(name="Ana")
    # @show:start
    msg = await ana.say("write a long report on Q3", to=slack.app)
    await expect(msg.thread).to_have_streaming_reply_from("my-agent")

    await ana.stop(thread=msg)
    await expect(msg.thread).to_have_status("stopped")
    # @show:end
