from channelstack import GitHubFixture


async def test_a_repository_with_files_collaborators_labels_and_the_app(github: GitHubFixture) -> None:
    ana = await github.create_user(login="ana")
    ben = await github.create_user(login="ben", role="admin", name="Ben Ortiz")
    # @show:start
    repo = await github.create_repo(
        name="web",
        files="./fixtures/web",
        collaborators=[ana, {"user": ben, "permission": "maintain"}],
        labels=["bug", {"name": "agent:fix", "color": "5319e7"}],
        apps=[github.app],
    )
    # @show:end
    _ = repo
