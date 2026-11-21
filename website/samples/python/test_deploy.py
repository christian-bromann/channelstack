from pytest_channelstack import expect


async def test_ships_a_pr_from_a_slack_dm(slack):
    ana = await slack.create_user(name="ana")
    # [!step 1]
    msg = await ana.say("@robin ship #812 to staging",
                        to=slack.app)

    # [!step 2]
    await expect(msg.thread).to_have_status_text("checking CI")
    # [!step 3]
    ask = await msg.thread.wait_for_reply(from_="robin")
    await expect(ask).to_have_button("Approve")

    # [!step 4]
    await ana.click("Approve", message=ask)
    # [!step 5]
    await expect(msg.thread).to_contain_text("Deployed", count=1)
    await expect(msg.thread).not_to_contain_text("Thinking…")
