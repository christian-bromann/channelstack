async def test_reject_leaves_the_keys_alone(slack):
    ana = await slack.create_user(name="Ana")
    channel = await slack.create_channel(participants=[ana, slack.app])

    msg = await ana.say("@robin rotate the staging keys", channel=channel)  # [!step 1]
    ask = await msg.thread.wait_for_reply(from_="robin")  # [!step 2]
    await ana.click("Reject", message=ask)  # [!step 3]

    await expect(msg.thread).to_contain_text("Okay, I left the keys alone.", count=1)  # [!step 4]
