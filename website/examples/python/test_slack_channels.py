from channelstack import SlackFixture


async def test_the_channels_a_slack_test_creates(slack: SlackFixture) -> None:
    ana = await slack.create_user(name="Ana")
    ben = await slack.create_user(name="Ben", admin=True)
    # @show:start
    channel = await slack.create_channel(participants=[ana, ben, slack.app])
    incidents = await slack.create_channel(name="incidents", private=True, participants=[ana, slack.app])
    # @show:end
    _ = (channel, incidents)
