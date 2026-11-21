from pytest_channelstack import expect


async def test_ships_a_pr_from_a_slack_dm(slack):
    ana = await slack.create_user(name="ana")
    msg = await ana.say("@robin ship #812 to staging",  # [!step 1]
                        to=slack.app)  # [!step 1]

    await expect(msg.thread).to_have_status_text("checking CI")  # [!step 2]
    ask = await msg.thread.wait_for_reply(from_="robin")  # [!step 3]
    await expect(ask).to_have_button("Approve")  # [!step 3]

    await ana.click("Approve", message=ask)  # [!step 4]
    await expect(msg.thread).to_contain_text("Deployed", count=1)  # [!step 5]
    await expect(msg.thread).not_to_contain_text("Thinking…")  # [!step 5]
