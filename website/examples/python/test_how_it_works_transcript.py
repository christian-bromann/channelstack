from channelstack import SlackFixture


async def test_the_transcript_a_person_reads(slack: SlackFixture) -> None:
    ana = await slack.create_user(name="Ana")
    # @show:start
    msg = await ana.say("what's 2 + 2?", to=slack.app)
    await msg.thread.latest_reply(from_="my-agent")

    transcript = await msg.thread.transcript()
    # pytest has no snapshots of its own: compare with the conversation as a person reads it.
    assert str(transcript) == "Ana: what's 2 + 2?\n  my-agent: 2 + 2 is 4."
    # @show:end
