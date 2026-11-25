from channelstack import SlackFixture


async def test_the_people_a_slack_test_creates(slack: SlackFixture) -> None:
    # @show:start
    ana = await slack.create_user(name="Ana")
    ben = await slack.create_user(name="Ben", admin=True)
    deploy_bot = await slack.create_user(name="deploy-bot", bot=True)
    cara = await slack.create_user(name="Cara", id="U0ADMIN01")
    # @show:end
    _ = (ana, ben, deploy_bot, cara)
