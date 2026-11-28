# @show:start
import re

from channelstack import OpenAIFixture, OpenAITiming, OpenAITurn, SlackFixture
from pytest_channelstack import expect

# What the model streams, a piece at a time.
NOTES = [
    "# Release notes for 0.10\n\n",
    "## What changed\n\nThe delivery queue now retries a slow acknowledgement the way the platform does.\n\n",
    "## What to do\n\nUpdate, run the tests once and read the new failure messages.\n\n",
    "## Thanks\n\nTo everyone who sent the transcript of a conversation that went wrong.\n",
]


async def test_streams_a_reply_and_shows_a_status_while_working(slack: SlackFixture, openai: OpenAIFixture) -> None:
    await openai.respond(OpenAITurn(text=NOTES), timing=OpenAITiming(first_token="700ms", between_chunks="250ms"))
    ana = await slack.create_user(name="Ana")
    msg = await ana.say("write the release notes for 0.10", to=slack.app)

    await expect(msg.thread).to_have_status("working")
    await expect(msg.thread).to_have_status_text(re.compile("thinking", re.I))
    await expect(msg.thread).to_have_streaming_reply_from("my-agent")
    await expect(msg.thread).to_have_status("idle")

    reply = await msg.thread.latest_reply(from_="my-agent")
    assert reply.stream
    stream = await reply.stream.ended()
    assert stream.state == "completed"
    await expect(openai).to_have_sent(msg)


async def test_stop_ends_the_stream_and_cancels_the_model(slack: SlackFixture, openai: OpenAIFixture) -> None:
    ai = await openai.respond(OpenAITurn(text="More detail, for those who asked. " * 40, pause_after=3))
    ana = await slack.create_user(name="Ana")
    msg = await ana.say("write a long report on Q3", to=slack.app)
    call = await ai.wait_for_pause()
    await expect(msg.thread).to_have_streaming_reply_from("my-agent")

    await ana.stop(thread=msg)

    await expect(msg.thread).to_have_status("stopped")
    await expect(msg.thread).to_have_replies_from("my-agent", count=1)
    await expect(call).to_be_aborted()
# @show:end
