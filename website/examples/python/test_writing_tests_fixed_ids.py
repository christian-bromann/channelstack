import re

from channelstack import SlackFixture
from pytest_channelstack import expect


# @show:start
async def test_allowlisted_people_by_fixed_id(slack: SlackFixture) -> None:
    admin = await slack.create_user(name="Cara", id="U0ADMIN01")
    stranger = await slack.create_user(name="Dev")
    channel = await slack.create_channel(participants=[admin, stranger, slack.app])

    allowed = await admin.say("@my-agent rotate the API keys", channel=channel)
    refused = await stranger.say("@my-agent rotate the API keys", channel=channel)

    await expect(allowed.thread).to_have_reply_from("my-agent", text=re.compile("rotating", re.I))
    await expect(refused.thread).to_have_reply_from("my-agent", text=re.compile("not allowed", re.I))
# @show:end
