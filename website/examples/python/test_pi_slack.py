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


async def test_it_ignores_other_bots(slack: SlackFixture) -> None:
    deploy_bot = await slack.create_user(name="deploy-bot", bot=True)
    channel = await slack.create_channel(participants=[deploy_bot, slack.app])

    msg = await deploy_bot.say("@my-agent build #812 failed", channel=channel)

    await expect(msg.thread).not_to_have_reply_from("my-agent")
# @show:end
