"""The fake OpenAI from pytest (exit check 13.6): a tool loop scripted as turns, and a responder.

`scripts/accept.ts` runs this file against the agent on the official `openai` SDK, after the
Vitest examples of `test/acceptance/examples/openai.test.ts`.
"""

import base64
import re
from pathlib import Path

import httpx

from channelstack import (
    Channelstack,
    OpenAIFixture,
    OpenAIMatch,
    OpenAIRequest,
    OpenAIToolCallSpec,
    OpenAITurn,
    Session,
    SlackFixture,
)
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


async def test_an_image_given_as_a_path_is_served_byte_for_byte(
    channelstack: Channelstack, channelstack_session: Session, openai: OpenAIFixture
) -> None:
    """Exit check 14.5, in Python: a `MediaSource` path is read in the test process, and the fake serves those bytes.

    The test plays the agent, calling the Images API as the official SDK does, tagged with its session.
    """
    key = (await channelstack.env())["OPENAI_API_KEY"]
    await openai.respond(
        OpenAITurn(image="../examples/fixtures/chart.png"), when=OpenAIMatch(endpoint="images.generations")
    )

    async with httpx.AsyncClient() as client:
        response = await client.post(
            f"{openai.base_url}/images/generations",
            headers={"authorization": f"Bearer {key}"},
            json={"model": "gpt-image-1", "prompt": "this week's deploys", "user": channelstack_session.session_id},
        )

    assert response.status_code == 200, response.text
    served = base64.b64decode(response.json()["data"][0]["b64_json"])
    assert served == (Path(__file__).parent.parent / "examples" / "fixtures" / "chart.png").read_bytes()
