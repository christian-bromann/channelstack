# @show:start
import asyncio

from channelstack import connect


async def main() -> None:
    async with await connect(mode="attach") as client:
        async with await client.open_session() as session:
            slack = await session.slack()
            ana = await slack.create_user(name="Ana")
            msg = await ana.say("hi", to=slack.app)
            reply = await msg.thread.wait_for_reply(from_="my-agent")
            print(reply.text)
        # The session closes here, and removes Ana and the DM.


if __name__ == "__main__":
    asyncio.run(main())
# @show:end
