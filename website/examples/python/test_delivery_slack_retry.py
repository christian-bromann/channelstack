from channelstack import SlackFixture
from pytest_channelstack import expect


# @show:start
async def test_survives_slacks_3s_retry_without_answering_twice(slack: SlackFixture) -> None:
    ana = await slack.create_user(name="Ana")
    channel = await slack.create_channel(participants=[ana, slack.app])
    msg = await ana.say("@my-agent hi", channel=channel)

    assert msg.delivery
    await msg.delivery.retry(after="3s", reason="http_timeout")

    await expect(msg.thread).to_have_replies_from("my-agent", count=1)
# @show:end
