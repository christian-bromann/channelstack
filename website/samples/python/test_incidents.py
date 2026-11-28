import re

from channelstack import OpenAIFixture, OpenAIToolCallSpec, OpenAITurn, SlackFixture
from pytest_channelstack import expect


async def test_answers_from_a_tool_call_once(slack: SlackFixture, openai: OpenAIFixture):
    ana = await slack.create_user(name="Ana")
    channel = await slack.create_channel(name="ops", participants=[ana, slack.app])
    ai = await openai.respond(
        [
            OpenAITurn(tool_calls=[OpenAIToolCallSpec(name="search_incidents", arguments={"since": "yesterday"})]),
            "Two incidents yesterday: the web deploy and a DNS blip.",
        ]
    )
    # [!step 1]
    msg = await ana.say("@my-agent what broke yesterday?", channel=channel)

    # [!step 2]
    await expect(ai).to_have_offered_tool("search_incidents")
    # [!step 3]
    await expect(ai).to_have_sent_tool_result("search_incidents", text=re.compile("migration"))
    # [!step 4]
    await expect(msg.thread).to_have_reply_from("my-agent", text=re.compile("DNS blip"))
    # [!step 5]
    await expect(msg.thread).to_have_replies_from("my-agent", count=1)
    await expect(ai).to_have_answered(times=2)
    await expect(openai).not_to_have_sent_secrets()
