from channelstack import SlackFixture
from pytest_channelstack import expect


# @show:start
async def test_backs_off_on_rate_limits_and_still_answers(slack: SlackFixture) -> None:
    ana = await slack.create_user(name="Ana")
    fault = await slack.fault(type="rate_limit", operation="chat.postMessage", retry_after="1s", times=1)

    msg = await ana.say("hi", to=slack.app)

    await expect(msg.thread).to_have_replies_from("my-agent", count=1)
    await expect(slack).to_have_received_call("chat.postMessage", times=2)
    await fault.undo()
# @show:end
