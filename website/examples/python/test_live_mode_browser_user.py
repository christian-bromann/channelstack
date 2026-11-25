from channelstack import SlackFixture


async def test_a_person_signed_in_with_a_saved_browser_session(slack: SlackFixture) -> None:
    # @show:start
    ana = await slack.create_user(name="Ana", browser={"storageState": ".auth/ana-slack.json"})
    # @show:end
    _ = ana
