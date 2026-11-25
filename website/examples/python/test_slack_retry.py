from channelstack import SlackFixture
from pytest_channelstack import expect


async def test_slacks_retry_is_answered_once(slack: SlackFixture) -> None:
    ana = await slack.create_user(name="Ana")
    msg = await ana.say("@my-agent hi", to=slack.app)
    # @show:start
    assert msg.delivery
    await msg.delivery.retry(after="3s", reason="http_timeout")
    await expect(msg.thread).to_have_replies_from("my-agent", count=1)
    # @show:end
