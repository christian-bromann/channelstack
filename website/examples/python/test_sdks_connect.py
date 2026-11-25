# @show:start
import asyncio

from channelstack import connect


async def main() -> None:
    async with await connect(mode="auto") as client:
        async with await client.open_session(name="example") as session:
            slack = await session.slack()
            ana = await slack.create_user(name="Ana")
            channel = await slack.create_channel(participants=[ana, slack.app])

            msg = await ana.say("@my-agent hi", channel=channel)
            reply = await msg.thread.wait_for_reply(from_="my-agent")
            print(reply.text)


if __name__ == "__main__":
    asyncio.run(main())
# @show:end
