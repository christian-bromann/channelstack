from channelstack import GitHubDelivery, GitHubFixture
from channelstack.runtime.wait import wait_for


async def test_live_the_apps_delivery_log(github: GitHubFixture) -> None:
    ana = await github.create_user(login="ana")
    repo = await github.create_repo(collaborators=[ana], apps=[github.app])
    issue = await ana.open_issue({"title": "Hello?"}, repo=repo)
    await ana.comment("@my-agent ping", issue=issue)
    # @show:start
    # pytest has no expect.poll: the SDK's own polling loop reads until there is something.
    async def logged() -> list[GitHubDelivery] | None:
        return await github.deliveries(type="issue_comment", resource=repo) or None

    await wait_for("an issue_comment delivery in the App's log", logged, timeout="30s")
    # @show:end
