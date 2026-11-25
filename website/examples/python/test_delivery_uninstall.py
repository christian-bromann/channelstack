from channelstack import SlackFixture
from pytest_channelstack import expect


# @show:start
async def test_the_uninstall_is_handled(slack: SlackFixture) -> None:
    deliveries = await slack.uninstall_app()
    for delivery in deliveries:
        await expect(delivery).to_be_accepted()
# @show:end
