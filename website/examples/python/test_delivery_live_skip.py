import pytest

from channelstack import SlackFixture
from pytest_channelstack import expect


# @show:start
async def test_survives_slacks_retry(slack: SlackFixture) -> None:
    ana = await slack.create_user(name="Ana")
    msg = await ana.say("@my-agent hello", to=slack.app)
    if msg.delivery is None:
        pytest.skip("live: the platform delivers to the agent itself")
    await msg.delivery.retry(after="3s", reason="http_timeout")
    await expect(msg.thread).to_have_replies_from(slack.app, count=1)
# @show:end
