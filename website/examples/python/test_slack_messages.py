from channelstack import SlackFixture


async def test_what_people_write_in_slack(slack: SlackFixture) -> None:
    ana = await slack.create_user(name="Ana")
    channel = await slack.create_channel(participants=[ana, slack.app])
    # @show:start
    msg = await ana.say("@my-agent what's the status of the web deploy?", channel=channel)
    await msg.thread.wait_for_reply(from_="my-agent")

    await ana.reply("and the API?", thread=msg)
    await ana.edit("@my-agent what's the status of the web deploy today?", message=msg)
    await ana.react("ticket", message=msg)
    await ana.delete(message=msg)
    # @show:end
