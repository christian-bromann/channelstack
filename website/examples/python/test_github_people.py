from channelstack import GitHubFixture


async def test_the_people_a_github_test_creates(github: GitHubFixture) -> None:
    # @show:start
    ana = await github.create_user(login="ana")
    ben = await github.create_user(login="ben", role="admin", name="Ben Ortiz")
    # @show:end
    _ = (ana, ben)
