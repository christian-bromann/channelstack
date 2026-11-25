import re

from channelstack import SlackFixture
from pytest_channelstack import expect


# @show:start
async def test_a_slash_command_is_acknowledged_within_3_seconds(slack: SlackFixture) -> None:
    ana = await slack.create_user(name="Ana")
    channel = await slack.create_channel(participants=[ana, slack.app])

    command = await ana.run_command("/deploy web staging", channel=channel)

    await expect(command).to_be_accepted(within="3s")
    await expect(channel).to_contain_text(re.compile("deploying web to staging", re.I))
# @show:end
