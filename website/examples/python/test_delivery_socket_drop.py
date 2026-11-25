from channelstack import SlackFixture
from pytest_channelstack import expect


# @show:start
async def test_reconnects_after_the_socket_mode_connection_drops(slack: SlackFixture) -> None:
    ana = await slack.create_user(name="Ana")
    await slack.fault(type="drop_socket")

    msg = await ana.say("still there?", to=slack.app)

    await expect(msg.thread).to_have_reply_from("my-agent", timeout="20s")
# @show:end
