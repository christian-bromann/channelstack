# channelstack for Python

The Python SDK of [channelstack](https://channelstack.dev), a test harness for the apps and agents you build for Slack, GitHub, Linear, Notion, Resend, Gmail and Discord. channelstack runs fake versions of those platforms on your machine, and of OpenAI's API for your agent's model. Your code scripts the people, your app answers through its real code path, and you check what a person would see.

For tests, use [pytest-channelstack](https://pypi.org/project/pytest-channelstack/), which is built on this SDK.

## Install

```bash
pip install channelstack
```

It needs Python 3.12 or later. The SDK doesn't bundle the server. It finds it at `CHANNELSTACK_SERVER_BIN`, or as `channelstack` on the `PATH`: install it with `npm i -g channelstack`, or download it from the [GitHub releases](https://github.com/christian-bromann/channelstack/releases).

## Example

```python
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
```

## Links

- [Documentation](https://channelstack.dev/docs), and [the SDKs](https://channelstack.dev/docs/reference/sdks)
- [Source, issues and changelog](https://github.com/christian-bromann/channelstack)

MIT licensed.
