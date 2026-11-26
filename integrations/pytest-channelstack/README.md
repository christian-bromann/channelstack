# pytest-channelstack

pytest fixtures and `expect(...)` checks for [channelstack](https://channelstack.dev), a test harness for the apps and agents you build for Slack, GitHub, Linear, Notion, Resend and Gmail. You get a fixture per platform, one session per test, and checks that wait for your app the way a person would.

## Install

```bash
pip install pytest-channelstack
npm i -g channelstack
```

It needs Python 3.12 or later, and installs the `channelstack` Python SDK, pytest and pytest-asyncio with it. It registers itself as a pytest plugin, so there is nothing to import in `conftest.py`. The server comes from npm (or the [GitHub releases](https://github.com/christian-bromann/channelstack/releases)); start it with `channelstack`.

## A first test

```python
import re

from channelstack import SlackFixture
from pytest_channelstack import expect


async def test_a_mention_gets_one_reply_in_the_thread(slack: SlackFixture) -> None:
    ana = await slack.create_user(name="Ana")
    channel = await slack.create_channel(participants=[ana, slack.app])

    msg = await ana.say("@my-agent summarize the incidents", channel=channel)

    await expect(msg.thread).to_have_reply_from("my-agent", text=re.compile("summarize the incidents"))
    await expect(msg.thread).to_have_replies_from(slack.app, count=1)
    await expect(channel).not_to_have_channel_message_from("my-agent")
```

Every test and fixture runs on one event loop, which pytest-asyncio's settings set up. [The pytest guide](https://channelstack.dev/docs/guide/pytest) has the configuration and the rest.

## Links

- [Documentation](https://channelstack.dev/docs)
- [Source, issues and changelog](https://github.com/christian-bromann/channelstack)

MIT licensed.
