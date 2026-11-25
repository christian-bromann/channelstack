from channelstack import GitHubFixture, SlackFixture
from pytest_channelstack import expect


async def test_a_checks_own_timeout_and_quiet_for(slack: SlackFixture, github: GitHubFixture) -> None:
    ana = await slack.create_user(name="Ana")
    msg = await ana.say("@my-agent hi", to=slack.app)
    ben = await github.create_user(login="ben")
    repo = await github.create_repo(collaborators=[ben], apps=[github.app])
    issue = await ben.open_issue({"title": "Flaky test"}, repo=repo)
    await ben.comment("@my-agent investigate", issue=issue)
    # @show:start
    await expect(issue).to_have_comments_from(github.app, count=1, quiet_for="2s")
    await expect(msg.thread).to_have_reply_from("my-agent", timeout="30s")
    # @show:end
