from channelstack import SlackFixture
from pytest_channelstack import expect


# @show:start
async def test_a_real_person_asks_the_real_agent(slack: SlackFixture) -> None:
    ana = await slack.create_user(name="Ana")
    channel = await slack.create_channel(participants=[ana, slack.app])

    msg = await ana.say("@my-agent summarize #support today", channel=channel)

    await expect(msg.thread).to_have_reply_from("my-agent", timeout="30s")
# @show:end
