# @show:start
import re

from channelstack import OpenAIFixture, OpenAITiming, OpenAIToolCallSpec, OpenAITurn, SlackFixture
from pytest_channelstack import expect


async def test_streams_the_answer_into_the_dm_and_the_status_clears(slack: SlackFixture, openai: OpenAIFixture) -> None:
    await openai.respond(
        OpenAITurn(text=["The web deploy", " failed at", " the migration", " step."]),
        timing=OpenAITiming(first_token="700ms", between_chunks="250ms"),
    )
    ana = await slack.create_user(name="Ana")
    msg = await ana.say("why did the deploy fail?", to=slack.app)

    await expect(msg.thread).to_have_status("working")
    await expect(msg.thread).to_have_status_text(re.compile("thinking", re.I))
    await expect(msg.thread).to_have_streaming_reply_from("my-agent")
    await expect(msg.thread).to_have_status("idle")
    await expect(msg.thread).to_have_reply_from("my-agent", text=re.compile("failed at the migration step"))
    await expect(openai).to_have_sent(msg)


async def test_the_agent_runs_the_tool_the_model_calls_and_answers_from_its_result(
    slack: SlackFixture, openai: OpenAIFixture
) -> None:
    ai = await openai.respond(
        [
            OpenAITurn(tool_calls=[OpenAIToolCallSpec(name="search_incidents", arguments={"since": "yesterday"})]),
            "Two incidents yesterday: the web deploy and a DNS blip.",
        ]
    )
    ana = await slack.create_user(name="Ana")
    msg = await ana.say("what broke yesterday?", to=slack.app)

    await expect(msg.thread).to_have_reply_from("my-agent", text=re.compile("DNS blip"))
    await expect(msg.thread).to_have_replies_from("my-agent", count=1)
    await expect(ai).to_have_answered(times=2)
    await expect(ai).to_have_sent_tool_result("search_incidents", text=re.compile("migration"))
# @show:end
