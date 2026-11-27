from channelstack import DiscordFixture
from pytest_channelstack import expect


async def test_answers_a_mention_once_quoting_it(discord: DiscordFixture):
    ana = await discord.create_user(name="Ana")
    channel = await discord.create_channel(name="support", participants=[ana, discord.app])
    # [!step 1]
    msg = await ana.say("@my-agent why is the build red?", channel=channel)

    # [!step 2]
    answer = await msg.wait_for_reply(from_="my-agent")
    # [!step 3]
    assert answer.reply_to == msg.id
    # [!step 4]
    await expect(msg).to_have_replies_from("my-agent", count=1)
