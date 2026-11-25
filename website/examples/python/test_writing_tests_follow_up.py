import re

from channelstack import SlackFixture


async def test_a_follow_up_in_the_thread(slack: SlackFixture) -> None:
    ana = await slack.create_user(name="Ana")
    channel = await slack.create_channel(participants=[ana, slack.app])
    # @show:start
    msg = await ana.say("@my-agent what's the status of the web deploy?", channel=channel)
    await msg.thread.wait_for_reply(from_="my-agent")

    await ana.reply("and the API?", thread=msg)

    answer = await msg.thread.wait_for_reply(from_="my-agent")
    assert re.search("api", answer.text, re.I)
    # @show:end
