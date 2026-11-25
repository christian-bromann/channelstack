from channelstack import GitHubFixture


async def test_pull_requests_and_pushes(github: GitHubFixture) -> None:
    ana = await github.create_user(login="ana")
    repo = await github.create_repo(files="./fixtures/web", collaborators=[ana], apps=[github.app])
    # @show:start
    pr = await ana.open_pull_request(
        {
            "from": "fix-login",
            "title": "Fix login redirect",
            "changes": {"src/login.ts": "export const redirect = '/home';\n"},
        },
        repo=repo,
    )

    commit = await ana.push(
        {"src/app.ts": "export const broken = ;\n"}, repo=repo, branch="fix-login", message="wip"
    )
    # @show:end
    _ = (pr, commit)
