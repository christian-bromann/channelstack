from channelstack import SlackFixture
from pytest_channelstack import expect


# @show:start
async def test_a_channel_the_app_isnt_in_stays_silent_until_its_invited(slack: SlackFixture) -> None:
    ana = await slack.create_user(name="Ana", admin=True)
    channel = await slack.create_channel(participants=[ana])

    first = await ana.say("@my-agent are you here?", channel=channel)
    await expect(first.thread).not_to_have_reply_from("my-agent")

    await ana.invite(slack.app, channel=channel)
    second = await ana.say("@my-agent now?", channel=channel)
    await expect(second.thread).to_have_reply_from("my-agent")
# @show:end
