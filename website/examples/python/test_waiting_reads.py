from channelstack import SlackFixture


async def test_wait_for_and_latest(slack: SlackFixture) -> None:
    ana = await slack.create_user(name="Ana")
    ben = await slack.create_user(name="Ben", admin=True)
    channel = await slack.create_channel(participants=[ana, ben, slack.app])
    msg = await ana.say("@my-agent deploy web to staging", channel=channel)
    # @show:start
    # The next new reply from the agent: returns as soon as one arrives.
    answer = await msg.thread.wait_for_reply(from_="my-agent")

    # The agent's last reply, once it's done: waits for at least one, then for quiet.
    ask = await msg.thread.latest_reply(from_="my-agent")
    await ben.click("Approve", message=ask)
    # @show:end
    _ = answer
