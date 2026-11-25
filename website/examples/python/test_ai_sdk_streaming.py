# @show:start
import re

from channelstack import SlackFixture
from pytest_channelstack import expect


async def test_streams_a_reply_and_shows_a_status_while_working(slack: SlackFixture) -> None:
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


async def test_stop_ends_the_stream_and_the_agent_stays_quiet(slack: SlackFixture) -> None:
    ana = await slack.create_user(name="Ana")
    msg = await ana.say("write a long report on Q3", to=slack.app)
    await expect(msg.thread).to_have_streaming_reply_from("my-agent")

    await ana.stop(thread=msg)

    await expect(msg.thread).to_have_status("stopped")
    await expect(msg.thread).to_have_replies_from("my-agent", count=1)
# @show:end
