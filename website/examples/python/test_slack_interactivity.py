import re

from channelstack import SlackFixture


async def test_buttons_menus_modals_commands_and_shortcuts(slack: SlackFixture) -> None:
    ana = await slack.create_user(name="Ana")
    ben = await slack.create_user(name="Ben", admin=True)
    channel = await slack.create_channel(participants=[ana, ben, slack.app])
    msg = await ana.say("@my-agent deploy web", channel=channel)
    report = await ana.say("Checkout is down for some people", channel=channel)
    # @show:start
    ask = await msg.thread.latest_reply(from_="my-agent")
    await ben.click("Approve", message=ask)

    await ana.select("staging", menu="Environment", message=ask)

    await ana.click("Open form", thread=msg.thread)
    modal = await ana.wait_for_modal(title=re.compile("incident", re.I))
    await modal.submit({"Severity": "SEV2", "Summary": "Checkout errors"})

    await ana.run_command("/deploy web staging", channel=channel)
    await ana.shortcut("create_ticket", message=report)
    # @show:end
