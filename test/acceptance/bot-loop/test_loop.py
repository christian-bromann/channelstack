"""Run by `../plugin-defaults.test.ts`, and meant to fail: the pytest port of `loop.test.ts`.

Two apps answer each other in a thread with no person between them, past the loop guard's 50
messages (decision 0027). The test checks nothing itself; its fixture fails it at teardown,
naming the loop the fake stopped.
"""

from channelstack import SlackFixture


async def test_two_apps_that_answer_each_other_without_end(slack: SlackFixture) -> None:
    ping = await slack.create_app(name="loop-ping")
    pong = await slack.create_app(name="loop-pong")
    ana = await slack.create_user(name="Ana")
    channel = await slack.create_channel(participants=[ana, ping, pong])
    msg = await ana.say("@loop-ping @loop-pong talk it over", channel=channel)
    for _ in range(26):
        await ping.reply("@loop-pong over to you", thread=msg.thread)
        await pong.reply("@loop-ping over to you", thread=msg.thread)
