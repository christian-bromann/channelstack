from channelstack import GitHubFixture, LinearFixture, SlackFixture


async def test_what_each_action_resolves_to(slack: SlackFixture, github: GitHubFixture, linear: LinearFixture) -> None:
    ana = await slack.create_user(name="Ana")
    channel = await slack.create_channel(participants=[ana, slack.app])
    ben = await github.create_user(login="ben")
    repo = await github.create_repo(collaborators=[ben], apps=[github.app])
    issue = await ben.open_issue({"title": "Flaky test"}, repo=repo)
    mo = await linear.create_user(name="Mo")
    team = await linear.create_team(members=[mo])
    ticket = await mo.create_issue({"title": "Checkout fails on Safari"}, team=team)
    # @show:start
    msg = await ana.say("@my-agent hi", channel=channel)
    msg.delivery  # the app_mention event_callback

    comment = await ben.comment("@my-agent investigate", issue=issue)
    comment.delivery  # the issue_comment webhook

    session = await mo.delegate(linear.app, issue=ticket)
    session.delivery  # the AgentSessionEvent that opened the session

    command = await ana.run_command("/deploy web staging", channel=channel)
    # a slash command, click, shortcut or modal submission resolves to its delivery
    # @show:end
    _ = command
