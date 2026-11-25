from channelstack import GitHubFixture
from pytest_channelstack import expect


async def test_a_redelivered_webhook_is_answered_once(github: GitHubFixture) -> None:
    ana = await github.create_user(login="ana")
    repo = await github.create_repo(collaborators=[ana], apps=[github.app])
    issue = await ana.open_issue({"title": "Flaky test"}, repo=repo)
    # @show:start
    comment = await ana.comment("@my-agent investigate", issue=issue)
    await expect(issue).to_have_comment_from(github.app)

    assert comment.delivery
    await comment.delivery.redeliver()
    await expect(issue).to_have_comments_from(github.app, count=1, quiet_for="2s")
    # @show:end
