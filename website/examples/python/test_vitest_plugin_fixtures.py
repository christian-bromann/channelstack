# @show:start
from channelstack import SlackFixture
from pytest_channelstack import expect


async def test_answers_in_the_thread(slack: SlackFixture) -> None:
    ana = await slack.create_user(name="Ana")
    channel = await slack.create_channel(participants=[ana, slack.app])
    msg = await ana.say("@my-agent hi", channel=channel)
    await expect(msg.thread).to_have_reply_from("my-agent")
    # pytest-channelstack has no quiet() fixture: latest_reply waits until the agent is quiet.
    await msg.thread.latest_reply(from_="my-agent")
# @show:end
