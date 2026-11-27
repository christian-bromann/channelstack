"""The Slack conversation tests of `test/acceptance/examples/slack.test.ts`, ported to pytest (exit check 7.3).

Each test reads like its Vitest original: the fixtures give the test its session and the Slack
fixture, and `expect(...)` checks what a person would see, with the matchers' semantics.
"""

import re
from pathlib import Path

from channelstack import SlackFixture
from pytest_channelstack import expect

# The Vitest examples' snapshots: the port holds the same transcript to the same snapshot.
SNAPSHOTS = Path(__file__).parents[1] / "examples" / "__snapshots__" / "slack.test.ts.snap"


def vitest_snapshot(name: str) -> str:
    """A string snapshot Vitest wrote for the test with this full name ("describe > test")."""
    found = re.search(r"exports\[`" + re.escape(name) + r' 1`\] = `\n"(.*?)"\n`;', SNAPSHOTS.read_text(), re.S)
    assert found, f"no Vitest snapshot for {name!r} in {SNAPSHOTS}"
    return found.group(1)


# Mentions and threads


async def test_a_mention_gets_exactly_one_reply_in_the_thread(slack: SlackFixture) -> None:
    ana = await slack.create_user(name="Ana")
    channel = await slack.create_channel(participants=[ana, slack.app])

    msg = await ana.say("@my-agent summarize yesterday's incidents", channel=channel)

    await expect(msg.thread).to_have_reply_from("my-agent", text=re.compile("incident", re.IGNORECASE))
    await expect(msg.thread).to_have_replies_from(slack.app, count=1)
    await expect(channel).not_to_have_channel_message_from("my-agent")


async def test_follow_ups_in_the_thread_are_answered_without_a_new_mention(slack: SlackFixture) -> None:
    ana = await slack.create_user(name="Ana")
    channel = await slack.create_channel(participants=[ana, slack.app])
    msg = await ana.say("@my-agent what's the status of the web deploy?", channel=channel)
    await msg.thread.wait_for_reply(from_="my-agent")

    await ana.reply("and the API?", thread=msg)

    answer = await msg.thread.wait_for_reply(from_="my-agent")
    assert re.search("api", answer.text, re.IGNORECASE)


async def test_a_channel_the_app_isnt_in_stays_silent_until_its_invited(slack: SlackFixture) -> None:
    ana = await slack.create_user(name="Ana", admin=True)
    channel = await slack.create_channel(participants=[ana])

    first = await ana.say("@my-agent are you here?", channel=channel)
    await expect(first.thread).not_to_have_reply_from("my-agent")

    await ana.invite(slack.app, channel=channel)
    second = await ana.say("@my-agent now?", channel=channel)
    await expect(second.thread).to_have_reply_from("my-agent")


async def test_it_ignores_its_own_messages_and_other_bots(slack: SlackFixture) -> None:
    deploy_bot = await slack.create_user(name="deploy-bot", bot=True)
    channel = await slack.create_channel(participants=[deploy_bot, slack.app])

    msg = await deploy_bot.say("@my-agent build #812 failed", channel=channel)

    await expect(msg.thread).not_to_have_reply_from("my-agent")


async def test_allowlisted_people_by_fixed_id(slack: SlackFixture) -> None:
    admin = await slack.create_user(name="Cara", id="U0ADMIN01")
    stranger = await slack.create_user(name="Dev")
    channel = await slack.create_channel(participants=[admin, stranger, slack.app])

    allowed = await admin.say("@my-agent rotate the API keys", channel=channel)
    refused = await stranger.say("@my-agent rotate the API keys", channel=channel)

    await expect(allowed.thread).to_have_reply_from("my-agent", text=re.compile("rotating", re.IGNORECASE))
    await expect(refused.thread).to_have_reply_from("my-agent", text=re.compile("not allowed", re.IGNORECASE))


# Direct messages


async def test_a_dm_to_the_app_gets_a_reply_in_the_dm(slack: SlackFixture) -> None:
    ana = await slack.create_user(name="Ana")

    msg = await ana.say("what's on my plate today?", to=slack.app)

    await expect(msg.conversation).to_have_reply_from("my-agent")
    await expect(msg.conversation).to_have_replies_from("my-agent", count=1)


async def test_a_group_dm_with_the_app_and_a_colleague(slack: SlackFixture) -> None:
    ana = await slack.create_user(name="Ana")
    ben = await slack.create_user(name="Ben")
    dm = await ana.open_dm([ben, slack.app])

    await ana.say("@my-agent schedule a review with Ben", channel=dm)

    reply = await dm.wait_for_message(from_="my-agent")
    assert "Ben" in reply.text


# Streaming, status and Stop


async def test_streams_a_reply_and_shows_a_status_while_working(slack: SlackFixture) -> None:
    ana = await slack.create_user(name="Ana")
    msg = await ana.say("write the release notes for 0.10", to=slack.app)

    await expect(msg.thread).to_have_status("working")
    await expect(msg.thread).to_have_status_text(re.compile("thinking", re.IGNORECASE))
    await expect(msg.thread).to_have_streaming_reply_from("my-agent")

    reply = await msg.thread.latest_reply(from_="my-agent")
    assert reply.stream is not None
    stream = await reply.stream.ended()
    assert stream.state == "completed"
    await expect(msg.thread).to_have_status("idle")


async def test_stop_ends_the_stream_and_the_agent_stays_quiet(slack: SlackFixture) -> None:
    ana = await slack.create_user(name="Ana")
    msg = await ana.say("write a long report on Q3", to=slack.app)
    await expect(msg.thread).to_have_streaming_reply_from("my-agent")

    await ana.stop(thread=msg)

    await expect(msg.thread).to_have_status("stopped")
    await expect(msg.thread).to_have_replies_from("my-agent", count=1)


# Reactions, edits and deletes


async def test_acknowledges_with_a_reaction_then_answers(slack: SlackFixture) -> None:
    ana = await slack.create_user(name="Ana")
    channel = await slack.create_channel(participants=[ana, slack.app])
    msg = await ana.say("@my-agent look at the failed build", channel=channel)

    await expect(msg).to_have_reaction("eyes", by=slack.app)
    await expect(msg.thread).to_have_reply_from("my-agent")


async def test_an_emoji_reaction_as_a_trigger(slack: SlackFixture) -> None:
    ana = await slack.create_user(name="Ana")
    ben = await slack.create_user(name="Ben")
    channel = await slack.create_channel(participants=[ana, ben, slack.app])
    report = await ben.say("login is broken on Safari", channel=channel)

    await ana.react("ticket", message=report)

    await expect(report.thread).to_have_reply_from("my-agent", text=re.compile(r"ENG-\d+"))


async def test_editing_the_question_doesnt_produce_a_second_answer(slack: SlackFixture) -> None:
    ana = await slack.create_user(name="Ana")
    channel = await slack.create_channel(participants=[ana, slack.app])
    msg = await ana.say("@my-agent what's our uptime?", channel=channel)
    await msg.thread.wait_for_reply(from_="my-agent")

    await ana.edit("@my-agent what's our uptime this month?", message=msg)

    await expect(msg.thread).to_have_replies_from("my-agent", count=1)


# Inspecting what the agent did


async def test_api_calls_and_errors(slack: SlackFixture) -> None:
    ana = await slack.create_user(name="Ana")
    channel = await slack.create_channel(participants=[ana, slack.app])
    await ana.say("@my-agent hi", channel=channel)

    post = await slack.wait_for_call(operation="chat.postMessage")
    assert post.response_status == 200
    await expect(slack).not_to_have_received_call(re.compile(".*"), error="not_in_channel")
    assert await slack.calls(error=True) == []


async def test_a_transcript_snapshot_reads_like_the_conversation(slack: SlackFixture) -> None:
    ana = await slack.create_user(name="Ana")
    msg = await ana.say("what's 2 + 2?", to=slack.app)
    await msg.thread.latest_reply(from_="my-agent")

    transcript = await msg.thread.transcript()
    assert str(transcript) == vitest_snapshot(
        "inspecting what the agent did > a transcript snapshot reads like the conversation"
    )
