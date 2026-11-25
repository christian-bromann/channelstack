from channelstack import GitHubFixture


async def test_what_people_do_on_an_issue(github: GitHubFixture) -> None:
    ana = await github.create_user(login="ana")
    ben = await github.create_user(login="ben")
    repo = await github.create_repo(collaborators=[ana, ben], labels=["bug", "agent:fix"], apps=[github.app])
    # @show:start
    issue = await ana.open_issue({"title": "Typo in the README", "labels": ["bug"]}, repo=repo)

    await ana.comment("@my-agent is this a duplicate?", issue=issue)
    await ana.label("agent:fix", issue=issue)
    await ana.assign([ben], issue=issue)
    await ana.edit_issue({"title": "Typo in README.md"}, issue=issue)
    await ana.close(issue=issue)
    # @show:end
