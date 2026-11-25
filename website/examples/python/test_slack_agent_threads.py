from channelstack import SlackFixture


async def test_the_agents_split_view(slack: SlackFixture) -> None:
    ana = await slack.create_user(name="Ana")
    incidents = await slack.create_channel(name="incidents", participants=[ana, slack.app])
    general = await slack.create_channel(name="general", participants=[ana, slack.app])
    # @show:start
    thread = await ana.open_agent_thread(from_=incidents)
    prompts = await thread.suggested_prompts()

    await ana.pick_prompt("What changed?", thread=thread)
    await ana.switch_context(general, thread=thread)
    await ana.reply("summarize this channel", thread=thread)
    # @show:end
    _ = prompts
