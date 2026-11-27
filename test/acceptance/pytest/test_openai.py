"""The fake OpenAI from pytest (exit check 13.6): a tool loop scripted as turns, and a responder.

`scripts/accept.ts` runs this file against the agent on the official `openai` SDK, after the
Vitest examples of `test/acceptance/examples/openai.test.ts`.
"""

import re

from channelstack import OpenAIFixture, OpenAIRequest, OpenAIToolCallSpec, OpenAITurn, SlackFixture
from pytest_channelstack import expect


async def test_a_tool_loop_ends_in_one_answer_in_the_thread(slack: SlackFixture, openai: OpenAIFixture) -> None:
    ana = await slack.create_user(name="Ana")
    channel = await slack.create_channel(participants=[ana, slack.app])
    ai = await openai.respond(
        [
            OpenAITurn(tool_calls=[OpenAIToolCallSpec(name="search_incidents", arguments={"since": "yesterday"})]),
            "Two incidents yesterday: the web deploy and a DNS blip.",
        ]
    )

    msg = await ana.say("@my-agent what broke yesterday?", channel=channel)

    await expect(msg.thread).to_have_reply_from("my-agent", text=re.compile("DNS blip"))
    await expect(msg.thread).to_have_replies_from("my-agent", count=1)
    await expect(ai).to_have_answered(times=2)
    await expect(ai).to_have_sent_tool_result("search_incidents", text=re.compile("migration"))


async def test_a_responder_computes_the_answer_from_what_the_agent_sent(
    slack: SlackFixture, openai: OpenAIFixture
) -> None:
    ana = await slack.create_user(name="Ana")
    channel = await slack.create_channel(participants=[ana, slack.app])

    async def answer(request: OpenAIRequest) -> str:
        people = [message for message in request.messages if message.role == "user"]
        return f"I can see {len(people)} messages from you."

    await openai.respond(answer)

    msg = await ana.say("@my-agent the deploy failed", channel=channel)
    await msg.thread.wait_for_reply(from_="my-agent")
    await ana.reply("it's the migration step", thread=msg)

    await expect(msg.thread).to_have_reply_from("my-agent", text=re.compile("2 messages"))
    await expect(openai).to_have_sent([msg])
    await expect(openai).not_to_have_sent_secrets()
