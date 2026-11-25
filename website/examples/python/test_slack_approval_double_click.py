# @show:start
import re

from channelstack import SlackFixture
from pytest_channelstack import expect


async def test_approval_buttons_act_once_even_on_a_double_click(slack: SlackFixture) -> None:
    ana = await slack.create_user(name="Ana")
    ben = await slack.create_user(name="Ben", admin=True)
    channel = await slack.create_channel(participants=[ana, ben, slack.app])
    msg = await ana.say("@my-agent deploy web to staging", channel=channel)

    ask = await msg.thread.latest_reply(from_="my-agent")
    await expect(ask).to_have_button("Approve")

    await ben.click("Approve", message=ask)
    await ben.click("Approve", message=ask)

    await expect(msg.thread).to_contain_text("Deploying", count=1)
    await expect(slack).not_to_have_received_call(re.compile(".*"), error="not_in_channel")
# @show:end
