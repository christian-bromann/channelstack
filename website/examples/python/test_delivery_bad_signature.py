from channelstack import SlackFixture
from pytest_channelstack import expect


# @show:start
async def test_rejects_a_bad_signature_and_a_stale_timestamp(slack: SlackFixture) -> None:
    ana = await slack.create_user(name="Ana")
    msg = await ana.say("hi", to=slack.app)
    assert msg.delivery

    await msg.delivery.resend(bad_signature=True)
    await expect(msg.delivery).to_be_rejected()

    await msg.delivery.resend(stale=True)
    await expect(msg.delivery).to_be_rejected()
# @show:end
