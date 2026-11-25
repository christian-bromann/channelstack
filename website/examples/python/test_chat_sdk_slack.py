# @show:start
import re

from channelstack import SlackFixture
from pytest_channelstack import expect


async def test_a_mention_gets_one_reply_in_the_thread(slack: SlackFixture) -> None:
    ana = await slack.create_user(name="Ana")
    channel = await slack.create_channel(participants=[ana, slack.app])

    msg = await ana.say("@my-agent summarize the incidents", channel=channel)

    await expect(msg.thread).to_have_reply_from("my-agent", text=re.compile("summarize the incidents"))
    await expect(msg.thread).to_have_replies_from(slack.app, count=1)
    await expect(channel).not_to_have_channel_message_from("my-agent")


async def test_follow_ups_in_the_thread_are_answered_without_a_new_mention(slack: SlackFixture) -> None:
    ana = await slack.create_user(name="Ana")
    channel = await slack.create_channel(participants=[ana, slack.app])
    msg = await ana.say("@my-agent what's the status of the web deploy?", channel=channel)
    await expect(msg.thread).to_have_reply_from("my-agent")

    await ana.reply("and the API?", thread=msg)

    await expect(msg.thread).to_have_reply_from("my-agent", text=re.compile("and the API"))
# @show:end
