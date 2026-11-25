from channelstack import GitHubFixture, LinearFixture, NotionFixture, SlackFixture


async def test_people_act_resources_are_read(
    slack: SlackFixture, github: GitHubFixture, linear: LinearFixture, notion: NotionFixture
) -> None:
    ana = await slack.create_user(name="Ana")
    ben = await slack.create_user(name="Ben", admin=True)
    channel = await slack.create_channel(participants=[ana, ben, slack.app])
    asked = await ana.say("@my-agent deploy web to staging", channel=channel)
    reply = await asked.thread.latest_reply(from_="my-agent")
    cara = await github.create_user(login="cara")
    repo = await github.create_repo(collaborators=[cara], apps=[github.app])
    pr = await cara.open_pull_request({"from": "fix-login", "changes": {"src/login.ts": "export {};\n"}}, repo=repo)
    dev = await linear.create_user(name="Dev")
    team = await linear.create_team(members=[dev])
    issue = await dev.create_issue({"title": "Checkout fails on Safari"}, team=team)
    eve = await notion.create_user(name="Eve")
    page = await notion.create_page(title="Roadmap", connections=[notion.app])
    discussion = (await eve.comment("@my-agent summarize this page", page=page)).discussion
    # @show:start
    await ana.say("@my-agent deploy web", channel=channel)
    await ben.click("Approve", message=reply)
    await cara.comment("@my-agent fix this", issue=pr)
    await dev.delegate(linear.app, issue=issue)
    await eve.reply("thanks!", discussion=discussion)
    # @show:end
