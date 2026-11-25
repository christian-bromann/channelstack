from channelstack import SlackFixture


async def test_a_transcript_snapshot(slack: SlackFixture) -> None:
    ana = await slack.create_user(name="Ana")
    msg = await ana.say("what's 2 + 2?", to=slack.app)
    await msg.thread.latest_reply(from_="my-agent")
    # @show:start
    transcript = await msg.thread.transcript()
    # pytest has no snapshots of its own: compare with the conversation as a person reads it.
    assert str(transcript) == "Ana: what's 2 + 2?\n  my-agent: 2 + 2 is 4."
    # @show:end
