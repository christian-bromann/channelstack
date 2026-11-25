from channelstack import GitHubFixture


async def test_the_app_hears_about_a_repository_once_its_installed(github: GitHubFixture) -> None:
    ana = await github.create_user(login="ana")
    # @show:start
    repo = await github.create_repo(collaborators=[ana])  # not installed
    issue = await ana.open_issue({"title": "Hello?"}, repo=repo)
    comment = await ana.comment("@my-agent ping", issue=issue)
    assert comment.delivery is None

    await repo.install_app(github.app)  # sends installation_repositories
    # @show:end
